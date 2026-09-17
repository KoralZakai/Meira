"""Deleting an account must actually delete it — everywhere, or say it didn't.

Google Play has required an account-deletion route since 2024, and Lumi's
privacy policy now promises one. That promise is the reason these tests are
strict: a deletion that quietly misses a store leaves the data in place while
telling the user it is gone, which is worse than offering nothing.

The failure this file is really guarding against is DRIFT. The user's data
lives in ten JSON stores that were added at different times for different
features. The eleventh will be added by someone who is not thinking about
deletion at all, and nothing about writing a new store makes you remember this
module exists. So one test walks the server package and fails if a store is not
covered.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config   # noqa: E402

_TMP = tempfile.mkdtemp(prefix="lumi-delete-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "conversation", "agents_store", "reminders",
           "known_places", "travel_prefs", "user_profile", "session",
           "provenance", "bug_reports"):
    _mod = importlib.import_module(_m)
    _mod._PATH = os.path.join(_TMP, os.path.basename(getattr(_mod, "_PATH")))

import account_deletion   # noqa: E402

MINE = "972500000001"
THEIRS = "972500000002"


def _seed(module_name: str, payload: dict) -> None:
    mod = importlib.import_module(module_name)
    mod._save(payload)


def _read(module_name: str) -> dict:
    mod = importlib.import_module(module_name)
    return mod._load()


@pytest.fixture(autouse=True)
def _clean_stores():
    for name in account_deletion._STORE_MODULES:
        try:
            importlib.import_module(name)._save({})
        except Exception:   # noqa: BLE001
            pass
    yield


# ── the list cannot fall behind the codebase ────────────────────────────────

def test_every_per_user_json_store_is_covered():
    """A store added later must not silently escape deletion.

    Walks the server package for modules defining a `_PATH` on DATA_DIR, and
    requires each to be either covered or explicitly exempt. When this fails,
    the fix is almost always to add the new store to _STORE_MODULES — not to
    add it to the exemptions.
    """
    # Stores that hold no per-user data, with the reason each is exempt.
    exempt = {
        "llm_usage": "aggregate spend per day, not per user",
        "supabase_tasks": "a pending-write queue, flushed not owned",
        "user_store": "auth/handoff tokens, keyed by token not by user",
        "migrate_wa_ids": "a one-off migration script",
    }
    server_dir = Path(__file__).resolve().parent.parent
    found = []
    for path in sorted(server_dir.glob("*.py")):
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "_PATH = os.path.join(config.DATA_DIR" in text:
            found.append(path.stem)

    uncovered = [
        m for m in found
        if m not in account_deletion._STORE_MODULES and m not in exempt
    ]
    assert not uncovered, (
        f"these stores hold data and nothing deletes it: {uncovered}. "
        "Add them to account_deletion._STORE_MODULES."
    )


def test_the_covered_list_has_no_ghosts():
    """Every name in _STORE_MODULES must import — a typo would silently skip it."""
    for name in account_deletion._STORE_MODULES:
        importlib.import_module(name)


# ── local stores ────────────────────────────────────────────────────────────

def test_my_data_is_removed_from_every_store():
    for name in account_deletion._STORE_MODULES:
        _seed(name, {MINE: {"secret": "mine"}, THEIRS: {"secret": "theirs"}})

    result = account_deletion.purge_local_stores(MINE)

    for name in account_deletion._STORE_MODULES:
        assert result[name] == "deleted", f"{name}: {result[name]}"
        assert MINE not in _read(name), f"{name} still holds my data"


def test_nobody_else_is_touched():
    """The single worst bug this code could have."""
    for name in account_deletion._STORE_MODULES:
        _seed(name, {MINE: {"secret": "mine"}, THEIRS: {"secret": "theirs"}})

    account_deletion.purge_local_stores(MINE)

    for name in account_deletion._STORE_MODULES:
        data = _read(name)
        assert THEIRS in data, f"{name} deleted somebody else's data"
        assert data[THEIRS] == {"secret": "theirs"}


def test_deleting_twice_is_fine():
    """Users retry. So do networks."""
    _seed("user_memory", {MINE: {"a": 1}})
    first = account_deletion.purge_local_stores(MINE)
    second = account_deletion.purge_local_stores(MINE)
    assert first["user_memory"] == "deleted"
    assert second["user_memory"] == "absent"


def test_an_account_that_was_never_there():
    result = account_deletion.purge_local_stores("972599999999")
    assert all(v == "absent" for v in result.values()), result


def test_one_broken_store_does_not_stop_the_others():
    """Half-deleted is bad; half-deleted AND reported as fine is unacceptable."""
    for name in account_deletion._STORE_MODULES:
        _seed(name, {MINE: {"secret": "mine"}})

    broken = importlib.import_module("known_places")
    with patch.object(broken, "_save", side_effect=OSError("disk on fire")):
        result = account_deletion.purge_local_stores(MINE)

    assert result["known_places"].startswith("failed"), result["known_places"]
    for name in account_deletion._STORE_MODULES:
        if name != "known_places":
            assert result[name] == "deleted", f"{name} was abandoned"
            assert MINE not in _read(name)


# ── the whole operation ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_erase_reports_failure_rather_than_claiming_success():
    _seed("user_memory", {MINE: {"a": 1}})
    # Seed the store we are about to break, too: purge only calls _save when
    # the key is actually present, so breaking an EMPTY store exercises
    # nothing and the test would pass for the wrong reason.
    _seed("conversation", {MINE: [{"role": "user", "content": "hi"}]})
    broken = importlib.import_module("conversation")
    with patch.object(broken, "_save", side_effect=OSError("nope")), \
         patch.object(account_deletion.supabase_tasks, "_enabled", lambda: False):
        result = await account_deletion.erase_account(MINE, None)

    assert result["ok"] is False
    assert any("conversation" in f for f in result["failed"])


@pytest.mark.asyncio
async def test_a_clean_erase_reports_ok():
    _seed("user_memory", {MINE: {"a": 1}})
    with patch.object(account_deletion.supabase_tasks, "_enabled", lambda: False):
        result = await account_deletion.erase_account(MINE, None)
    assert result["ok"] is True, result["failed"]
    assert MINE not in _read("user_memory")


@pytest.mark.asyncio
async def test_the_auth_user_is_deleted_last():
    """While the login exists the user can retry. Delete it first and a failure
    halfway strands rows that nothing can now reach."""
    order: list[str] = []

    async def fake_supabase(user_id, key):
        order.append("rows")
        return {}

    async def fake_auth(user_id):
        order.append("auth")
        return "deleted"

    with patch.object(account_deletion, "purge_supabase", fake_supabase), \
         patch.object(account_deletion, "delete_auth_user", fake_auth), \
         patch.object(account_deletion, "purge_local_stores",
                      lambda k: (order.append("stores"), {})[1]):
        await account_deletion.erase_account(MINE, "uuid-1")

    assert order == ["stores", "rows", "auth"], order


@pytest.mark.asyncio
async def test_no_auth_user_is_not_a_failure():
    """A WhatsApp-only user has no Supabase account to delete."""
    with patch.object(account_deletion.supabase_tasks, "_enabled", lambda: False):
        result = await account_deletion.erase_account(MINE, None)
    assert result["auth"] == "no auth user"
    assert result["ok"] is True
