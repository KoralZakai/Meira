"""nudge_slots tests — deterministic check-in times for 'nudge me today'."""
import unittest
from datetime import datetime

from reminders import nudge_slots
from tz import IL


def _il(h, m):
    return datetime(2026, 7, 23, h, m, tzinfo=IL)


class NudgeSlotsTests(unittest.TestCase):
    def test_late_morning(self):
        # 11:25 → first slot 12:00 (11:45 rounds up), then every 90 min.
        self.assertEqual(nudge_slots(_il(11, 25)),
                         ["12:00", "13:30", "15:00", "16:30", "18:00", "19:30"])

    def test_round_to_half_hour(self):
        # 11:05 +20 = 11:25 → rounds to 11:30.
        self.assertEqual(nudge_slots(_il(11, 5))[0], "11:30")

    def test_exact_slot_kept(self):
        # 10:40 +20 = 11:00 exactly — kept as-is.
        self.assertEqual(nudge_slots(_il(10, 40))[0], "11:00")

    def test_evening_cutoff(self):
        # 19:20 → only 20:00 fits.
        self.assertEqual(nudge_slots(_il(19, 20)), ["20:00"])

    def test_too_late_empty(self):
        self.assertEqual(nudge_slots(_il(21, 0)), [])


if __name__ == "__main__":
    unittest.main()
