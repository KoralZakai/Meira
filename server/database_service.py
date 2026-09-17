"""database_service — the server's state, in Postgres, through ONE door.

Everything the brain remembers used to live in flat JSON on the Fly.io /data
volume: ~15 files, no locking, no transactions, no backups, one machine. Two
requests writing the same user in the same second raced; a restart on a fresh
volume was a user with amnesia; and "memory" in the prompt meant dumping the
whole file in every turn, which is why a long-standing user costs more per
message than a new one.

This module owns the reads and writes for that state against Supabase
(migration 0007). Every function follows the same contract as supabase_tasks,
because it is the contract that has survived contact with production:

    not configured, unreachable, or an error  →  None / [] / False,
    never an exception into a request path.

**Dual-write while migrating.** Async callers pass `mirror=` — a zero-argument
callable that writes the same fact to the existing JSON store — and both writes
happen. Sync callers (the JSON stores themselves, which are not async and are
called from inside request handlers) keep writing their file first and schedule
the Postgres write through `shadow_write`, so the slower, newer path can never
delay or fail the one that works today. Either way a rollback is "stop calling
this module", not a restore, and reads prefer Postgres but fall back to the
mirror — a user whose backfill has not run yet still sees their data.

**What stays on disk, deliberately.** `pending_mirror.json` is the retry queue
for writes that failed *because* Supabase was unreachable: a queue for "the
database is down" cannot live in the database.

Dependencies: httpx, config (supabase_tasks is imported lazily inside
link_identity — it imports user_memory, which imports this). Consumed by
user_memory, user_profile, conversation and the backfill script.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

import httpx

import config

logger = logging.getLogger("lumi.db")

_TIMEOUT = 8.0


def enabled() -> bool:
    """False means every function here degrades to the JSON mirror."""
    return bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY)


def _headers(prefer: Optional[str] = None) -> dict:
    key = config.SUPABASE_SERVICE_ROLE_KEY
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _rest(path: str) -> str:
    return f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/{path}"


def shadow_write(coro) -> None:
    """Schedule a Postgres write from SYNC code without waiting for it.

    The JSON stores are synchronous and are called from inside request handlers.
    Blocking one of them on a network round-trip would make every reply slower
    to gain a row nothing reads yet, and a Supabase hiccup would surface as a
    failed save of something that had in fact been saved. So the file write
    stays authoritative and this shadows it. With no running loop (scripts,
    tests) the coroutine is closed rather than left pending, which otherwise
    logs a warning per call and confuses the next real failure.
    """
    try:
        import asyncio
        loop = asyncio.get_running_loop()
    except RuntimeError:
        coro.close()
        return
    task = loop.create_task(coro)
    task.add_done_callback(lambda t: t.exception() and
                           logger.warning("shadow write failed: %s", t.exception()))


def _run_mirror(mirror: Optional[Callable[[], Any]]) -> None:
    """The JSON write that still happens, whatever Postgres did. A mirror that
    raises must never take the request with it — it is the fallback, not the
    point."""
    if mirror is None:
        return
    try:
        mirror()
    except Exception as exc:  # noqa: BLE001
        logger.warning("json mirror write failed: %s", exc)


async def _get(path: str, params: dict) -> Optional[list]:
    if not enabled():
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.get(_rest(path), headers=_headers(), params=params)
        if response.status_code != 200:
            logger.warning("%s read failed (HTTP %s): %s", path, response.status_code,
                           response.text[:200])
            return None
        return response.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s read failed: %s", path, exc)
        return None


async def _upsert(path: str, rows: list, on_conflict: Optional[str] = None) -> bool:
    if not enabled() or not rows:
        return False
    params = {"on_conflict": on_conflict} if on_conflict else {}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                _rest(path), headers=_headers("resolution=merge-duplicates,return=minimal"),
                params=params, json=rows)
        if response.status_code >= 300:
            logger.warning("%s write failed (HTTP %s): %s", path, response.status_code,
                           response.text[:200])
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s write failed: %s", path, exc)
        return False


async def _delete(path: str, params: dict) -> bool:
    if not enabled():
        return False
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.delete(_rest(path), headers=_headers("return=minimal"),
                                           params=params)
        return response.status_code < 300
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s delete failed: %s", path, exc)
        return False


# ─── identity ───────────────────────────────────────────────────────────────

async def link_identity(user_key: str, phone: Optional[str] = None) -> bool:
    """Record the key → (auth user, phone) mapping every other table hangs off.

    Called on the way through rather than in a migration, because the mapping is
    only knowable when someone actually arrives: the key is a phone until the
    account is linked, and an auth id afterwards.
    """
    # Imported here, not at module scope: supabase_tasks imports user_memory,
    # which imports this module to shadow its writes. A top-level import closes
    # that circle and breaks every module in it at collection time.
    import supabase_tasks

    user_id = None
    try:
        user_id = await supabase_tasks.user_id_for_phone(phone or user_key)
    except Exception:  # noqa: BLE001 — an unmapped user is still a user
        pass
    row = {"userKey": str(user_key), "phone": phone or None}
    if user_id:
        row["userId"] = user_id
    return await _upsert("lumi_identities", [row], on_conflict="userKey")


# ─── distilled memory ───────────────────────────────────────────────────────

MEMORY_KINDS = ("behavior", "preference", "routine", "contact", "task")


async def add_memory(user_key: str, kind: str, content: str,
                     meta: Optional[dict] = None,
                     embedding: Optional[list] = None,
                     mirror: Optional[Callable[[], Any]] = None) -> bool:
    """Save one distilled fact. Duplicates collapse on (userKey, kind, content)."""
    content = (content or "").strip()
    if not content or kind not in MEMORY_KINDS:
        _run_mirror(mirror)
        return False
    row = {"userKey": str(user_key), "kind": kind, "content": content,
           "meta": meta or {}}
    if embedding:
        row["embedding"] = embedding
    ok = await _upsert("lumi_memories", [row])
    _run_mirror(mirror)
    return ok


async def get_memories(user_key: str, kind: Optional[str] = None,
                       limit: int = 200) -> Optional[list]:
    """Every remembered fact for this user. None means "ask the JSON mirror"."""
    params = {"select": "id,kind,content,meta,createdAt",
              "userKey": f"eq.{user_key}", "limit": str(limit),
              "order": "createdAt.desc"}
    if kind:
        params["kind"] = f"eq.{kind}"
    return await _get("lumi_memories", params)


async def search_memories(user_key: str, embedding: list, limit: int = 8,
                          min_similarity: float = 0.2) -> Optional[list]:
    """The RAG call: the facts most like this turn, instead of all of them.

    This is the point of the pgvector column. Stuffing the whole memory blob
    into every prompt grows without bound and prices a loyal user out of their
    own assistant; retrieving eight relevant lines does not.

    Never merge two memories below cosine 0.912 — that threshold was measured,
    not guessed, and below it distinct facts collapse into one.
    """
    if not enabled() or not embedding:
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                _rest("rpc/lumi_match_memories"), headers=_headers(),
                json={"p_user_key": str(user_key), "p_embedding": embedding,
                      "p_limit": limit, "p_min_similarity": min_similarity})
        if response.status_code != 200:
            logger.warning("memory search failed (HTTP %s): %s", response.status_code,
                           response.text[:200])
            return None
        return response.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("memory search failed: %s", exc)
        return None


# ─── profile ────────────────────────────────────────────────────────────────

PROFILE_FIELDS = ("name", "homeAddress", "workAddress", "transportType",
                  "morningRoutineMinutes", "routineVerified", "hobbies",
                  "routinesNotes", "mbtiType", "onboarded")


async def get_profile(user_key: str) -> Optional[dict]:
    rows = await _get("lumi_profiles", {"select": "*", "userKey": f"eq.{user_key}",
                                        "limit": "1"})
    return rows[0] if rows else None


async def update_profile(user_key: str, fields: dict,
                         mirror: Optional[Callable[[], Any]] = None) -> bool:
    """Merge non-empty fields into the server's profile row.

    A None never erases what is already known: onboarding answers arrive one at
    a time, and an extractor that returns null for the four fields it was not
    asked about must not wipe them.
    """
    row = {k: v for k, v in (fields or {}).items()
           if k in PROFILE_FIELDS and v not in (None, "")}
    ok = False
    if row:
        row["userKey"] = str(user_key)
        ok = await _upsert("lumi_profiles", [row], on_conflict="userKey")
    _run_mirror(mirror)
    return ok


# ─── conversation ───────────────────────────────────────────────────────────

async def append_turn(user_key: str, role: str, text: str,
                      channel: str = "whatsapp",
                      dedupe_key: Optional[str] = None,
                      mirror: Optional[Callable[[], Any]] = None) -> bool:
    """One conversation turn.

    `dedupe_key` is for the BACKFILL only, so re-running it upserts over its own
    rows instead of duplicating them (migration 0009). Live appends leave it
    None — a person may genuinely say the same sentence twice, and both turns
    are real. Nulls do not collide in a Postgres unique index, which is what
    makes one column serve both.
    """
    row = {
        "userKey": str(user_key),
        "role": "user" if role in ("user", "human") else "assistant",
        "text": str(text or "")[:4000],
        "channel": channel,
    }
    if dedupe_key:
        row["dedupeKey"] = dedupe_key
    ok = await _upsert("lumi_conversations", [row],
                       on_conflict="dedupeKey" if dedupe_key else None)
    _run_mirror(mirror)
    return ok


async def recent_turns(user_key: str, limit: int = 10) -> Optional[list]:
    """Newest-last, the order a prompt wants them in."""
    rows = await _get("lumi_conversations",
                      {"select": "role,text,createdAt", "userKey": f"eq.{user_key}",
                       "order": "createdAt.desc", "limit": str(limit)})
    return list(reversed(rows)) if rows is not None else None


# ─── reminders ──────────────────────────────────────────────────────────────

async def save_reminder(reminder: dict, mirror: Optional[Callable[[], Any]] = None) -> bool:
    row = {k: v for k, v in reminder.items()
           if k in ("id", "userKey", "text", "fireAt", "kind", "taskId", "payload", "sent")}
    ok = await _upsert("lumi_reminders", [row], on_conflict="id") if row.get("id") else False
    _run_mirror(mirror)
    return ok


async def due_reminders(now_iso: str, limit: int = 100) -> Optional[list]:
    """What the poller should fire: unsent and past due."""
    return await _get("lumi_reminders",
                      {"select": "*", "sent": "eq.false", "fireAt": f"lte.{now_iso}",
                       "order": "fireAt.asc", "limit": str(limit)})


async def mark_reminder_sent(reminder_id: str) -> bool:
    return await _upsert("lumi_reminders", [{"id": reminder_id, "sent": True}],
                         on_conflict="id")


# ─── places and travel ──────────────────────────────────────────────────────

async def remember_place(user_key: str, name: str, address: Optional[str] = None,
                         lat: Optional[float] = None, lng: Optional[float] = None,
                         mirror: Optional[Callable[[], Any]] = None) -> bool:
    row = {"userKey": str(user_key), "name": name, "address": address,
           "lat": lat, "lng": lng}
    ok = await _upsert("lumi_known_places", [row])
    _run_mirror(mirror)
    return ok


async def get_places(user_key: str) -> Optional[list]:
    return await _get("lumi_known_places",
                      {"select": "*", "userKey": f"eq.{user_key}",
                       "order": "uses.desc", "limit": "100"})


async def remember_travel_mode(user_key: str, route: str, mode: str,
                               mirror: Optional[Callable[[], Any]] = None) -> bool:
    ok = await _upsert("lumi_travel_prefs",
                       [{"userKey": str(user_key), "route": route, "mode": mode}],
                       on_conflict="userKey,route")
    _run_mirror(mirror)
    return ok


async def get_travel_prefs(user_key: str) -> Optional[list]:
    return await _get("lumi_travel_prefs",
                      {"select": "*", "userKey": f"eq.{user_key}", "limit": "200"})


# ─── user-created agents ────────────────────────────────────────────────────

AGENT_FIELDS = ("id", "name", "emoji", "soul", "enabled", "time")


async def save_agent(user_key: str, agent: dict,
                     mirror: Optional[Callable[[], Any]] = None) -> bool:
    """Create or update one agent row. The scheduling shape the file keeps
    ({"schedule": {"days": [...], "time": "08:00"}}) is flattened into the
    table's `days` / `time` columns, and everything else — template, next_run,
    run_count — rides along in `config` rather than earning a column each."""
    if not agent.get("id"):
        _run_mirror(mirror)
        return False
    schedule = agent.get("schedule") or {}
    row = {k: agent.get(k) for k in AGENT_FIELDS if agent.get(k) is not None}
    row.update({
        "userKey": str(user_key),
        "days": schedule.get("days") or [],
        "time": schedule.get("time"),
        "config": {k: v for k, v in agent.items()
                   if k not in AGENT_FIELDS and k not in ("schedule", "phone")},
    })
    ok = await _upsert("lumi_agents", [row], on_conflict="id")
    _run_mirror(mirror)
    return ok


async def delete_agent(agent_id: str, mirror: Optional[Callable[[], Any]] = None) -> bool:
    ok = await _delete("lumi_agents", {"id": f"eq.{agent_id}"})
    _run_mirror(mirror)
    return ok


async def get_agents(user_key: str) -> Optional[list]:
    return await _get("lumi_agents", {"select": "*", "userKey": f"eq.{user_key}",
                                      "limit": "100"})


# ─── provenance ─────────────────────────────────────────────────────────────

async def record_session(user_key: str, kind: str, payload: dict,
                         dedupe_key: Optional[str] = None,
                         mirror: Optional[Callable[[], Any]] = None) -> bool:
    """Provenance for one turn. `dedupe_key` behaves as in append_turn: set by
    the backfill so a re-run cannot duplicate, left None by live writes."""
    row = {"userKey": str(user_key), "kind": kind, "payload": payload or {}}
    if dedupe_key:
        row["dedupeKey"] = dedupe_key
    ok = await _upsert("lumi_sessions", [row],
                       on_conflict="dedupeKey" if dedupe_key else None)
    _run_mirror(mirror)
    return ok


# ─── the server's own small records ─────────────────────────────────────────

USER_RECORD_FIELDS = ("phone", "name", "language", "mbtiType", "pushToken", "signals")


async def save_user_record(user_key: str, fields: dict,
                           mirror: Optional[Callable[[], Any]] = None) -> bool:
    """Push token, language, MBTI — the fields Supabase's own tables have no
    column for. This is the row whose absence meant a push token had nowhere to
    land, so the reminder loop could never reach the phone."""
    row = {k: v for k, v in (fields or {}).items()
           if k in USER_RECORD_FIELDS and v not in (None, "")}
    ok = False
    if row:
        row["userKey"] = str(user_key)
        ok = await _upsert("lumi_user_records", [row], on_conflict="userKey")
    _run_mirror(mirror)
    return ok


async def get_user_record(user_key: str) -> Optional[dict]:
    rows = await _get("lumi_user_records", {"select": "*", "userKey": f"eq.{user_key}",
                                            "limit": "1"})
    return rows[0] if rows else None


# ─── spend, bugs, and what the judge did to the prompt ──────────────────────

async def record_usage(day: str, source: str, tokens_in: int, tokens_out: int,
                       calls: int, mirror: Optional[Callable[[], Any]] = None) -> bool:
    """The running total for one day+source. Sent as the whole figure rather
    than an increment: the JSON file already holds the accumulated number, and
    an upsert of a total is idempotent where an increment would double-count
    every retry."""
    ok = await _upsert("lumi_llm_usage", [{
        "day": day, "source": source, "tokensIn": int(tokens_in),
        "tokensOut": int(tokens_out), "calls": int(calls),
    }], on_conflict="day,source")
    _run_mirror(mirror)
    return ok


async def save_bug_report(bug: dict, mirror: Optional[Callable[[], Any]] = None) -> bool:
    if not bug.get("id"):
        _run_mirror(mirror)
        return False
    row = {
        "id": str(bug["id"]),
        "userKey": bug.get("phone") or bug.get("userKey"),
        "text": str(bug.get("text") or ""),
        "status": bug.get("status") or "open",
        "fields": {k: v for k, v in bug.items()
                   if k not in ("id", "phone", "userKey", "text", "status")},
    }
    ok = await _upsert("lumi_bug_reports", [row], on_conflict="id")
    _run_mirror(mirror)
    return ok


async def record_judgement(user_key: Optional[str], verdict: dict,
                           mirror: Optional[Callable[[], Any]] = None) -> bool:
    ok = await _upsert("lumi_judge_log", [{"userKey": user_key, "verdict": verdict or {}}])
    _run_mirror(mirror)
    return ok
