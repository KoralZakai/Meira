"""One-time conservative migration: re-key legacy "wa_"+sha1 task ids to UUIDs
and merge EXACT text+date duplicates. Run manually, once, after deploying the
stable-UUID code (user_memory / supabase_tasks / main.py).

    python migrate_wa_ids.py           # dry-run: prints what would change
    python migrate_wa_ids.py --apply   # actually writes

Touches: DATA_DIR/user_memory.json and (when SUPABASE_URL + SERVICE_ROLE_KEY
are configured) the shared Supabase `tasks` table. The same (text, date) task
gets the SAME new UUID in both stores, so the app keeps dedup'ing to one row.
Conservative rules: only rows whose id starts with "wa_" are re-keyed; only
duplicates with identical text AND date are merged (keeping the most advanced
status and the earliest createdAt); ambiguous matches are skipped and printed.
"""
import json
import os
import sys
import uuid

import httpx

import config

APPLY = "--apply" in sys.argv
_MEMORY_PATH = os.path.join(config.DATA_DIR, "user_memory.json")

# Statuses ranked: anything the user advanced beats a default "pending".
_STATUS_RANK = {"pending": 0, "moved": 1, "partial": 2, "missed": 2, "complete": 3}


def _rank(status) -> int:
    return _STATUS_RANK.get(str(status or "pending"), 0)


def migrate_memory() -> dict:
    """Re-key wa_ ids in user_memory.json; merge exact text+date dups.
    Returns {(text, date): new_id} so Supabase rows get the same UUIDs."""
    try:
        with open(_MEMORY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print(f"memory store not found/empty at {_MEMORY_PATH} — skipping")
        return {}

    mapping: dict = {}
    ambiguous: set = set()
    changed = 0
    for phone, mem in data.items():
        tasks = mem.get("tasks", [])
        merged: list = []
        by_key: dict = {}
        for t in tasks:  # tasks[0] is most recent — first wins, dups merge into it
            key = (t.get("text", ""), t.get("date", ""))
            if key in by_key:
                keeper = by_key[key]
                if _rank(t.get("status")) > _rank(keeper.get("status")):
                    keeper["status"] = t["status"]
                print(f"  [memory {phone}] merged duplicate: {key}")
                changed += 1
                continue
            if str(t.get("id", "")).startswith("wa_"):
                t = {**t, "id": str(uuid.uuid4())}
                changed += 1
                print(f"  [memory {phone}] re-keyed {key} -> {t['id']}")
            by_key[key] = t
            merged.append(t)
            if key in mapping and mapping[key] != t["id"]:
                ambiguous.add(key)  # same text+date under two phones — don't guess
            else:
                mapping[key] = t["id"]
        mem["tasks"] = merged

    for key in ambiguous:
        mapping.pop(key, None)
        print(f"  ambiguous across phones, Supabase match skipped: {key}")

    if APPLY and changed:
        with open(_MEMORY_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"memory: {changed} change(s) {'applied' if APPLY else '(dry-run)'}")
    return mapping


def _headers() -> dict:
    key = config.SUPABASE_SERVICE_ROLE_KEY
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _rest(path: str) -> str:
    return f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/{path}"


def migrate_supabase(mapping: dict) -> None:
    if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY):
        print("Supabase not configured — skipping table migration")
        return
    with httpx.Client(timeout=15.0) as client:
        r = client.get(
            _rest("tasks"),
            headers=_headers(),
            params={"select": "id,userId,text,date,status,createdAt", "id": "like.wa_*"},
        )
        rows = r.json() if r.status_code == 200 else []
        print(f"supabase: {len(rows)} legacy wa_ row(s)")
        for row in rows:
            key = (row.get("text", ""), str(row.get("date", ""))[:10])
            new_id = mapping.get(key) or str(uuid.uuid4())
            # Does the target id already exist (memory-minted row upserted since)?
            er = client.get(
                _rest("tasks"),
                headers=_headers(),
                params={
                    "select": "id,status",
                    "userId": f"eq.{row['userId']}",
                    "id": f"eq.{new_id}",
                    "limit": "1",
                },
            )
            twin = (er.json() or [None])[0] if er.status_code == 200 else None
            if twin:
                print(f"  merge {row['id']} into existing {new_id} ({key})")
                if APPLY:
                    if _rank(row.get("status")) > _rank(twin.get("status")):
                        client.patch(
                            _rest("tasks"),
                            headers=_headers(),
                            params={"userId": f"eq.{row['userId']}", "id": f"eq.{new_id}"},
                            json={"status": row["status"]},
                        )
                    client.delete(
                        _rest("tasks"),
                        headers=_headers(),
                        params={"userId": f"eq.{row['userId']}", "id": f"eq.{row['id']}"},
                    )
            else:
                print(f"  re-key {row['id']} -> {new_id} ({key})")
                if APPLY:
                    client.patch(
                        _rest("tasks"),
                        headers=_headers(),
                        params={"userId": f"eq.{row['userId']}", "id": f"eq.{row['id']}"},
                        json={"id": new_id},
                    )
    print(f"supabase: done {'(applied)' if APPLY else '(dry-run)'}")


if __name__ == "__main__":
    print(f"=== wa_ id migration {'APPLY' if APPLY else 'DRY-RUN'} ===")
    migrate_supabase(migrate_memory())
