"""task_store — reading a user's tasks, in ONE place.

`_fetch_task_rows` lived inside `lumi_agent._make_tools` as a closure, which
made it unreachable from anywhere else; the moment a second caller needed the
same rows (the app's schedule endpoint), the honest options were "import a
closure" or "write it again". Writing it again is how this codebase ended up
with four task extractors and three schedule builders, so: one function, two
callers.

Order is deliberate and unchanged: Supabase first (it holds tasks from ALL
sources — app, WhatsApp, web), and the JSON memory store second as the offline
mirror. First non-empty wins. There used to be a middle step through a server
Postgres that never ran — DatabaseService was referenced but never imported, so
every call raised NameError into a bare except.

Dependencies: supabase_tasks, user_memory. Consumed by lumi_agent and routes_app.
"""
from __future__ import annotations

import logging
from typing import Optional

import identity_keys
import supabase_tasks
import user_memory

logger = logging.getLogger(__name__)


async def fetch_tasks_with_source(
        phone: str, date_from: Optional[str] = None, date_to: Optional[str] = None,
        include_location: bool = False) -> tuple[list, str]:
    """Every saved task for this user, plus WHICH store answered.

    Source is "supabase", "memory" (the JSON mirror), "empty" (she has none) or
    "unreachable" (Supabase failed and the mirror has nothing — NOT a free day,
    silent-state rule 1). Callers that
    serve the app want it: "why is my list stale?" is unanswerable from the
    outside unless the response says where the rows came from.

    Both date bounds are optional so the app's sync endpoint — which wants the
    whole list, not a window — can come through this door instead of reading the
    mirror directly. That direct read was the split brain: GET /tasks/{phone}
    treated the JSON file as canonical while every other caller preferred
    Supabase, so the same user could get two different answers about the same
    tasks depending on which code path asked.
    """
    failed = False
    try:
        uid = await supabase_tasks.user_id_for_phone(str(phone))
        if not uid and not identity_keys.looks_like_phone(str(phone)):
            # The agent's key for a person may be an alias of her account (a
            # user-record id, an old phone key). 27.10 live: unresolved, the
            # read fell through to the stale mirror and Meira recited a day of
            # old routines while the real one held an interview.
            # A PHONE key resolves only through its verified link (7.10); an
            # unlinked number never falls back to the account it once had.
            brain = identity_keys.canonical(phone)
            if brain and brain != str(phone):
                uid = await supabase_tasks.user_id_for_phone(brain)
        if uid:
            rows = await supabase_tasks.tasks_for_user(
                uid, date_from, date_to, include_location=include_location)
            if rows:
                return rows, "supabase"
    except Exception as exc:  # noqa: BLE001 — the mirror below is the fallback
        failed = True
        logger.warning("supabase task read failed, using local mirror: %s", type(exc).__name__)

    # The mirror. Still the answer when Supabase is unreachable or has not seen
    # this user yet — stale-but-present beats an empty day.
    rows = [t for t in user_memory.tasks_for_phone(phone)
            if (not date_from or t.get("date", "") >= date_from)
            and (not date_to or t.get("date", "") <= date_to)]
    if rows:
        return rows, "memory"
    return [], ("unreachable" if failed else "empty")


async def fetch_task_rows(phone: str, date_from: Optional[str] = None,
                          date_to: Optional[str] = None,
                          include_location: bool = False) -> list:
    """Just the rows. Unchanged signature for every existing caller."""
    rows, _ = await fetch_tasks_with_source(
        phone, date_from, date_to, include_location=include_location)
    return rows
