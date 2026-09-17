"""agent_runner._upcoming_tasks — briefings surface soon tasks, not only today."""
import unittest
from unittest import mock

import agent_runner
import user_memory

_STORE = [
    {"date": "2026-08-03", "fixed_time": None, "status": "pending", "text": "today task"},
    {"date": "2026-08-04", "fixed_time": "11:00", "status": "pending", "text": "interview Meta"},
    {"date": "2026-08-05", "fixed_time": "18:00", "status": "pending", "text": "party"},
    {"date": "2026-07-10", "fixed_time": None, "status": "pending", "text": "old past"},
    {"date": "2026-08-06", "fixed_time": None, "status": "moved", "text": "moved out"},
    {"date": "2026-08-20", "fixed_time": None, "status": "pending", "text": "far future"},
]


class UpcomingTasksTests(unittest.TestCase):
    def setUp(self):
        self._p = mock.patch.object(user_memory, "tasks_for_phone", return_value=_STORE)
        self._p.start()

    def tearDown(self):
        self._p.stop()

    def test_today_excludes_future_and_past(self):
        got = [t["text"] for t in agent_runner._today_tasks("x", "2026-08-03")]
        self.assertEqual(got, ["today task"])

    def test_upcoming_is_next_days_only(self):
        got = [t["text"] for t in agent_runner._upcoming_tasks("x", "2026-08-03", days=7)]
        # tomorrow + Tuesday, in date order; excludes today, past, moved, and >7d
        self.assertEqual(got, ["interview Meta", "party"])

    def test_upcoming_excludes_moved_and_beyond_window(self):
        got = [t["text"] for t in agent_runner._upcoming_tasks("x", "2026-08-03", days=7)]
        self.assertNotIn("moved out", got)
        self.assertNotIn("far future", got)
        self.assertNotIn("old past", got)


if __name__ == "__main__":
    unittest.main()
