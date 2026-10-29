"""history_store — her opt-in history log (lumi_history), and the reads behind it.

Nothing is collected without her yes (Koral, 20.10: "collect data if the user
wants to, permission is needed"). `profile.historyOptIn` is the switch; turning
it off deletes the log. Kept 90 days, pruned on every write.

What is logged is only what the tasks table loses (migration 0015): every move
(the table keeps the last), real trip minutes, focus-session minutes, and the
completed/missed outcome with its day. Each row carries the task's text,
sealed (field_crypto), and its embedding for the open questions.

Silent-state rule 1, everywhere: a read that failed returns (None, reason),
never [] — "you didn't work out" and "I couldn't look" are different answers.
"""
from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from typing import Optional

import httpx

import database_service
import history_stats
import dedup_service
import identity_keys
import supabase_tasks
import user_profile
from tz import today_il

logger = logging.getLogger(__name__)

TABLE = "lumi_history"
RETENTION_DAYS = 90
KINDS = ("moved", "completed", "missed", "trip", "study")
MAX_BATCH = 200


def key_of(raw: object) -> str:
    """The brain key every history row lives under."""
    return identity_keys.canonical(raw)


# ─── consent ────────────────────────────────────────────────────────────────

def opted_in(key: str) -> bool:
    return bool(user_profile.get_profile(key).get("historyOptIn"))


def targets(key: str) -> dict:
    t = user_profile.get_profile(key).get("weeklyTargets")
    return t if isinstance(t, dict) else {}


def set_target(key: str, metric: str, value: int) -> dict:
    t = {**targets(key)}
    if value and value > 0:
        t[metric] = int(value)
    else:
        t.pop(metric, None)
    user_profile.update_profile(key, weeklyTargets=t)
    return t


async def set_consent(key: str, on: bool) -> dict:
    """Her yes or no. A no deletes what was collected — the switch is also the
    'forget it' button. Returns {ok, optedIn, deleted?, backfilled?, reason?}."""
    key = key_of(key)
    if on:
        user_profile.update_profile(key, historyOptIn=True,
                                    historyOptInAt=int(time.time() * 1000))
        back = await backfill(key)
        return {"ok": True, "optedIn": True, "backfilled": back.get("stored", 0),
                **({"reason": back["reason"]} if back.get("reason") else {})}
    user_profile.update_profile(key, historyOptIn=False)
    deleted = await delete_all(key)
    return {"ok": deleted, "optedIn": False, "deleted": deleted,
            **({} if deleted else {"reason": "delete_failed"})}


# ─── writing ────────────────────────────────────────────────────────────────

def _clean(ev: dict) -> Optional[dict]:
    kind = str(ev.get("kind") or "")
    day = str(ev.get("day") or "")[:10]
    if kind not in KINDS or len(day) != 10:
        return None
    task_id = str(ev.get("taskId") or "")[:80] or None
    minutes = ev.get("minutes")
    minutes = int(minutes) if isinstance(minutes, (int, float)) and 0 <= minutes < 24 * 60 else None
    data = ev.get("data") if isinstance(ev.get("data"), dict) else {}
    dedup = str(ev.get("dedupKey") or "")[:200] or \
        f"{kind}:{task_id or ''}:{day}:{data.get('from') or ''}"
    return {"kind": kind, "taskId": task_id, "category": str(ev.get("category") or "")[:30] or None,
            "day": day, "minutes": minutes, "text": str(ev.get("text") or "")[:300] or None,
            "data": {k: data[k] for k in list(data)[:8]}, "dedupKey": dedup}


async def record(key: str, events: list) -> dict:
    """Store events for her. {ok, stored, streaks:[{taskId, text, moves}]} or
    {ok: False, reason}. `streaks` = tasks this batch moved for the 3rd+ time,
    so the caller can say so at once."""
    key = key_of(key)
    if not opted_in(key):
        return {"ok": False, "reason": "not_opted_in", "stored": 0}
    if not database_service.enabled():
        return {"ok": False, "reason": "store_unavailable", "stored": 0}
    cutoff = (today_il() - timedelta(days=RETENTION_DAYS)).isoformat()
    rows = [r for r in (_clean(e) for e in (events or [])[:MAX_BATCH] if isinstance(e, dict)) if r]
    rows = [r for r in rows if r["day"] >= cutoff]
    if not rows:
        return {"ok": True, "stored": 0, "streaks": []}
    texts = list(dict.fromkeys(r["text"] for r in rows if r["text"]))
    vectors = None
    try:
        vectors = await dedup_service.embed_texts(texts) if texts else None
    except Exception as exc:  # noqa: BLE001 — a row without a vector still counts
        logger.warning("history: embedding failed: %s", exc)
    by_text = dict(zip(texts, vectors)) if vectors else {}
    out = []
    for r in rows:
        row = {**r, "userKey": key}
        if r["text"] in by_text:
            row["embedding"] = by_text[r["text"]]
        out.append(row)
    ok = await database_service._upsert(TABLE, out, on_conflict="userKey,dedupKey")
    if not ok:
        return {"ok": False, "reason": "write_failed", "stored": 0}
    await prune(key)
    streaks = await _streaks(key, {r["taskId"] for r in rows if r["kind"] == "moved" and r["taskId"]})
    return {"ok": True, "stored": len(out), "streaks": streaks}


async def _streaks(key: str, task_ids: set) -> list:
    if not task_ids:
        return []
    rows, _ = await events(key, (today_il() - timedelta(days=RETENTION_DAYS)).isoformat(),
                           "9999-12-31", kinds=("moved",))
    counts: dict[str, dict] = {}
    for r in rows or []:
        tid = str(r.get("taskId") or "")
        if tid in task_ids:
            c = counts.setdefault(tid, {"taskId": tid, "text": r.get("text"), "moves": 0})
            c["moves"] += 1
    return [c for c in counts.values() if c["moves"] >= 3]


async def prune(key: str) -> bool:
    cutoff = (today_il() - timedelta(days=RETENTION_DAYS)).isoformat()
    return await database_service._delete(TABLE, {"userKey": f"eq.{key}", "day": f"lt.{cutoff}"})


async def delete_all(key: str) -> bool:
    key = key_of(key)
    oks = [await database_service._delete(TABLE, {"userKey": f"eq.{k}"})
           for k in identity_keys.keys_of(key) or [key]]
    return all(oks)


# ─── reading ────────────────────────────────────────────────────────────────

async def events(key: str, date_from: str, date_to: str,
                 kinds: tuple = KINDS) -> tuple[Optional[list], Optional[str]]:
    """Her events in [from, to]. (rows, None) or (None, reason)."""
    if not database_service.enabled():
        return None, "store_unavailable"
    rows = await database_service._get(TABLE, {
        "select": "kind,taskId,category,day,minutes,text,data",
        "userKey": f"eq.{key_of(key)}",
        "day": [f"gte.{date_from}", f"lte.{date_to}"],
        "kind": f"in.({','.join(kinds)})",
        "order": "day.asc",
        "limit": "5000",
    })
    if rows is None:
        return None, "read_failed"
    return rows, None


async def tasks(key: str, date_from: str, date_to: str) -> tuple[Optional[list], Optional[str]]:
    """Her task rows with the columns the stats need (status, actual minutes,
    movedFromDate, location). (rows, None) or (None, reason) — the shared
    tasks_for_user returns [] on failure, which would read as an empty week."""
    uid = await supabase_tasks.user_id_for_phone(key_of(key))
    if not uid:
        return None, "no_account"
    if not supabase_tasks._enabled():
        return None, "store_unavailable"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                supabase_tasks._rest("tasks"), headers=supabase_tasks._headers(),
                params={"select": "id,text,category,date,status,durationMinutes,fixedTime,scheduledTime,"
                                  "actualDurationMinutes,movedFromDate,completedAt,location"
                                  + (",sealed" if supabase_tasks.sealing_on() else ""),
                        "userId": f"eq.{uid}",
                        "date": [f"gte.{date_from}", f"lte.{date_to}"],
                        "limit": "5000"})
        if r.status_code != 200:
            logger.warning("history tasks read rejected (%s): %s", r.status_code,
                           supabase_tasks._pg_reason(r.text))
            return None, f"http_{r.status_code}"
        rows = [supabase_tasks.open_task_row(uid, raw) for raw in r.json()]
        return [x for x in rows if not x.get("_unreadable")], None
    except Exception as exc:  # noqa: BLE001
        logger.warning("history tasks read failed: %s", exc)
        return None, "unreachable"


async def search(key: str, query: str, since: str, limit: int = 40) -> tuple[Optional[list], Optional[str]]:
    """The events nearest a free-text question ("the thesis"). (rows, None) or (None, reason)."""
    vectors = await dedup_service.embed_texts([query])
    if not vectors:
        return None, "embeddings_unavailable"
    if not database_service.enabled():
        return None, "store_unavailable"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                database_service._rest("rpc/lumi_match_history"), headers=database_service._headers(),
                json={"p_user_key": key_of(key), "p_embedding": vectors[0], "p_since": since,
                      "p_limit": limit, "p_min_similarity": 0.35})
        if r.status_code != 200:
            logger.warning("history search failed (HTTP %s): %s", r.status_code, r.text[:200])
            return None, f"http_{r.status_code}"
        import field_crypto
        return [field_crypto.open_row(TABLE, {**row, "userKey": key_of(key)}) for row in r.json()], None
    except Exception as exc:  # noqa: BLE001
        logger.warning("history search failed: %s", exc)
        return None, "unreachable"


# ─── the first yes ──────────────────────────────────────────────────────────

def events_from_tasks(rows: list) -> list:
    """What the tasks table can already tell about the last 90 days: outcomes,
    the LAST move of each task, and planned trip minutes of places she went."""
    out = []
    for t in rows:
        tid, day, text, cat = str(t.get("id") or ""), str(t.get("date") or "")[:10], t.get("text"), t.get("category")
        if not tid or len(day) != 10:
            continue
        base = {"taskId": tid, "text": text, "category": cat}
        if t.get("status") == "complete":
            out.append({**base, "kind": "completed", "day": day,
                        "minutes": t.get("actualDurationMinutes") or t.get("durationMinutes"),
                        "dedupKey": f"completed:{tid}:{day}"})
        elif t.get("status") == "missed":
            out.append({**base, "kind": "missed", "day": day, "dedupKey": f"missed:{tid}:{day}"})
        moved_from = str(t.get("movedFromDate") or "")[:10]
        if len(moved_from) == 10 and moved_from != day:
            out.append({**base, "kind": "moved", "day": moved_from,
                        "data": {"from": moved_from, "to": day},
                        "dedupKey": f"moved:{tid}:{moved_from}:{day}"})
    return out


async def backfill(key: str) -> dict:
    start = (today_il() - timedelta(days=RETENTION_DAYS)).isoformat()
    rows, reason = await tasks(key, start, today_il().isoformat())
    if rows is None:
        return {"ok": False, "stored": 0, "reason": reason}
    return await record(key, events_from_tasks(rows))


# ─── the report ─────────────────────────────────────────────────────────────

async def report(key: str, period_expr: str = "this week") -> dict:
    """This period vs the one before, her targets and the ONE firm line.
    {ok: True, period, current, previous, targets, line} or {ok: False, reason}."""
    key = key_of(key)
    today = today_il()
    p = history_stats.period(period_expr, today)
    rows, reason = await tasks(key, p["prev_from"], p["to"])
    if rows is None:
        return {"ok": False, "optedIn": True, "reason": reason}
    evs, reason = await events(key, p["prev_from"], p["to"])
    if evs is None:
        return {"ok": False, "optedIn": True, "reason": reason}
    rep = history_stats.week_report(rows, evs, today, period_expr)
    he = (user_profile.get_profile(key).get("language") or "he") == "he"
    t = targets(key)
    return {"ok": True, "optedIn": True, **rep, "targets": t,
            "line": history_stats.coach_line(rep, t, he)}
