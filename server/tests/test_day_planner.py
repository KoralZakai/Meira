"""day_planner — flexible tasks go into time that is really free.

The scenario this exists for, in her words:

    "I must work today on Meira for the hackathon, also study for the next
     interview in Ceva (the second interview)."

The day already holds that interview at 14:30 in Airport City, with a leave
time of 13:40. The work has to land somewhere that does not collide with the
journey, and the study has to END before she walks out of the door. The old
cursor (day_schedule) would have put a 3-hour study block straight through it.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import day_planner  # noqa: E402
from day_planner import plan_day  # noqa: E402


def m(hhmm: str) -> int:
    h, mm = hhmm.split(":")
    return int(h) * 60 + int(mm)


INTERVIEW = {
    "id": "gcal-ceva-2", "text": "Ceva — second interview", "category": "interview",
    "priority": "must", "fixed_time": "14:30", "duration_minutes": 60, "status": "pending",
    "location": {"address": "Airport City", "leaveHomeBy": "13:40", "travelMinutes": 45},
}
WORK = {"id": "t-meira", "text": "Work on the Meira app for the hackathon", "category": "work",
        "priority": "must", "duration_minutes": 180, "status": "pending"}
PREP = {"id": "t-prep", "text": "Study for the Ceva interview", "category": "interview",
        "priority": "must", "duration_minutes": 90, "status": "pending",
        "prepForTaskId": "gcal-ceva-2"}


def by_id(result: dict) -> dict:
    return {p["id"]: p for p in result["placed"]}


def overlaps(a0, a1, b0, b1) -> bool:
    return a0 < b1 and b0 < a1


class CevaScenarioTest(unittest.TestCase):
    def setUp(self):
        self.result = plan_day([INTERVIEW, WORK, PREP], wake_time="07:30",
                               sleep_time="23:00", now="08:05")
        self.placed = by_id(self.result)

    def test_both_tasks_get_a_time(self):
        self.assertEqual(set(self.placed), {"t-meira", "t-prep"}, self.result)
        self.assertEqual(self.result["unplaced"], [])

    def test_nothing_starts_before_now(self):
        for p in self.placed.values():
            self.assertGreaterEqual(m(p["start"]), m("08:15"), p)   # 08:05 rounded up

    def test_study_ends_before_she_has_to_leave(self):
        prep = self.placed["t-prep"]
        self.assertLessEqual(m(prep["end"]) + day_planner.BUFFER_MINUTES, m("13:40"), prep)

    def test_no_block_touches_the_journey_or_the_interview(self):
        # Busy from the leave time until she is home again (45 min back).
        busy = (m("13:40"), m("15:30") + 45)
        for p in self.placed.values():
            self.assertFalse(overlaps(m(p["start"]), m(p["end"]), *busy), p)

    def test_blocks_do_not_overlap_and_keep_a_buffer(self):
        spans = sorted((m(p["start"]), m(p["end"])) for p in self.placed.values())
        for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
            self.assertGreaterEqual(b0 - a1, day_planner.BUFFER_MINUTES)

    def test_the_old_cursor_would_have_collided(self):
        """Pin the bug this replaces: day_schedule walks a cursor, blind to gaps."""
        import day_schedule
        # A calendar import ranked below her own "must": the old builder sorts
        # the must first and walks its cursor from now, blind to the journey.
        imported = dict(INTERVIEW, priority="have_to")
        old = {t["text"]: t for t in day_schedule.build_day_schedule(
            [imported, WORK, PREP], "07:30", now="12:40")}
        study = old["Study for the Ceva interview"]
        start = m(study["scheduled_time"])
        end = start + day_schedule.duration_of(study)
        self.assertTrue(overlaps(start, end, m("13:40"), m("16:15")),
                        "if this fails, the old builder learned about gaps — revisit this module")


class KindsTest(unittest.TestCase):
    def test_calls_go_to_the_end_of_the_day(self):
        call = {"id": "c", "text": "Call mom", "category": "call", "priority": "need_to",
                "duration_minutes": 15}
        r = plan_day([call], wake_time="08:00", sleep_time="22:00")
        self.assertEqual(r["placed"][0]["end"], "22:00")
        self.assertEqual(r["placed"][0]["why"], "end_of_day")

    def test_gym_comes_after_the_work_block(self):
        work = {"id": "w", "text": "Deep work", "category": "work", "priority": "have_to",
                "duration_minutes": 120}
        gym = {"id": "g", "text": "Gym", "category": "gym", "priority": "have_to",
               "duration_minutes": 60}
        r = by_id(plan_day([gym, work], wake_time="08:00", sleep_time="22:00"))
        self.assertGreaterEqual(m(r["g"]["start"]), m(r["w"]["end"]))
        self.assertEqual(r["g"]["why"], "after_work_block")

    def test_must_is_placed_before_nice_to_do(self):
        # One free hour: the must gets it.
        wall = {"id": "x", "text": "Shift", "category": "work", "fixed_time": "09:10",
                "duration_minutes": 710}
        must = {"id": "a", "text": "Pay the bill", "priority": "must", "duration_minutes": 45}
        nice = {"id": "b", "text": "Browse", "priority": "nice_to_do", "duration_minutes": 45}
        r = plan_day([nice, must, wall], wake_time="08:00", sleep_time="21:30")
        self.assertIn("a", by_id(r))
        self.assertEqual([u["id"] for u in r["unplaced"]], ["b"])


class SlotsTest(unittest.TestCase):
    def test_a_slot_still_ahead_is_kept_and_blocks_others(self):
        pinned = {"id": "p", "text": "Read", "scheduled_time": "10:00", "duration_minutes": 60}
        new = {"id": "n", "text": "Errand", "duration_minutes": 90}
        r = plan_day([pinned, new], wake_time="09:00", sleep_time="22:00", now="08:00")
        self.assertNotIn("p", by_id(r), "a kept slot is not re-placed")
        n = by_id(r)["n"]
        self.assertFalse(overlaps(m(n["start"]), m(n["end"]), m("10:00") - 10, m("11:00") + 10))

    def test_a_slot_that_has_gone_is_placed_again(self):
        stale = {"id": "s", "text": "Laundry", "scheduled_time": "07:00", "duration_minutes": 30}
        r = plan_day([stale], wake_time="07:00", sleep_time="22:00", now="11:50")
        self.assertEqual(by_id(r)["s"]["start"], "12:00")

    def test_a_video_call_needs_no_journey(self):
        zoom = {"id": "z", "text": "Standup", "category": "zoom", "fixed_time": "10:00",
                "duration_minutes": 30, "location": {"address": "https://zoom.us/j/1",
                                                     "travelMinutes": 40}}
        task = {"id": "t", "text": "Write", "duration_minutes": 30}
        r = plan_day([zoom, task], wake_time="09:40", sleep_time="11:15", now="08:00")
        # Only the time after the call is free. Had its 40 "travel" minutes
        # counted, there would be no window at all.
        self.assertEqual(by_id(r)["t"]["start"], "10:40")

    def test_completed_tasks_do_not_block(self):
        done = {"id": "d", "text": "Done early", "scheduled_time": "10:00",
                "duration_minutes": 600, "status": "complete"}
        task = {"id": "t", "text": "Next", "duration_minutes": 60}
        r = plan_day([done, task], wake_time="10:00", sleep_time="22:00")
        self.assertEqual(by_id(r)["t"]["start"], "10:00")


class HonestyTest(unittest.TestCase):
    def test_study_shrinks_to_the_window_and_says_so(self):
        wall = {"id": "x", "text": "Shift", "fixed_time": "10:00", "duration_minutes": 700}
        study = {"id": "s", "text": "Study for the exam", "category": "course",
                 "priority": "must", "duration_minutes": 120}
        r = by_id(plan_day([wall, study], wake_time="08:00", sleep_time="22:00"))
        self.assertEqual(r["s"]["why"], "shortened")
        self.assertEqual(r["s"]["shortened_from"], 180)
        self.assertLessEqual(m(r["s"]["end"]), m("09:50"))

    def test_what_does_not_fit_is_returned_with_the_reason(self):
        wall = {"id": "x", "text": "Shift", "fixed_time": "08:20", "duration_minutes": 800}
        task = {"id": "t", "text": "Paint the fence", "priority": "need_to", "duration_minutes": 120}
        r = plan_day([wall, task], wake_time="08:00", sleep_time="22:00")
        self.assertEqual(r["placed"], [])
        self.assertEqual(r["unplaced"][0]["why"], "no_window")
        self.assertEqual(r["unplaced"][0]["need"], 120)

    def test_after_bedtime_the_day_is_over(self):
        task = {"id": "t", "text": "Anything", "duration_minutes": 30}
        r = plan_day([task], wake_time="08:00", sleep_time="22:00", now="22:30")
        self.assertEqual(r["unplaced"][0]["why"], "day_over")

    def test_a_deadline_that_has_passed_is_named(self):
        task = {"id": "t", "text": "Submit form", "date": "2099-01-04", "deadline": "2099-01-04",
                "deadlineTime": "09:00", "duration_minutes": 30, "priority": "have_to"}
        r = plan_day([task], wake_time="08:00", sleep_time="22:00", now="12:00")
        self.assertEqual(r["unplaced"][0]["why"], "past_deadline")

    def test_nothing_is_placed_past_sleep(self):
        tasks = [{"id": f"t{i}", "text": f"Task {i}", "duration_minutes": 60} for i in range(20)]
        r = plan_day(tasks, wake_time="08:00", sleep_time="22:00")
        for p in r["placed"]:
            self.assertLessEqual(m(p["end"]), m("22:00"))
        self.assertEqual(len(r["placed"]) + len(r["unplaced"]), 20)

    def test_sleep_after_midnight_is_tonight(self):
        task = {"id": "t", "text": "Late work", "duration_minutes": 60}
        r = plan_day([task], wake_time="09:00", sleep_time="00:30", now="23:10")
        self.assertEqual(by_id(r)["t"]["start"], "23:15")


if __name__ == "__main__":
    unittest.main()
