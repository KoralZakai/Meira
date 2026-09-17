"""The one door to Postgres, and what it must not do to the code that uses it.

The state being moved is what the brain remembers. So the tests here are about
the failure modes of a MIGRATION rather than of a query: a database that is not
configured yet must be invisible, a database that is down must not take a save
with it, and a shadow write must never delay or fail the file write that is
still authoritative today.

No network: httpx is stubbed throughout.
"""
import asyncio
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config                      # noqa: E402
import database_service as db      # noqa: E402


class _Response:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else []
        self.text = str(self._payload)

    def json(self):
        return self._payload


class _Client:
    """Records every call instead of making one."""
    calls: list = []

    def __init__(self, *_, **__):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def get(self, url, headers=None, params=None):
        _Client.calls.append(("GET", url, params))
        return _Response(200, [{"kind": "routine", "content": "wakes 07:30"}])

    async def post(self, url, headers=None, params=None, json=None):
        _Client.calls.append(("POST", url, json))
        return _Response(201, [])

    async def delete(self, url, headers=None, params=None):
        _Client.calls.append(("DELETE", url, params))
        return _Response(204, [])


def _configured():
    _Client.calls = []
    return patch.multiple(config, SUPABASE_URL="https://fake.supabase.co",
                          SUPABASE_SERVICE_ROLE_KEY="service-role-key")


def _stub_http():
    return patch.object(db.httpx, "AsyncClient", _Client)


# --- not configured ---------------------------------------------------------

def test_unconfigured_is_invisible_not_broken():
    with patch.multiple(config, SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY=""):
        assert db.enabled() is False
        assert asyncio.run(db.get_memories("972500000001")) is None
        assert asyncio.run(db.add_memory("972500000001", "routine", "wakes 07:30")) is False


def test_the_json_mirror_still_runs_when_postgres_is_off():
    written = []
    with patch.multiple(config, SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY=""):
        asyncio.run(db.add_memory("k", "routine", "x", mirror=lambda: written.append("x")))
    assert written == ["x"], "the file write is what still works — it must happen"


def test_a_raising_mirror_never_escapes():
    def boom():
        raise RuntimeError("disk full")

    with patch.multiple(config, SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY=""):
        assert asyncio.run(db.add_memory("k", "routine", "x", mirror=boom)) is False


# --- configured -------------------------------------------------------------

def test_memory_write_goes_to_the_right_table_and_still_mirrors():
    written = []
    with _configured(), _stub_http():
        ok = asyncio.run(db.add_memory("972500000001", "routine", "wakes 07:30",
                                       mirror=lambda: written.append(1)))
    assert ok is True and written == [1]
    method, url, body = _Client.calls[0]
    assert method == "POST" and url.endswith("/rest/v1/lumi_memories")
    assert body[0]["userKey"] == "972500000001"
    assert body[0]["content"] == "wakes 07:30"


def test_an_unknown_memory_kind_is_refused_before_it_reaches_the_check_constraint():
    with _configured(), _stub_http():
        assert asyncio.run(db.add_memory("k", "vibes", "something")) is False
    assert _Client.calls == []


def test_a_none_never_erases_a_profile_field():
    with _configured(), _stub_http():
        asyncio.run(db.update_profile("k", {"name": "קורל", "homeAddress": None,
                                            "transportType": ""}))
    _, _, body = _Client.calls[0]
    assert body[0] == {"name": "קורל", "userKey": "k"}


def test_unknown_profile_fields_are_dropped_rather_than_posted():
    with _configured(), _stub_http():
        asyncio.run(db.update_profile("k", {"name": "x", "favouriteColour": "yellow"}))
    _, _, body = _Client.calls[0]
    assert "favouriteColour" not in body[0]


def test_a_server_error_is_a_false_not_an_exception():
    class _Failing(_Client):
        async def post(self, url, headers=None, params=None, json=None):
            return _Response(500, {"message": "boom"})

    with _configured(), patch.object(db.httpx, "AsyncClient", _Failing):
        assert asyncio.run(db.add_memory("k", "routine", "x")) is False


def test_recent_turns_come_back_oldest_first():
    class _Turns(_Client):
        async def get(self, url, headers=None, params=None):
            # PostgREST is asked for newest-first (that is how you take the tail)
            assert params["order"] == "createdAt.desc"
            return _Response(200, [{"text": "newest"}, {"text": "older"}])

    with _configured(), patch.object(db.httpx, "AsyncClient", _Turns):
        turns = asyncio.run(db.recent_turns("k"))
    assert [t["text"] for t in turns] == ["older", "newest"], "a prompt reads forwards"


def test_semantic_search_calls_the_rpc_with_the_users_key():
    with _configured(), _stub_http():
        asyncio.run(db.search_memories("972500000001", [0.1, 0.2, 0.3], limit=5))
    method, url, body = _Client.calls[0]
    assert method == "POST" and url.endswith("/rest/v1/rpc/lumi_match_memories")
    assert body["p_user_key"] == "972500000001" and body["p_limit"] == 5


def test_search_without_an_embedding_does_not_call_anything():
    with _configured(), _stub_http():
        assert asyncio.run(db.search_memories("k", [])) is None
    assert _Client.calls == []


def test_the_due_reminder_query_asks_only_for_unsent_overdue_rows():
    with _configured(), _stub_http():
        asyncio.run(db.due_reminders("2026-09-06T10:00:00+03:00"))
    _, url, params = _Client.calls[0]
    assert url.endswith("/rest/v1/lumi_reminders")
    assert params["sent"] == "eq.false"
    assert params["fireAt"].startswith("lte.")


# --- shadow writes ----------------------------------------------------------

def test_shadow_write_outside_a_loop_does_not_leave_a_pending_coroutine():
    async def noop():
        return True

    coro = noop()
    db.shadow_write(coro)          # no running loop: must close it, not warn
    assert coro.cr_running is False


def test_shadow_write_inside_a_loop_schedules_and_does_not_block():
    ran = []

    async def scenario():
        async def slow():
            await asyncio.sleep(0)
            ran.append(True)
        db.shadow_write(slow())
        await asyncio.sleep(0)     # let the task run
        await asyncio.sleep(0)

    asyncio.run(scenario())
    assert ran == [True]


def test_a_failing_shadow_write_does_not_raise_into_the_caller():
    async def scenario():
        async def boom():
            raise RuntimeError("supabase down")
        db.shadow_write(boom())
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    asyncio.run(scenario())        # must simply not raise
