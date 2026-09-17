"""_reminder_subject — a check-in never attaches to a stale past task."""
import unittest
from unittest import mock

import main
import user_memory

TODAY = "2026-08-04"
_STORE = [
    {"date": "2026-07-10", "fixed_time": "09:30", "status": "pending",
     "text": "שיעור ב-9:30 באוניברסיטת תל אביב"},          # old — must never win
    {"date": "2026-08-04", "fixed_time": "18:00", "status": "pending",
     "text": "מסיבת סיום קורס בנביוס"},                      # today — the real subject
    {"date": "2026-08-06", "fixed_time": "11:00", "status": "pending",
     "text": "ראיון עבודה ב-MER Group"},                    # future
]


class ReminderSubjectTests(unittest.TestCase):
    def setUp(self):
        self._p1 = mock.patch.object(user_memory, "tasks_for_phone", return_value=_STORE)
        self._p2 = mock.patch("tz.today_il")
        self._p1.start()
        m = self._p2.start()
        from datetime import date
        m.return_value = date(2026, 8, 4)

    def tearDown(self):
        self._p1.stop()
        self._p2.stop()

    def test_leave_reminder_picks_todays_task_not_old_class(self):
        subj = main._reminder_subject("972", "תזכירי לי בבקשה 17:30 לצאת", "he")
        self.assertIn("מסיבת סיום", subj)
        self.assertNotIn("אוניברסיטת", subj)   # the July class is excluded

    def test_no_future_tasks_gives_generic(self):
        with mock.patch.object(user_memory, "tasks_for_phone",
                               return_value=[{"date": "2026-07-01", "status": "pending",
                                              "text": "old"}]):
            self.assertEqual(main._reminder_subject("972", "תזכירי לי 17:30", "he"), "המשימה שלך")


if __name__ == "__main__":
    unittest.main()
