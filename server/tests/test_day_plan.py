"""day_plan — what Meira says about a day, whether or not the phone routed it.

The evening of 29.9 Meira was asked about Wednesday and answered with a leave
time for the dentist only, nothing for the other five events, and no word
about Nebius (Azrieli, until 12:00) → coffee with Dana (Herzliya, 12:15): the
phone had not routed Wednesday yet, and an unrouted leg counted as 15 minutes —
exactly the gap. These tests replay that evening with no stored routes and a
fake `plan_leg` in place of Google.
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import day_plan  # noqa: E402

DATE = "2026-09-30"
HOME = "Mordei ha-Geta'ot St 21, Tel Aviv-Yafo"


def row(id_, text, time, minutes, category, address=None, **extra):
    r = {"id": id_, "text": text, "fixed_time": time, "duration_minutes": minutes,
         "category": category, "date": DATE, "status": "pending", **extra}
    if address:
        r["location"] = {"address": address}
    return r


def wednesday():
    """30.9 as the server had it on the evening of the 29th: no routes at all."""
    return [
        row("dentist", "Dentist — Dr. Levi", "09:30", 45, "doctor", "Ibn Gabirol St 120, Tel Aviv-Yafo",
            source="calendar"),
        row("plan", "לעשות תכנית עסקית", "18:30", 122, "general"),
        row("nebius", "Meeting — Nebius team", "11:00", 60, "meeting",
            "Azrieli Center, Derech Menachem Begin 132, Tel Aviv-Yafo", source="calendar"),
        row("dana", "Coffee with Dana", "12:15", 45, "meeting", "Herzliya Pituah Marina, Herzliya",
            source="calendar"),
        row("concert", "הופעה של כנסיית השכל", "21:00", 60, "conference", source="calendar"),
        row("yoga", "Yoga class", "16:00", 60, "gym", "Dizengoff Center, Dizengoff St 50, Tel Aviv-Yafo",
            source="calendar"),
        row("meetup", "AI Performance Engineering meetup", "18:30", 90, "call",
            "Sarona Market, Kalman Magen St 3, Tel Aviv-Yafo", source="calendar"),
    ]


#: Minutes by her usual mode, keyed by a word of the destination; car probes apart.
USUAL = {"Ibn Gabirol": 18, "Azrieli": 20, "Herzliya": 54, "Dizengoff": 47, "Sarona": 18}
CAR = {"Herzliya": 26}


class FakeLegs:
    def __init__(self, fail=()):
        self.calls = []
        self.fail = set(fail)

    async def __call__(self, dest, arrive, date, start, transport):
        self.calls.append((dest, arrive, date, start, transport))
        word = next(k for k in USUAL if k in dest)
        if word in self.fail:
            return {"ok": False, "need": "destination", "message": f"Couldn't locate '{dest}'."}
        minutes = (CAR if transport == "car" else USUAL)[word]
        h, m = map(int, arrive.split(":"))
        leave = h * 60 + m - minutes - 10
        return {"plan": {"travelMinutes": minutes, "leaveHomeBy": f"{leave // 60:02d}:{leave % 60:02d}",
                         "transport": transport or "bike"}}


def plan(rows, legs=None, **kw):
    day_plan._CACHE.clear()
    return asyncio.run(day_plan.plan_day(rows, date=DATE, home=HOME, plan_leg=legs, **kw))


class EveryEventGetsAnAnswer(unittest.TestCase):
    def test_every_trip_has_a_leave_time_even_with_nothing_routed(self):
        out = plan(wednesday(), FakeLegs())
        by_id = {e["id"]: e for e in out["events"]}
        for trip in ("dentist", "nebius", "dana", "yoga", "meetup"):
            self.assertIn("leave_by", by_id[trip], f"{trip}: no leave time")
            self.assertEqual(by_id[trip]["source"], "meira")
        self.assertEqual(by_id["dentist"]["leave_by"], "09:02")      # 09:30 − 18 − 10

    def test_an_event_without_one_says_why(self):
        by_id = {e["id"]: e for e in plan(wednesday(), FakeLegs())["events"]}
        self.assertEqual(by_id["concert"]["no_leave_reason"], "no_place")
        self.assertTrue(by_id["plan"].get("flexible"), "her own work has no journey to plan")

    def test_a_failed_route_is_a_reason_not_a_blank(self):
        by_id = {e["id"]: e for e in plan(wednesday(), FakeLegs(fail={"Dizengoff"}))["events"]}
        self.assertNotIn("leave_by", by_id["yoga"])
        self.assertTrue(by_id["yoga"]["no_leave_reason"].startswith("route_failed"))

    def test_each_trip_starts_where_the_previous_one_was(self):
        legs = FakeLegs()
        plan(wednesday(), legs)
        starts = {dest.split(",")[0]: start for dest, _, _, start, transport in legs.calls if not transport}
        self.assertIsNone(starts["Ibn Gabirol St 120"], "the first trip starts at home / where she is")
        self.assertEqual(starts["Herzliya Pituah Marina"],
                         "Azrieli Center, Derech Menachem Begin 132, Tel Aviv-Yafo")

    def test_the_phones_route_wins_and_is_not_asked_again(self):
        rows = wednesday()
        rows[0]["location"].update({"leaveHomeBy": "09:21", "travelMinutes": 25, "wakeUpBy": "07:53",
                                    "transitPlan": {"legs": [{"type": "walk"}, {"type": "bus", "lineNumber": "3"}]}})
        legs = FakeLegs()
        out = plan(rows, legs)
        self.assertFalse(any("Ibn Gabirol" in c[0] for c in legs.calls), "a routed leg was routed again")
        dentist = next(e for e in out["events"] if e["id"] == "dentist")
        self.assertEqual((dentist["leave_by"], dentist["source"], dentist["route"]), ("09:21", "phone", "bus 3"))
        self.assertEqual(out["wake_by"], "07:53", "the phone's wake time for the first trip wins")
        self.assertEqual(len(day_plan.unrouted(rows)), 4)
        self.assertEqual(day_plan.unrouted([rows[0]]), [])


class OneWakeTime(unittest.TestCase):
    def test_the_day_wakes_once_from_the_first_trip(self):
        out = plan(wednesday(), FakeLegs(), routine_minutes=45)
        self.assertEqual(out["wake_by"], "08:17")                     # 09:02 − 45
        self.assertTrue(all("wake_by" not in e for e in out["events"]),
                        "a wake time per task said 'wake at 17:27' for an 18:30 meetup")

    def test_a_task_at_home_wakes_her_too(self):
        # 3.10: a prep block picked at 08:40 (her own hour, no place) before a 15:30 interview.
        rows = [row("prep", "Prepare for: Ceva", None, 300, "course", scheduled_time="08:40"),
                row("ceva", "Interview with Ceva", "15:30", 120, "interview", "7 HaPnina St, Ra'anana")]
        self.assertEqual(plan(rows, FakeLegs(), routine_minutes=35)["wake_by"], "08:05")

    def test_a_wake_time_that_has_gone_is_not_offered(self):
        self.assertIsNone(plan(wednesday(), FakeLegs(), now="09:02")["wake_by"])


class TheProblemsMeiraMissed(unittest.TestCase):
    def test_nebius_to_dana_is_found_with_no_route_stored(self):
        out = plan(wednesday(), FakeLegs())
        travel = [p for p in out["problems"] if p["kind"] == "travel"]
        self.assertEqual(len(travel), 1, out["problems"])
        p = travel[0]
        self.assertEqual((p["first"]["id"], p["second"]["id"]), ("nebius", "dana"))
        self.assertEqual((p["travel_minutes"], p["late_by"], p["arrive_at"], p["ask_for"]),
                         (54, 39, "12:54", "13:00"))
        self.assertEqual(p["faster"], {"mode": "car", "travel_minutes": 26, "arrive_at": "12:26", "late_by": 11})

    def test_the_car_probe_is_never_her_choice(self):
        legs = FakeLegs()
        plan(wednesday(), legs)
        probes = [c for c in legs.calls if c[4]]
        self.assertEqual([c[4] for c in probes], ["car"])
        self.assertEqual(probes[0][3], "Azrieli Center, Derech Menachem Begin 132, Tel Aviv-Yafo",
                         "the probe starts where the first meeting is")

    def test_the_business_plan_over_the_meetup_is_an_overlap_with_somewhere_to_go(self):
        out = plan(wednesday(), FakeLegs())
        [p] = [p for p in out["problems"] if p["kind"] == "overlap"]
        self.assertEqual((p["work"]["id"], p["fixed"]["id"]), ("plan", "meetup"))
        self.assertEqual(p["moves_to"], "13:00", "the first window the whole 2h fits, counted to the yoga ride")

    def test_nothing_else_is_called_a_problem(self):
        kinds = sorted(p["kind"] for p in plan(wednesday(), FakeLegs())["problems"])
        self.assertEqual(kinds, ["overlap", "travel"])

    def test_no_room_left_today_means_tomorrow(self):
        out = plan(wednesday(), FakeLegs(), now="14:10")
        [p] = [p for p in out["problems"] if p["kind"] == "overlap"]
        self.assertEqual(p["moves_to"], "tomorrow")


if __name__ == "__main__":
    unittest.main()


def test_a_day_read_goes_the_way_the_phone_does():
    """1.10: the phone planned yoga by bike (7 min), get_my_day said train — the
    agent tool's mode is learned from the CONVERSATION, and a day read has none.
    The leg now takes the task's own mode, else the profile's."""
    import asyncio
    import geo
    seen = []

    async def fake(**kw):
        seen.append(kw["transport"])
        return {"ok": True, "plan": {"leaveHomeBy": "10:43", "travelMinutes": 7}}

    class LearnedModeTool:
        async def ainvoke(self, args):
            raise AssertionError("a day read must not ask the learned-mode tool")

    orig = geo.plan_departure
    geo.plan_departure = fake
    try:
        leg = day_plan.agent_plan_leg(LearnedModeTool(), {"transportType": "bike", "homeAddress": "Home 1"})
        asyncio.run(leg("Yigal Alon 94", "11:00", "2030-10-02", None, None))
        asyncio.run(leg("Yigal Alon 94", "11:00", "2030-10-02", None, "train"))
    finally:
        geo.plan_departure = orig
    assert seen == ["bike", "train"]
    assert day_plan._task_mode({"location": {"transportType": "bus"}}) == "bus"
    assert day_plan._task_mode({"location": "Yigal Alon 94"}) is None


class HerBikeStaysWhereSheLeftIt(unittest.TestCase):
    """13.10: a Haifa interview reached by TRAIN, then "Deep Inside AI Coding" at
    MATAM planned as "5 min by bike" — her bike was in Tel Aviv."""

    def test_after_a_train_the_next_leg_is_not_by_bike(self):
        rows = [
            row("interview", "Interview — Rafael", "11:00", 60, "interview", "Azrieli Center, Tel Aviv-Yafo",
                source="calendar"),
            row("talk", "Deep Inside AI Coding", "16:00", 60, "conference", "Sarona Market, Tel Aviv-Yafo",
                source="calendar"),
        ]
        rows[0]["location"]["transportType"] = "train"   # how she got there, from the phone
        legs = FakeLegs()
        plan(rows, legs)
        sarona = [c for c in legs.calls if "Sarona" in c[0]]
        self.assertTrue(sarona, legs.calls)
        self.assertEqual(sarona[0][4], "bus")

    def test_her_own_choice_on_the_task_wins(self):
        rows = [
            row("interview", "Interview — Rafael", "11:00", 60, "interview", "Azrieli Center, Tel Aviv-Yafo"),
            row("talk", "Deep Inside AI Coding", "16:00", 60, "conference", "Sarona Market, Tel Aviv-Yafo"),
        ]
        rows[0]["location"]["transportType"] = "train"
        rows[1]["location"]["transportType"] = "bike"
        legs = FakeLegs()
        plan(rows, legs)
        self.assertEqual([c[4] for c in legs.calls if "Sarona" in c[0]][0], "bike")


def test_haifa_is_not_ridden_by_bike():
    """13.10: the Rafael interview in Haifa came back '147 minutes by bicycle'."""
    import asyncio
    import geo
    seen = []

    async def fake(**kw):
        seen.append(kw["transport"])
        minutes = {"bike": 147, "train": 95, "bus": 140}[kw["transport"]]
        return {"ok": True, "plan": {"leaveHomeBy": "10:53", "travelMinutes": minutes}}

    orig = geo.plan_departure
    geo.plan_departure = fake
    try:
        leg = day_plan.agent_plan_leg(None, {"transportType": "bike", "homeAddress": "Home 1"})
        res = asyncio.run(leg("רפאל מכון דוד", "13:30", "2030-10-18", None, None))
    finally:
        geo.plan_departure = orig
    assert seen == ["bike", "train"], seen
    assert res["plan"]["transport"] == "train" and res["plan"]["travelMinutes"] == 95
