"""history_stats — her numbers are counted by code, and said firmly.

Pure: no I/O. 2026-10-20 is a Tuesday; Israel's week starts Sunday 18.10.
"""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import history_stats as h  # noqa: E402

TODAY = date(2026, 10, 20)


def t(id_, day, text, cat="general", status="complete", **kw):
    return {"id": id_, "date": day, "text": text, "category": cat, "status": status, **kw}


TASKS = [
    t("g1", "2026-10-18", "אימון כוח", "gym"),
    t("g2", "2026-10-19", "kickbox", "hobby_class"),
    t("g3", "2026-10-20", "Gym", "gym", status="pending"),          # not done → not counted
    t("g4", "2026-10-13", "ריצה בפארק", "general"),                  # last week
    t("s1", "2026-10-19", "ללמוד למבחן", "general", durationMinutes=90),
    t("s2", "2026-10-20", "Course: ML", "course", durationMinutes=60, actualDurationMinutes=75),
    t("r1", "2026-10-19", "ראיון בחיפה", "interview",
      location={"travelMinutes": 70}),
    t("r2", "2026-10-20", "רופא", "doctor", location={"travelMinutes": 20}),
    t("m1", "2026-10-19", "לסדר ארון", status="missed"),
    t("x1", "2026-10-11", "something", "general"),                  # last week, done
]
EVENTS = [
    {"kind": "trip", "taskId": "r1", "day": "2026-10-19", "minutes": 95},       # real beats planned
    {"kind": "study", "taskId": "s1", "day": "2026-10-19", "minutes": 50},      # session beats plan
    {"kind": "moved", "taskId": "d1", "day": "2026-10-18", "text": "לשלוח דוח"},
    {"kind": "moved", "taskId": "d1", "day": "2026-10-19", "text": "לשלוח דוח"},
    {"kind": "moved", "taskId": "d1", "day": "2026-10-20", "text": "לשלוח דוח"},
    {"kind": "moved", "taskId": "d2", "day": "2026-10-12", "text": "old"},       # last week
]


class Periods(unittest.TestCase):
    def test_this_week_starts_sunday(self):
        p = h.period("this week", TODAY)
        self.assertEqual((p["from"], p["to"]), ("2026-10-18", "2026-10-20"))
        self.assertEqual((p["prev_from"], p["prev_to"]), ("2026-10-11", "2026-10-13"))

    def test_hebrew_last_week(self):
        p = h.period("כמה התאמנתי בשבוע שעבר", TODAY)
        self.assertEqual((p["from"], p["to"], p["label"]), ("2026-10-11", "2026-10-17", "last_week"))

    def test_this_month_and_last_month(self):
        self.assertEqual(h.period("החודש", TODAY)["from"], "2026-10-01")
        p = h.period("last month", TODAY)
        self.assertEqual((p["from"], p["to"]), ("2026-09-01", "2026-09-30"))

    def test_last_n_days_is_capped_at_90(self):
        self.assertEqual(h.period("last 400 days", TODAY)["label"], "last_90_days")

    def test_unknown_words_say_this_week(self):
        self.assertEqual(h.period("blah", TODAY)["label"], "this_week_default")


class Numbers(unittest.TestCase):
    def setUp(self):
        self.rep = h.week_report(TASKS, EVENTS, TODAY, "this week")
        self.cur, self.prev = self.rep["current"], self.rep["previous"]

    def test_workouts_count_only_done_ones(self):
        self.assertEqual(self.cur["workouts"], 2)
        self.assertEqual(self.prev["workouts"], 1)

    def test_learning_prefers_the_session_and_the_actual_minutes(self):
        self.assertEqual(self.cur["learning_minutes"], 50 + 75)

    def test_road_prefers_the_real_trip_and_flags_an_estimate(self):
        self.assertEqual(self.cur["road_minutes"], 95 + 20)
        self.assertTrue(self.cur["road_estimated"])

    def test_every_move_counts_not_only_the_last(self):
        self.assertEqual(self.cur["reschedules"], 3)
        self.assertEqual(self.cur["most_moved"][0]["moves"], 3)
        self.assertEqual(self.prev["reschedules"], 1)

    def test_completion_rate(self):
        self.assertEqual(self.cur["completed"], 6)
        self.assertEqual(self.cur["missed"], 1)
        self.assertEqual(self.cur["completion_rate"], round(6 / 7, 2))

    def test_an_empty_week_is_zero_not_none(self):
        empty = h.compute([], [], "2026-10-18", "2026-10-20")
        self.assertEqual(empty["workouts"], 0)
        self.assertIsNone(empty["completion_rate"])


class Questions(unittest.TestCase):
    def test_metric_for(self):
        cases = {"כמה פעמים התאמנתי השבוע?": "workouts",
                 "how much did I study this month": "learning_minutes",
                 "כמה זמן הייתי בכביש?": "road_minutes",
                 "how often did I reschedule": "reschedules",
                 "how many times did I see Dana": None}
        for q, want in cases.items():
            self.assertEqual(h.metric_for(q), want, q)

    def test_a_history_question_is_not_a_route_or_an_add(self):
        self.assertTrue(h.is_history_question("כמה פעמים התאמנתי השבוע?"))
        self.assertTrue(h.is_history_question("How many hours did I spend on the road?"))
        self.assertFalse(h.is_history_question("how long is the drive to Haifa?"))
        self.assertFalse(h.is_history_question("תוסיפי אימון מחר ב-7"))


class Saying(unittest.TestCase):
    def setUp(self):
        self.rep = h.week_report(TASKS, EVENTS, TODAY, "this week")

    def test_the_number_and_the_comparison_in_both_languages(self):
        he = h.say("workouts", self.rep, True)
        en = h.say("workouts", self.rep, False)
        self.assertIn("2 אימונים", he)
        self.assertIn("לפני כן: 1", he)
        self.assertIn("2 workouts", en)
        self.assertIn("before: 1", en)

    def test_a_target_names_the_gap_and_asks_to_book(self):
        line = h.say("workouts", self.rep, True, target=3)
        self.assertIn("עוד 1", line)
        self.assertIn("משבצים", line)
        self.assertIn("Goal hit", h.say("workouts", self.rep, False, target=2))

    def test_an_estimated_road_time_is_marked(self):
        self.assertIn("~", h.say("road_minutes", self.rep, False))

    def test_coach_picks_the_biggest_gap(self):
        line = h.coach_line(self.rep, {"workouts": 4, "learning_minutes": 130}, he=False)
        self.assertIn("Workouts: 2/4", line)

    def test_coach_falls_back_to_the_reschedule_streak(self):
        line = h.coach_line(self.rep, {}, he=True)
        self.assertIn("נדחה 3 פעמים", line)

    def test_coach_is_silent_when_nothing_to_push(self):
        rep = h.week_report([], [], TODAY)
        self.assertIsNone(h.coach_line(rep, {}, he=True))


if __name__ == "__main__":
    unittest.main()
