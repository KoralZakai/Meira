"""The thin client's two doors: capture, and the timeline.

`/app/schedule/build` must not call a model — the whole reason it exists is that
sorting a day is arithmetic, and the old path paid a 235B model to redo work the
code had already done correctly. `/app/tasks/extract` must never swallow a
message: a model that answers `[]` for clear Hebrew used to make the task
vanish, and now the sentence itself survives as the task.

No network anywhere: app_auth.verify is patched and the extraction client is a
stub, so these tests say nothing about Nebius being up.
"""
import importlib
import os
import sys
import tempfile
import unittest
from datetime import date
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient   # noqa: E402

import config                                # noqa: E402

_TMP = tempfile.mkdtemp(prefix="lumi-approutes-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "agents_store", "user_store", "conversation",
           "provenance", "reminders", "known_places", "travel_prefs"):
    mod = importlib.import_module(_m)
    mod._PATH = os.path.join(_TMP, os.path.basename(getattr(mod, "_PATH")))

import main            # noqa: E402
import app_auth        # noqa: E402
import task_extract    # noqa: E402

client = TestClient(main.app)

# A date that is never "today". The schedule builder starts its cursor at the
# CURRENT time when it is asked for today — correct behaviour, and a trap for a
# test that hard-codes a date: "2026-09-07" was tomorrow when these were
# written and became today the next morning, at which point the expected
# 10:30 turned into 23:30. Anything asserting fixed slot times must use a day
# the clock cannot reach; `test_today_starts_the_cursor_at_now` covers the
# other half deliberately.
A_FUTURE_DAY = "2099-01-04"
ALICE = {"userId": "alice-uuid", "email": "alice@example.com"}
AUTH = {"Authorization": "Bearer good-token"}


def _signed_in():
    async def fake_verify(authorization):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise app_auth.AuthError("missing bearer token")
        return dict(ALICE)

    async def fake_phone(user_id):
        return "972500000001"

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


DRAFT = [
    {"text": "gym", "category": "gym", "duration_minutes": 60, "priority": "must"},
    {"text": "interview", "category": "interview", "fixed_time": "10:00", "priority": "must"},
    {"text": "water the plants", "priority": "nice_to_do"},
]


class ScheduleBuild(unittest.TestCase):
    def test_requires_a_token(self):
        self.assertEqual(client.post("/app/schedule/build", json={}).status_code, 401)

    def test_builds_a_day_without_calling_a_model(self):
        with _signed_in():
            body = client.post("/app/schedule/build",
                               json={"date": A_FUTURE_DAY, "tasks": DRAFT, "wake_time": "08:00"},
                               headers=AUTH).json()
        self.assertEqual(body["source"], "deterministic")
        placed = {t["text"]: t.get("scheduled_time") for t in body["tasks"]}
        self.assertEqual(placed["interview"], "10:00")   # fixed time is kept
        # The interview is sorted first (same priority, earlier clock) and pulls
        # the cursor to its end, so the flexible task lands after it — the app's
        # own rule, ported unchanged so both sides build the SAME day.
        self.assertEqual(placed["gym"], "10:30")
        self.assertIn("👇", body["summary"])              # short, one line

    def test_important_only_leaves_the_small_stuff_off_the_timeline(self):
        with _signed_in():
            body = client.post("/app/schedule/build",
                               json={"date": A_FUTURE_DAY, "tasks": DRAFT,
                                     "important_only": True}, headers=AUTH).json()
        placed = {t["text"]: t.get("scheduled_time") for t in body["tasks"]}
        self.assertIsNone(placed["water the plants"])
        self.assertEqual(len(body["tasks"]), 3)          # nothing is dropped

    def test_summary_speaks_the_users_language(self):
        with _signed_in():
            he = client.post("/app/schedule/build",
                             json={"date": A_FUTURE_DAY, "tasks": DRAFT, "language": "he"},
                             headers=AUTH).json()["summary"]
            en = client.post("/app/schedule/build",
                             json={"date": A_FUTURE_DAY, "tasks": DRAFT, "language": "en"},
                             headers=AUTH).json()["summary"]
        self.assertIn("משימות", he)
        self.assertIn("tasks", en)


class ScheduleBuildToday(unittest.TestCase):
    def test_today_starts_the_cursor_at_now_not_at_wake_time(self):
        """Asked for TODAY, the builder must not schedule into the past — the
        rule the hard-coded date above was tripping over once it came round."""
        import tz as _tz
        now = _tz.now_il().strftime("%H:%M")
        with _signed_in():
            body = client.post("/app/schedule/build",
                               json={"date": _tz.today_il().isoformat(),
                                     "tasks": [{"text": "gym", "category": "gym",
                                                "duration_minutes": 60, "priority": "must"}],
                                     "wake_time": "08:00"}, headers=AUTH).json()
        slot = body["tasks"][0]["scheduled_time"]
        self.assertGreaterEqual(slot, now, "a flexible task was scheduled in the past")


class TaskExtract(unittest.TestCase):
    def test_requires_a_token(self):
        self.assertEqual(client.post("/app/tasks/extract",
                                     json={"text": "gym"}).status_code, 401)

    def test_empty_text_is_a_400_not_an_empty_task(self):
        with _signed_in():
            r = client.post("/app/tasks/extract", json={"text": "   "}, headers=AUTH)
        self.assertEqual(r.status_code, 400)

    def test_a_model_returning_nothing_cannot_swallow_the_message(self):
        async def no_tasks(text, today=None, learned=None):
            return task_extract.finalize({}, text, today or date(2026, 9, 6))

        with _signed_in(), patch.object(task_extract, "_get_client", side_effect=RuntimeError("nebius down")):
            body = client.post("/app/tasks/extract",
                               json={"text": "ראיון עבודה מחר ב-13:00",
                                     "date": "2099-01-03"},   # the reference date, not the clock
                               headers=AUTH).json()
        self.assertEqual(body["count"], 1)
        task = body["tasks"][0]
        # The title keeps the WHAT and sheds the WHEN — the date and clock have
        # their own fields below, and repeating them in the name is how a task
        # ends up called "ראיון עבודה מחר ב-13:00" forever, still saying "מחר"
        # next week. Nothing is swallowed: every part of the sentence survives,
        # each in the field that owns it.
        self.assertEqual(task["text"], "ראיון עבודה")
        self.assertEqual(task["category"], "interview")   # the table labelled it
        self.assertEqual(task["priority"], "must")
        self.assertEqual(task["fixed_time"], "13:00")     # code read the clock
        self.assertEqual(task["date"], "2099-01-04")      # code resolved 'מחר' from it


if __name__ == "__main__":
    unittest.main()
