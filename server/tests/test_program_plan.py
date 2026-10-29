"""program_plan — 29.10 live: five tasks titled with her own sentence."""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import program_plan as pp  # noqa: E402


class Program(unittest.TestCase):
    def test_recognised(self):
        self.assertTrue(pp.PROGRAM_RE.search("i want to improve my self confident build me a program"))
        self.assertTrue(pp.PROGRAM_RE.search("תבני לי תוכנית לביטחון עצמי"))
        self.assertFalse(pp.PROGRAM_RE.search("what's on my program today?"))

    def test_steps_are_actions_not_her_sentence(self):
        name, steps = pp.steps_from({"name": "Confidence", "steps": [
            {"title": "Say one opinion in a meeting", "minutes": 300, "part": "noon"},
            {"title": "", "minutes": 10}, {"title": "Record a 2-min intro", "part": "bogus"}]})
        self.assertEqual(name, "Confidence")
        self.assertEqual([s["title"] for s in steps], ["Say one opinion in a meeting", "Record a 2-min intro"])
        self.assertEqual(steps[0]["minutes"], 90)
        self.assertEqual(steps[1]["part"], "evening")

    def test_one_step_a_day_never_on_a_closed_day(self):
        steps = [{"title": f"s{i}", "minutes": 20, "part": "evening"} for i in range(3)]
        closed = {"2026-10-31"}
        out = pp.schedule(steps, [], date(2026, 10, 30), lambda iso: iso in closed,
                          lambda tasks, iso, m, w: w[0])
        self.assertEqual([iso for _, iso, _ in out], ["2026-10-30", "2026-11-01", "2026-11-02"])
        self.assertTrue(all(h == "18:00" for _, _, h in out))


if __name__ == "__main__":
    unittest.main()
