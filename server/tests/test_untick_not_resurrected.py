"""The app's status is the user's decision. The server may not overrule it.

Found live on 2026-09-12, after four client-side fixes had failed to stop it:
Koral removes the tick from "לעשות תוכנית עסקית lean canvas" and it comes back.
Every client fix missed because the resurrection is fired BY the untick itself:

    untick in the app
      -> local store: pending, Supabase: pending            (correct)
      -> POST /tasks/{phone}                                (app->server sync)
           user_memory.add_task merges with its stored copy, which still says
           'complete' from an old WhatsApp turn, and its non-clobbering rule
           reads an explicit app 'pending' as a bare re-mention -> keeps
           'complete'
      -> _mirror_task_to_supabase(stored) writes 'complete' BACK to Supabase
      -> the app hydrates from Supabase and the tick is on again.

The rule itself is right for WhatsApp: "יוגה מחר" mentioned again must not
un-complete anything. It is wrong for the app, which sends a full task whose
status is the user's own last decision. So the trust is now explicit — the
caller says whether the status it carries is authoritative.

The mirror also never wrote completedAt, which is why ten rows on her phone
carried status='complete' with completedAt=null, a shape the app itself cannot
produce. Status and its stamp are now written together, so the two can never
disagree again.
"""
import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient   # noqa: E402

import config                                # noqa: E402

_TMP = tempfile.mkdtemp(prefix="lumi-untick-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "agents_store", "user_store", "conversation",
           "provenance", "reminders", "known_places", "travel_prefs"):
    _mod = importlib.import_module(_m)
    _mod._PATH = os.path.join(_TMP, os.path.basename(getattr(_mod, "_PATH")))

import main             # noqa: E402
import app_auth         # noqa: E402
import supabase_tasks   # noqa: E402
import user_memory      # noqa: E402

client = TestClient(main.app)

PHONE = "972500000001"
KORAL = {"userId": "koral-uuid", "email": "koral@example.com"}
AUTH = {"Authorization": "Bearer good-token"}
TASK_ID = "1788673252756-o63lh3bl"   # the real lean-canvas id
TEXT = "לעשות תוכנית עסקית lean canvas"


def _signed_in():
    async def fake_verify(authorization):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise app_auth.AuthError("missing bearer token")
        return dict(KORAL)

    async def fake_phone(user_id):
        return PHONE

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


class UserMemoryStatusTrustTests(unittest.TestCase):
    """The merge rule has to serve both callers, so it has to be told which one."""

    def setUp(self):
        user_memory.add_task(PHONE, {
            "id": TASK_ID, "text": TEXT, "date": "2026-09-10", "status": "complete",
        })

    def tearDown(self):
        data = user_memory._load()
        data.pop(PHONE, None)
        user_memory._save(data)

    def test_a_whatsapp_rementionar_still_does_not_unfinish_a_done_task(self):
        # Unchanged behaviour: "lean canvas" said again in chat carries a
        # default pending that means nothing.
        stored = user_memory.add_task(PHONE, {"id": TASK_ID, "text": TEXT, "date": "2026-09-10"})
        self.assertEqual(stored["status"], "complete")

    def test_the_app_unticking_wins(self):
        stored = user_memory.add_task(
            PHONE,
            {"id": TASK_ID, "text": TEXT, "date": "2026-09-10", "status": "pending"},
            trust_status=True,
        )
        self.assertEqual(stored["status"], "pending")


class PostTaskDoesNotResurrectTests(unittest.TestCase):
    """The end-to-end path the untick actually travels."""

    def setUp(self):
        user_memory.add_task(PHONE, {
            "id": TASK_ID, "text": TEXT, "date": "2026-09-10", "status": "complete",
        })
        self.mirrored = []

        async def fake_upsert(user_id, task, trust_status=False):
            self.mirrored.append(task)
            return task.get("id")

        async def fake_uid(phone):
            return KORAL["userId"]

        self.patches = patch.multiple(
            supabase_tasks, upsert_task=fake_upsert, user_id_for_phone=fake_uid)

    def tearDown(self):
        data = user_memory._load()
        data.pop(PHONE, None)
        user_memory._save(data)

    def test_untick_reaches_the_server_store_and_the_mirror_as_pending(self):
        with _signed_in(), self.patches:
            res = client.post(f"/tasks/{PHONE}", headers=AUTH, json={
                "id": TASK_ID, "text": TEXT, "date": "2026-09-10",
                "status": "pending", "durationMinutes": 30, "category": "work",
            })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["task"]["status"], "pending")
        self.assertEqual(user_memory.tasks_for_phone(PHONE)[0]["status"], "pending")
        self.assertTrue(self.mirrored, "nothing was mirrored to Supabase")
        self.assertEqual(self.mirrored[-1]["status"], "pending",
                         "the mirror wrote the stale 'complete' back to the cloud")


class CompletedAtIsWrittenWithTheStatusTests(unittest.TestCase):
    """status='complete' with completedAt=null is the shape that made the bug
    invisible for a month. The row builder must not be able to produce it."""

    def test_complete_carries_a_stamp(self):
        row = supabase_tasks._task_row("u1", {
            "id": "t1", "text": "x", "date": "2026-09-10", "status": "complete",
        })
        self.assertTrue(row["completedAt"], "complete with no completedAt")

    def test_an_app_supplied_stamp_is_kept(self):
        row = supabase_tasks._task_row("u1", {
            "id": "t1", "text": "x", "date": "2026-09-10",
            "status": "complete", "completedAt": 1788673252756,
        })
        self.assertEqual(row["completedAt"], 1788673252756)

    def test_not_complete_clears_the_stamp(self):
        row = supabase_tasks._task_row("u1", {
            "id": "t1", "text": "x", "date": "2026-09-10",
            "status": "pending", "completedAt": 1788673252756,
        })
        self.assertIsNone(row["completedAt"])


if __name__ == "__main__":
    unittest.main()


class AgentPatchPairsStatusWithStampTests(unittest.TestCase):
    """The other door into the same bug: completing over WhatsApp went through
    a PATCH that wrote `status` and nothing else."""

    def _patched_body(self, patch_dict):
        seen = {}

        class _Resp:
            status_code = 200

        class _Client:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *a):
                return False

            async def patch(self_inner, url, headers=None, params=None, json=None):
                seen.update(json or {})
                return _Resp()

        with patch.object(supabase_tasks, "_enabled", lambda: True), \
             patch.object(supabase_tasks.httpx, "AsyncClient", lambda **kw: _Client()):
            asyncio.run(supabase_tasks.update_task("u1", "t1", patch_dict))
        return seen

    def test_completing_over_whatsapp_stamps_completedAt(self):
        body = self._patched_body({"status": "complete"})
        self.assertEqual(body["status"], "complete")
        self.assertTrue(body["completedAt"], "complete with no completedAt")

    def test_reopening_over_whatsapp_clears_the_stamp(self):
        body = self._patched_body({"status": "pending"})
        self.assertIsNone(body["completedAt"])

    def test_a_patch_that_does_not_touch_status_leaves_the_stamp_alone(self):
        body = self._patched_body({"text": "renamed"})
        self.assertNotIn("completedAt", body)


class HereStampTests(unittest.TestCase):
    """Where she is, as a user-turn prefix. The system prompt is cache-shaped
    and cannot carry a per-turn fact, so this rides beside the clock."""

    def test_a_fix_with_a_label_reads_as_a_place(self):
        import agent_turn
        s = agent_turn._here_stamp({"lat": 32.0853, "lng": 34.7818, "label": "דיזנגוף 50"})
        self.assertIn("דיזנגוף 50", s)
        self.assertIn("32.085", s)
        self.assertNotIn("32.0853", s)   # ~100 m, never the door (7.10 privacy)

    def test_a_bare_fix_still_gives_an_origin(self):
        import agent_turn
        self.assertIn("32.085,34.782", agent_turn._here_stamp({"lat": 32.0853, "lng": 34.7818}))

    def test_nothing_is_claimed_without_a_fix(self):
        import agent_turn
        for bad in (None, {}, {"lat": "x", "lng": 1}, {"lat": 999, "lng": 0}, {"lng": 3}, "here"):
            self.assertEqual(agent_turn._here_stamp(bad), "", repr(bad))
