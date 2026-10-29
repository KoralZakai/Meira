"""Conversation focus (session.py) — follow-ups resolve to the task in focus.

Reproduces the bug: 'from home, by bus' about Thursday's interview was routed to
tonight's party (the soonest located task). With a focus set on the interview,
the mode reply resolves to the interview instead.
"""
import os
import tempfile
import unittest
from unittest import mock

import session


class SessionStoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._p = mock.patch.object(session, "_PATH", os.path.join(self._tmp, "s.json"))
        self._p.start()

    def tearDown(self):
        self._p.stop()

    def test_set_get_clear(self):
        session.set_active_task("972", "task-A", dest="MER Group")
        self.assertEqual(session.get_active_task_id("972"), "task-A")
        session.clear_active_task("972")
        self.assertIsNone(session.get_active_task_id("972"))

    def test_none_id_is_noop(self):
        session.set_active_task("972", None)
        self.assertIsNone(session.get_active_task_id("972"))

    def test_expired_focus_ignored(self):
        session.set_active_task("972", "task-A")
        # force the stored timestamp far into the past
        data = session._load()
        data["972"]["at"] = 0
        session._save(data)
        self.assertIsNone(session.get_active_task_id("972"))

    def test_phone_format_tolerant(self):
        session.set_active_task("+972-54-290-2729", "task-Z")
        self.assertEqual(session.get_active_task_id("972542902729"), "task-Z")


if __name__ == "__main__":
    unittest.main()
