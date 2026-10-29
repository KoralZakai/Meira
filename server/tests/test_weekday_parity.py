"""The server reads a routine's days by the ONE spec the phone reads them by.

tests/fixtures/weekday-lines.json (repo root) is hand-written: each expected
value is what she meant. The phone half is tests/run-weekday-parity.ts.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import routine_match

_FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "weekday-lines.json")


class WeekdaySpec(unittest.TestCase):
    def test_every_line_reads_as_she_meant(self):
        with open(_FIXTURE, encoding="utf-8") as fh:
            cases = json.load(fh)["cases"]
        for c in cases:
            with self.subTest(text=c["text"]):
                got = routine_match.read_days(c["text"])
                self.assertEqual(got["days"], c["days"])
                self.assertEqual(got["from"], c["from"])
                self.assertEqual(got.get("per_week"), c.get("perWeek"))

    def test_every_answer_reads_back_as_the_days_chosen(self):
        for mask in range(1, 128):
            days = [d for d in range(7) if mask & (1 << d)]
            for base in ("קיקבוקס 20:30-21:30 יגאל אלון 94", "climbing 19:00 Space Gym"):
                line = routine_match.with_days(base, days)
                with self.subTest(line=line):
                    self.assertNotIn(",", line)
                    self.assertEqual(routine_match.read_days(line), {"days": days, "from": "said"})
                    self.assertEqual(routine_match.strip_days_phrase(line), base)

    def test_the_same_phrase_as_the_phone(self):
        # Spot values copied from src/utils/routines.ts daysPhrase.
        self.assertEqual(routine_match.days_phrase([2], "he"), "· ימי ג׳")
        self.assertEqual(routine_match.days_phrase([1, 3], "he"), "· ימי ב׳ ו-ד׳")
        self.assertEqual(routine_match.days_phrase([0, 1, 2, 3, 4], "he"), "· ימי א׳–ה׳")
        self.assertEqual(routine_match.days_phrase([1, 3], "en"), "· Mon & Wed")
        self.assertEqual(routine_match.days_phrase([0, 2, 4], "en"), "· Sun/Tue/Thu")
        self.assertEqual(routine_match.days_phrase("varies", "he"), "· ימים משתנים")

    def test_the_place_is_still_found_after_the_days_are_written_in(self):
        line = routine_match.with_days("קיקבוקס 20:30-21:30 יגאל אלון 94", [2])
        entry = routine_match.parse(line)[0]
        self.assertEqual(entry["weekdays"], [2])
        self.assertEqual(entry["days_from"], "said")
        self.assertIn("יגאל אלון 94", entry.get("address", ""))
        self.assertNotIn("ימי", entry.get("address", ""))


if __name__ == "__main__":
    unittest.main()
