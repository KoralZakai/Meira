"""account_deletion — erase one person, from everywhere, for good.

Google Play has required since 2024 that any app which lets you create an
account also lets you delete it: a route inside the app AND a public web
request that needs no install. Lumi had neither — only a sign-out, which
leaves every row exactly where it was. That is a listing blocker, and it is
also the promise the privacy policy makes.

The hard part is not deleting; it is deleting EVERYTHING. This user's data is
spread across three homes that grew at different times:

  the JSON stores on /data   ten files, each a dict keyed by the user key —
                             tasks, conversations, agents, reminders, places,
                             travel habits, profile, session, provenance, bugs
  Supabase, keyed by userId  the app's own tables (tasks, goals, settings…)
  Supabase, keyed by userKey the server's lumi_* tables, joined through
                             lumi_identities

Miss one and the account is not deleted, it is hidden — which is worse than
not offering deletion at all, because now it is a false promise in a policy.

Three rules this module follows:

  BEST EFFORT, FULLY REPORTED. One store failing must not abort the rest: a
  half-deleted account that reports success is the failure mode to avoid, so
  every store is attempted and the result says exactly what happened to each.
  The caller decides whether "8 of 10" is good enough to tell the user yes.

  IDEMPOTENT. Deleting an account that is already gone is a no-op that
  succeeds. Users retry; so do networks.

  THE AUTH USER GOES LAST. While it exists the person can still sign in and
  retry. Delete it first and a failure halfway through strands rows that
  nothing can now reach — orphaned data with no owner and no way back in.

Dependencies: config, supabase_tasks (REST helpers), and the store modules.
Consumed by main.py's DELETE /account.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

import config
import supabase_tasks

logger = logging.getLogger(__name__)

_TIMEOUT = 15.0

# Every JSON store on DATA_DIR that is a dict keyed by the user key. Adding a
# store to the server means adding it here — tests/test_account_deletion.py
# asserts this list covers every module that defines a _PATH, so a new store
# cannot quietly escape deletion.
_STORE_MODULES = (
    "user_memory",      # tasks, contacts, habits
    "conversation",     # chat history
    "agents_store",     # the user's personal agents
    "reminders",        # scheduled reminders
    "known_places",     # learned addresses
    "travel_prefs",     # learned transport habits
    "user_profile",     # home, routine, language
    "session",          # active conversation focus
    "provenance",       # which turn created what
    "bug_reports",      # anything they reported
    "meeting_brief",    # who they were about to meet
)

# Supabase tables owned directly by an auth user id.
_TABLES_BY_USER_ID = (
    "tasks", "goals", "daily_logs", "schedules", "reward_events",
    "custom_categories", "user_stats", "user_profiles", "app_settings",
    "personality_quiz",
)

# Server-side tables joined to the person through lumi_identities."userKey".
# lumi_identities itself is deleted LAST of these, because it is the join.
_TABLES_BY_USER_KEY = (
    "lumi_memories", "lumi_profiles", "lumi_conversations", "lumi_reminders",
    "lumi_agents", "lumi_known_places", "lumi_travel_prefs", "lumi_sessions",
    "lumi_user_records", "lumi_bug_reports",
)


def purge_local_stores(key: str) -> dict:
    """Drop this user's entry from every JSON store. -> {store: 'deleted'|'absent'|error}

    Imported lazily and one at a time: a store module that fails to import (or
    a file that will not decrypt) must not stop the other nine from being
    cleared.
    """
    result: dict[str, str] = {}
    for name in _STORE_MODULES:
        try:
            import importlib
            mod = importlib.import_module(name)
            data = mod._load()          # noqa: SLF001 — deletion is a store-level op
            if not isinstance(data, dict):
                result[name] = "unexpected shape, skipped"
                continue
            if key in data:
                del data[key]
                mod._save(data)         # noqa: SLF001
                result[name] = "deleted"
            else:
                result[name] = "absent"
        except Exception as exc:        # noqa: BLE001 — one store must not stop the rest
            logger.warning("account deletion: store %s failed: %s", name, exc)
            result[name] = f"failed: {type(exc).__name__}"
    return result


async def purge_supabase(user_id: Optional[str], key: str) -> dict:
    """Delete every Supabase row belonging to this person. -> {table: status}"""
    result: dict[str, str] = {}
    if not supabase_tasks._enabled():   # noqa: SLF001 — same package, one config
        return {"supabase": "not configured"}

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        if user_id:
            for table in _TABLES_BY_USER_ID:
                result[table] = await _delete_where(
                    client, table, {"userId": f"eq.{user_id}"})

        # The lumi_* tables key on userKey, which is the phone when one is
        # linked and the auth id otherwise — the same key the brain uses.
        for table in _TABLES_BY_USER_KEY:
            result[table] = await _delete_where(
                client, table, {"userKey": f"eq.{key}"})

        # The join row last, so the lookups above still resolve while they run.
        result["lumi_identities"] = await _delete_where(
            client, "lumi_identities", {"userKey": f"eq.{key}"})

    return result


async def _delete_where(client: httpx.AsyncClient, table: str, params: dict) -> str:
    try:
        r = await client.delete(
            supabase_tasks._rest(table),        # noqa: SLF001
            headers=supabase_tasks._headers(),  # noqa: SLF001
            params=params,
        )
        if r.status_code in (200, 204):
            return "deleted"
        # A table this deployment does not have is not an error for deletion —
        # there is nothing there to delete.
        if r.status_code == 404:
            return "no such table"
        return f"http {r.status_code}"
    except Exception as exc:            # noqa: BLE001
        logger.warning("account deletion: table %s failed: %s", table, exc)
        return f"failed: {type(exc).__name__}"


async def delete_auth_user(user_id: str) -> str:
    """Remove the Supabase auth account itself. Called LAST — see module docs."""
    if not supabase_tasks._enabled():   # noqa: SLF001
        return "not configured"
    base = config.SUPABASE_URL.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.delete(
                f"{base}/auth/v1/admin/users/{user_id}",
                headers={
                    "apikey": config.SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {config.SUPABASE_SERVICE_ROLE_KEY}",
                },
            )
        if r.status_code in (200, 204):
            return "deleted"
        if r.status_code == 404:
            return "already gone"
        return f"http {r.status_code}"
    except Exception as exc:            # noqa: BLE001
        logger.warning("account deletion: auth user failed: %s", exc)
        return f"failed: {type(exc).__name__}"


async def erase_account(key: str, user_id: Optional[str]) -> dict:
    """Erase one person everywhere. -> {'ok', 'stores', 'supabase', 'auth'}

    `ok` is True only when nothing reported a failure. It is deliberately
    strict: a caller that tells a user "your account is deleted" while a store
    errored has told them something untrue, and there is no way for them to
    find out otherwise.
    """
    stores = purge_local_stores(key)
    supabase = await purge_supabase(user_id, key)
    auth = await delete_auth_user(user_id) if user_id else "no auth user"

    failed = [
        f"{k}={v}" for k, v in {**stores, **supabase, "auth": auth}.items()
        if isinstance(v, str) and v.startswith(("failed", "http"))
    ]
    if failed:
        logger.error("account deletion incomplete for %s: %s", key[:4] + "…", failed)

    return {
        "ok": not failed,
        "stores": stores,
        "supabase": supabase,
        "auth": auth,
        "failed": failed,
    }
