"""GET /tasks/{phone} reads through task_store, like everything else.

The split brain this closes: the endpoint read `user_memory` directly and its
docstring called the JSON file canonical, while `task_store.fetch_task_rows` —
used by the agent and by /app/schedule/build — preferred Supabase. Same user,
same tasks, two possible answers depending on which code path asked. A task
edited in the app and mirrored to Supabase stayed invisible to the sync pull for
as long as a stale row survived in the file.

Supabase first, the mirror when it is unreachable or has nothing, and the
response says which — because "why is my list stale" is otherwise unanswerable
from outside the box.
"""
import importlib
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient   # noqa: E402

import config                                # noqa: E402

_TMP = tempfile.mkdtemp(prefix="lumi-readpath-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "agents_store", "user_store", "conversation",
           "provenance", "reminders", "known_places", "travel_prefs"):
    mod = importlib.import_module(_m)
    mod._PATH = os.path.join(_TMP, os.path.basename(getattr(mod, "_PATH")))

import main             # noqa: E402
import app_auth         # noqa: E402
import task_store       # noqa: E402
import supabase_tasks   # noqa: E402
import user_memory      # noqa: E402

client = TestClient(main.app)
PHONE = "972500000001"
AUTH = {"Authorization": "Bearer good-token"}

CLOUD = {"id": "task-1", "text": "ראיון עבודה", "category": "interview",
         "priority": "must", "duration_minutes": 90, "fixed_time": "11:30",
         "date": "2099-01-04", "status": "pending",
         "location": {"address": "יגאל אלון 94", "lat": 32.07, "lng": 34.79}}
STALE = {"id": "task-1", "text": "ראיון עבודה (old)", "category": "general",
         "priority": "need_to", "duration_minutes": 30, "fixed_time": "09:00",
         "date": "2099-01-04", "status": "pending"}


def _signed_in():
    async def fake_verify(authorization):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise app_auth.AuthError("missing bearer token")
        return {"userId": "alice-uuid", "email": "alice@example.com"}

    async def fake_phone(user_id):
        return PHONE

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


def _supabase(rows, uid="alice-uuid"):
    async def fake_uid(phone):
        return uid

    async def fake_rows(user_id, date_from=None, date_to=None, include_location=False):
        return list(rows)

    return patch.multiple(supabase_tasks, user_id_for_phone=fake_uid,
                          tasks_for_user=fake_rows)


class ReadPath(unittest.TestCase):
    def setUp(self):
        user_memory._save({}) if hasattr(user_memory, "_save") else None

    def test_supabase_wins_over_a_stale_mirror_row(self):
        """THE bug. The file holds an old copy of the same task id; the cloud
        holds the corrected one. The app must be told the corrected one."""
        user_memory.add_task(PHONE, STALE)
        with _signed_in(), _supabase([CLOUD]):
            body = client.get(f"/tasks/{PHONE}", headers=AUTH).json()
        self.assertEqual(body["source"], "supabase")
        self.assertEqual(body["tasks"][0]["text"], "ראיון עבודה")
        self.assertEqual(body["tasks"][0]["fixed_time"], "11:30")

    def test_the_route_survives_the_trip(self):
        """include_location=True is not decoration: a WhatsApp-planned task
        without its route is a task nobody can leave the house for."""
        with _signed_in(), _supabase([CLOUD]):
            body = client.get(f"/tasks/{PHONE}", headers=AUTH).json()
        self.assertEqual(body["tasks"][0]["location"]["address"], "יגאל אלון 94")

    def test_falls_back_to_the_mirror_when_supabase_is_down(self):
        user_memory.add_task(PHONE, STALE)

        async def boom(phone):
            raise RuntimeError("supabase unreachable")

        with _signed_in(), patch.object(supabase_tasks, "user_id_for_phone", boom):
            body = client.get(f"/tasks/{PHONE}", headers=AUTH).json()
        self.assertEqual(body["source"], "memory")
        self.assertEqual(len(body["tasks"]), 1)

    def test_empty_is_reported_as_empty_not_as_a_store(self):
        with _signed_in(), _supabase([]):
            body = client.get(f"/tasks/{PHONE}", headers=AUTH).json()
        self.assertEqual(body, {"tasks": [], "source": "empty"})

    def test_the_endpoint_no_longer_reads_user_memory_directly(self):
        import inspect
        src = inspect.getsource(main.get_tasks_for_phone)
        self.assertIn("task_store.fetch_tasks_with_source", src)
        self.assertNotIn("user_memory.tasks_for_phone", src,
                         "the endpoint is reading the mirror directly again")


class Bounds(unittest.IsolatedAsyncioTestCase):
    async def test_no_dates_means_everything(self):
        """The sync endpoint wants the whole list. A required date range is what
        made it read the file instead."""
        seen = {}

        async def fake_rows(user_id, date_from=None, date_to=None, include_location=False):
            seen.update(date_from=date_from, date_to=date_to)
            return [CLOUD]

        with patch.multiple(supabase_tasks,
                            user_id_for_phone=lambda p: _ok("alice-uuid"),
                            tasks_for_user=fake_rows):
            rows, source = await task_store.fetch_tasks_with_source(PHONE)
        self.assertEqual(source, "supabase")
        self.assertEqual(seen, {"date_from": None, "date_to": None})

    async def test_a_range_still_filters_the_mirror(self):
        user_memory.add_task(PHONE, {**STALE, "id": "old", "date": "2020-01-01"})
        user_memory.add_task(PHONE, {**STALE, "id": "new", "date": "2099-01-04"})

        async def no_uid(phone):
            return None

        with patch.object(supabase_tasks, "user_id_for_phone", no_uid):
            rows, source = await task_store.fetch_tasks_with_source(
                PHONE, "2099-01-01", "2099-12-31")
        self.assertEqual(source, "memory")
        self.assertEqual([r["id"] for r in rows], ["new"])


async def _ok(value):
    return value


if __name__ == "__main__":
    unittest.main()
