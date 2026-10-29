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
from typing import Iterable, Optional

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
    "task_prep",        # what Meira prepared for their tasks
    "mcp_server",       # AI-assistant tokens: deleting the account revokes them
    "feedback_store",   # their 👍/👎 on suggestions
    "chat_feedback",    # their 👍/👎 on chat replies, with both texts
    "questions_store",  # what Meira asked them and what they answered
    "user_rules",       # rules they taught Meira by answering
    "user_quota",       # their AI spend counters (per-person allowance)
    "phone_links",      # the proved WhatsApp ↔ account link
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
    "lumi_user_records", "lumi_bug_reports", "lumi_history", "lumi_groups",
)


def _keys(key: str, more: Iterable[str]) -> list:
    return [k for k in dict.fromkeys([key, *more]) if k]


def _combined(statuses: list) -> str:
    """One status for a store or table purged under several keys: a failure
    wins (it must be reported), then "deleted", then whatever the first said."""
    for st in statuses:
        if isinstance(st, str) and st.startswith(("failed", "http")):
            return st
    return "deleted" if "deleted" in statuses else (statuses[0] if statuses else "absent")


_OWNER_FIELDS = ("phone", "owner", "owner_phone", "userKey", "userId")


def _owned_row(row: object, keys) -> bool:
    if not isinstance(row, dict):
        return False
    wanted = {str(k) for k in keys}
    phones = {d for d in ("".join(c for c in k if c.isdigit()) for k in wanted) if len(d) >= 9}
    for f in _OWNER_FIELDS:
        v = row.get(f)
        if v is None:
            continue
        v = str(v)
        if v in wanted or "".join(c for c in v if c.isdigit()) in phones:
            return True
    return False


def _purge_pending_mirror(keys) -> str:
    """supabase_tasks' retry queue: task text keyed by phone, its own load/save."""
    items = supabase_tasks._load_pending()   # noqa: SLF001
    kept = [it for it in items if not _owned_row(it, keys)]
    if len(kept) == len(items):
        return "absent"
    supabase_tasks._save_pending(kept)       # noqa: SLF001
    return "deleted"


def purge_local_stores(key: str, *more_keys: str) -> dict:
    """Drop this user's entries from every JSON store. -> {store: 'deleted'|'absent'|error}

    `more_keys`: every other key the same person's data may sit under
    (identity_keys.all_keys) — the account id the agent writes, the phone the
    app routes wrote, the id the number had before it was linked. Deleting one
    of three is hiding the account, not deleting it.

    Imported lazily and one at a time: a store module that fails to import (or
    a file that will not decrypt) must not stop the other nine from being
    cleared.
    """
    keys = _keys(key, more_keys)
    result: dict[str, str] = {}
    for name in _STORE_MODULES:
        try:
            import importlib
            mod = importlib.import_module(name)
            data = mod._load()          # noqa: SLF001 — deletion is a store-level op
            if isinstance(data, list):
                # reminders, agents: rows that NAME their owner. Skipping them as
                # "unexpected shape" while reporting ok left her reminders (text,
                # times, the people she messages) on the server after deletion.
                kept = [row for row in data if not _owned_row(row, keys)]
                if len(kept) != len(data):
                    mod._save(kept)     # noqa: SLF001
                    result[name] = "deleted"
                else:
                    result[name] = "absent"
                continue
            if not isinstance(data, dict):
                result[name] = "failed: unexpected shape"
                continue
            # session keys its entries by the key's digits (session._digits):
            # look under that form too, or her entry outlives the deletion.
            forms = [*keys, *("".join(c for c in str(k) if c.isdigit()) for k in keys)]
            hit = [k for k in dict.fromkeys(forms) if k and k in data]
            if hit:
                for k in hit:
                    del data[k]
                mod._save(data)         # noqa: SLF001
                result[name] = "deleted"
            else:
                result[name] = "absent"
        except Exception as exc:        # noqa: BLE001 — one store must not stop the rest
            logger.warning("account deletion: store %s failed: %s", name, exc)
            result[name] = f"failed: {type(exc).__name__}"
    try:
        result["pending_mirror"] = _purge_pending_mirror(keys)
    except Exception as exc:            # noqa: BLE001
        logger.warning("account deletion: pending mirror failed: %s", exc)
        result["pending_mirror"] = f"failed: {type(exc).__name__}"
    return result


async def purge_supabase(user_id: Optional[str], key: str, *more_keys: str) -> dict:
    """Delete every Supabase row belonging to this person. -> {table: status}"""
    result: dict[str, str] = {}
    if not supabase_tasks._enabled():   # noqa: SLF001 — same package, one config
        return {"supabase": "not configured"}
    keys = _keys(key, more_keys)

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        if user_id:
            for table in _TABLES_BY_USER_ID:
                result[table] = await _delete_where(
                    client, table, {"userId": f"eq.{user_id}"})

        # The lumi_* tables key on userKey, and a person's rows sit under every
        # key the stores were written with — see identity_keys.
        for table in _TABLES_BY_USER_KEY:
            result[table] = _combined([
                await _delete_where(client, table, {"userKey": f"eq.{k}"}) for k in keys])

        # Groups she was INVITED to (her own groups went with lumi_groups above):
        # her membership row and its answers (cascade) go too.
        result["lumi_group_members"] = _combined([
            await _delete_where(client, "lumi_group_members", {"memberKey": f"eq.{k}"}) for k in keys])

        # The join rows last, so the lookups above still resolve while they run.
        result["lumi_identities"] = _combined([
            await _delete_where(client, "lumi_identities", {"userKey": f"eq.{k}"}) for k in keys])

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


async def erase_account(key: str, user_id: Optional[str], extra_keys: Iterable[str] = ()) -> dict:
    """Erase one person everywhere. -> {'ok', 'stores', 'supabase', 'auth'}

    `extra_keys`: the other keys the same person's data sits under
    (identity_keys.all_keys(caller)). Without them a linked user's agent
    memory, history and profile — kept under the account id — survived.

    `ok` is True only when nothing reported a failure. It is deliberately
    strict: a caller that tells a user "your account is deleted" while a store
    errored has told them something untrue, and there is no way for them to
    find out otherwise.
    """
    more = [k for k in extra_keys if k and k != key]
    stores = purge_local_stores(key, *more)
    supabase = await purge_supabase(user_id, key, *more)
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
