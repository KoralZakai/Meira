"""Backfill: the JSON stores on /data → Postgres (migration 0007).

One-shot, idempotent, and safe to run against a live server: every write is an
upsert keyed the same way the running code keys it, so a second run changes
nothing and a half-finished run can simply be re-run. Nothing is deleted — the
files stay exactly as they are, which is what makes this reversible.

    python migrate_json_to_supabase.py --dry-run     # count what WOULD move
    python migrate_json_to_supabase.py               # move it
    python migrate_json_to_supabase.py --only memories,profiles

Run it with the server's own environment (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
DATA_DIR, and LUMI_DATA_KEY if the stores are encrypted at rest) — on Fly:
`fly ssh console -C "python /app/migrate_json_to_supabase.py --dry-run"`.

Migrations 0007 AND 0008 must be applied first; this script writes rows, it does
not create tables. Nothing here moves `pending_mirror.json` (the retry queue for
"Supabase is down") or `active_session.json` (a 45-minute conversational focus)
— both stay on the volume by design.

Read the counts before trusting it. A store that reports 0 when you expect
hundreds means DATA_DIR is pointing somewhere else — which is exactly the shape
of the bug that made cloud task counts fall 154 → 92 without anyone noticing.

Dependencies: database_service, the JSON stores themselves. Consumed by hand.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import sys

import config
import database_service as db

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("backfill")

STORES = ("identities", "profiles", "memories", "conversations", "places", "travel",
          "reminders", "agents", "sessions", "records", "bugs", "usage")


def _key(*parts: str) -> str:
    """A stable identity for a backfilled row, so re-running upserts over its
    own rows rather than adding a second copy of them."""
    return hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()


def _read(name: str) -> dict:
    """Read one store the way the module that owns it does — through
    secure_store, so an encrypted file is decrypted rather than skipped."""
    import secure_store
    path = os.path.join(config.DATA_DIR, name)
    if not os.path.exists(path):
        return {}
    try:
        return secure_store.read_json(path, {}) or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("! %s unreadable: %s", name, exc)
        return {}


async def _profiles(dry: bool) -> int:
    data = _read("profiles.json")
    moved = 0
    for user_key, profile in data.items():
        if not isinstance(profile, dict):
            continue
        fields = {k: profile.get(k) for k in db.PROFILE_FIELDS if profile.get(k) not in (None, "")}
        if not fields:
            continue
        moved += 1
        if not dry:
            await db.update_profile(user_key, fields)
    return moved


async def _identities(dry: bool) -> int:
    keys = set(_read("profiles.json")) | set(_read("user_memory.json"))
    if not dry:
        for key in keys:
            await db.link_identity(key, phone=key if key.isdigit() else None)
    return len(keys)


async def _memories(dry: bool) -> int:
    """user_memory.json is {phone: {behaviors: [...], preferences: [...], ...}}.

    The `tasks` bucket is deliberately NOT migrated, even though lumi_memories
    has a 'task' kind. Those rows are the OFFLINE MIRROR of the Supabase tasks
    table — user_store's own docstring says it: "a third copy here is how they
    diverge". So a user with 30 mirrored tasks and 3 real insights correctly
    yields 3 rows here, not 33. If that number ever looks alarmingly small,
    this is why.

    Embeddings are NOT computed here: the rows land without vectors and a later
    pass fills them in, so a backfill cannot be blocked (or billed) by an
    embedding model that is still unset in production.
    """
    data = _read("user_memory.json")
    kinds = {"behaviors": "behavior", "preferences": "preference",
             "routines": "routine", "contacts": "contact"}
    moved = 0
    for user_key, memory in data.items():
        if not isinstance(memory, dict):
            continue
        for bucket, kind in kinds.items():
            for item in memory.get(bucket) or []:
                content = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
                if not str(content).strip():
                    continue
                moved += 1
                if not dry:
                    await db.add_memory(user_key, kind, str(content))
    return moved


async def _conversations(dry: bool) -> int:
    data = _read("conversations.json")
    moved = 0
    for user_key, turns in data.items():
        if not isinstance(turns, list):
            continue
        for turn in turns[-40:]:          # the tail is all a prompt ever reads
            if not isinstance(turn, dict):
                continue
            # conversation.py writes `content`; `text` is accepted too so this
            # keeps working if that ever changes. Reading only "text" is why
            # this store silently reported zero rows on the first dry run.
            body = turn.get("content") or turn.get("text")
            if not body:
                continue
            moved += 1
            if not dry:
                # Stable across runs: same file, same turn, same key — so a
                # second run upserts instead of duplicating (migration 0009).
                await db.append_turn(
                    user_key, turn.get("role") or "user", body,
                    dedupe_key=_key("conv", user_key, turn.get("role") or "user", body))
    return moved


async def _places(dry: bool) -> int:
    """known_places.json is {phone: {activity: {address, lat, lng, count, words}}}.

    The activity ("@work", "gym") is the KEY, not a field — an entry has no
    "name" of its own, which is why requiring one found nothing at all.
    """
    data = _read("known_places.json")
    moved = 0
    for user_key, places in data.items():
        if not isinstance(places, dict):
            continue
        for activity, place in places.items():
            if not isinstance(place, dict) or not place.get("address"):
                continue
            moved += 1
            if not dry:
                await db.remember_place(user_key, activity, place.get("address"),
                                        place.get("lat"), place.get("lng"))
    return moved


async def _travel(dry: bool) -> int:
    """travel_prefs.json is {phone: {"places": {place: {mode: count}},
    "categories": {category: {mode: count}}}}.

    Two levels, not one, and the value is a COUNT per mode rather than a mode —
    treating it as {route: mode} matched nothing. The winning mode is the most
    used one, ties broken by name so the answer is stable, which is the same
    rule travel_prefs._winner applies when reading.
    """
    data = _read("travel_prefs.json")
    moved = 0
    for user_key, buckets in data.items():
        if not isinstance(buckets, dict):
            continue
        for bucket in ("places", "categories"):
            for key, counts in (buckets.get(bucket) or {}).items():
                if not isinstance(counts, dict) or not counts:
                    continue
                mode = max(sorted(counts), key=lambda m: counts.get(m, 0))
                moved += 1
                if not dry:
                    await db.remember_travel_mode(
                        user_key, f"{bucket.rstrip('s')}:{key}", str(mode))
    return moved


async def _reminders(dry: bool) -> int:
    """reminders.json is a flat LIST, not a dict keyed by user. Only unsent,
    future rows are worth moving — a fired reminder is history the poller has
    already acted on."""
    import secure_store
    path = os.path.join(config.DATA_DIR, "reminders.json")
    items = secure_store.read_json(path, []) if os.path.exists(path) else []
    moved = 0
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or item.get("sent") or not item.get("key"):
            continue
        moved += 1
        if not dry:
            await db.save_reminder({
                "id": item["key"], "userKey": item.get("phone"),
                "text": item.get("text") or "", "fireAt": item.get("fire_at"),
                "kind": "outgoing" if item.get("to_phone") else "reminder",
                "payload": {k: v for k, v in item.items()
                            if k not in ("key", "phone", "text", "fire_at", "sent")},
                "sent": False,
            })
    return moved


async def _agents(dry: bool) -> int:
    import secure_store
    path = os.path.join(config.DATA_DIR, "agents.json")
    items = secure_store.read_json(path, []) if os.path.exists(path) else []
    moved = 0
    for agent in items if isinstance(items, list) else []:
        if not isinstance(agent, dict) or not agent.get("id"):
            continue
        moved += 1
        if not dry:
            await db.save_agent(agent.get("phone") or "", agent)
    return moved


async def _sessions(dry: bool) -> int:
    data = _read("sessions.json")
    moved = 0
    for user_key, channels in data.items():
        if not isinstance(channels, dict):
            continue
        for channel, slot in channels.items():
            moved += 1
            if not dry:
                await db.record_session(
                    user_key, channel, slot or {},
                    dedupe_key=_key("sess", user_key, channel,
                                    str((slot or {}).get("id", ""))))
    return moved


async def _records(dry: bool) -> int:
    """user_store.json — the push token above all. Its absence is why the
    reminder loop could never reach the phone."""
    data = _read("user_store.json").get("users") or {}
    moved = 0
    for user_key, user in data.items():
        if not isinstance(user, dict):
            continue
        moved += 1
        if not dry:
            await db.save_user_record(user_key, {
                "phone": user_key, "name": user.get("name"),
                "language": user.get("language"), "mbtiType": user.get("mbti_type"),
                "pushToken": user.get("push_token"),
                "signals": user.get("signals") or [],
            })
    return moved


async def _bugs(dry: bool) -> int:
    data = _read("bug_reports.json")
    moved = 0
    for bug_id, bug in data.items():
        if not isinstance(bug, dict):
            continue
        moved += 1
        if not dry:
            await db.save_bug_report({**bug, "id": bug_id,
                                      "text": bug.get("description") or ""})
    return moved


async def _usage(dry: bool) -> int:
    data = _read("llm_usage.json")
    moved = 0
    for day, sources in data.items():
        if not isinstance(sources, dict):
            continue
        for source, row in sources.items():
            if not isinstance(row, dict):
                continue
            moved += 1
            if not dry:
                await db.record_usage(day, source, row.get("in", 0),
                                      row.get("out", 0), row.get("calls", 0))
    return moved


HANDLERS = {"identities": _identities, "profiles": _profiles, "memories": _memories,
            "conversations": _conversations, "places": _places, "travel": _travel,
            "reminders": _reminders, "agents": _agents, "sessions": _sessions,
            "records": _records, "bugs": _bugs, "usage": _usage}


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="count what would move, write nothing")
    parser.add_argument("--only", default="", help="comma-separated: " + ",".join(STORES))
    args = parser.parse_args()

    if not db.enabled():
        logger.error("x SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — nothing to write to.")
        return 2

    wanted = [s.strip() for s in args.only.split(",") if s.strip()] or list(STORES)
    logger.info("· DATA_DIR = %s", os.path.abspath(config.DATA_DIR))
    logger.info("· %s", "DRY RUN — nothing will be written" if args.dry_run else "writing")

    total = 0
    for store in wanted:
        handler = HANDLERS.get(store)
        if not handler:
            logger.warning("! unknown store %r, skipping", store)
            continue
        count = await handler(args.dry_run)
        total += count
        logger.info("  %-14s %5d rows", store, count)

    logger.info("· %d rows %s", total, "would move" if args.dry_run else "moved")
    if not total:
        logger.warning("! nothing found — check DATA_DIR points at the /data volume")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
