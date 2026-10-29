"""Her bike is somewhere else and she has to be somewhere (Koral, 19.10).

"The bike is on Florentin and I need to be at the Baot meetup" — Meira asked
where the meetup was and offered nothing. These pin the three chains, timed
back from the start, ranked, and said with the bus line and the leave time.
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vehicle_chain  # noqa: E402

HERE = {"lat": 32.07, "lng": 34.78, "name": "here"}
BIKE = {"lat": 32.056, "lng": 34.768, "name": "פלורנטין"}
EVENT = {"lat": 32.083, "lng": 34.795, "name": "WE TLV"}
HOME = HERE

# (from, to, mode) -> minutes, plus the bus details where a bus runs
TABLE = {
    ("here", "פלורנטין", "walk"): 35, ("here", "פלורנטין", "bus"): 20,
    ("פלורנטין", "WE TLV", "bike"): 14, ("WE TLV", "here", "bike"): 15,
    ("here", "WE TLV", "walk"): 40, ("here", "WE TLV", "bus"): 25,
    ("WE TLV", "פלורנטין", "walk"): 30, ("WE TLV", "פלורנטין", "bus"): 18,
    ("פלורנטין", "here", "bike"): 12,
    ("WE TLV", "here", "walk"): 45, ("WE TLV", "here", "bus"): 22,
}
BUS = {("here", "פלורנטין"): ("4", "17:05", "17:09"), ("here", "WE TLV"): ("18", "17:20", "17:26")}


def fake_route(broken=()):
    async def route(a, b, mode, arrive):
        key = (a["name"], b["name"], mode)
        if key in broken or key not in TABLE:
            return None, "no_route"
        out = {"minutes": TABLE[key], "overviewPolyline": f"{a['name']}>{b['name']}"}
        if mode == "bus" and (a["name"], b["name"]) in BUS:
            line, leave, board = BUS[(a["name"], b["name"])]
            out.update({"departAt": leave, "transit": {"line": line, "departTime": board,
                                                       "departStop": "ארלוזורוב"}})
        return out, None
    return route


def run(**kw):
    args = dict(route=fake_route(), here=HERE, vehicle_at=BIKE, event=EVENT, home=HOME,
                start="18:00", end="21:00", now="13:10")
    args.update(kw)
    return asyncio.run(vehicle_chain.plan(**args))


class Chains(unittest.TestCase):
    def test_three_ways_best_first_the_bike_ending_at_home_wins_a_tie(self):
        out = run()
        self.assertTrue(out["ok"])
        kinds = [o["kind"] for o in out["options"]]
        self.assertEqual(kinds[-1], "leave_it")      # shortest, but the bike stays out
        first = out["options"][0]
        self.assertEqual(first["kind"], "fetch_first")
        self.assertEqual(first["leave_at"], "17:05")  # the bus to the bike leaves then
        self.assertEqual(first["arrive_at"], "17:55")
        self.assertTrue(first["on_time"])
        self.assertEqual([s["mode"] for s in first["steps"]], ["bus", "bike", "bike"])

    def test_a_short_walk_beats_the_bus(self):
        TABLE[("here", "פלורנטין", "walk")] = 12
        try:
            first = next(o for o in run()["options"] if o["kind"] == "fetch_first")
            self.assertEqual(first["steps"][0]["mode"], "walk")
        finally:
            TABLE[("here", "פלורנטין", "walk")] = 35

    def test_a_leg_that_cannot_be_routed_is_said_not_dropped(self):
        out = run(route=fake_route(broken={("פלורנטין", "WE TLV", "bike")}))
        failed = [o for o in out["options"] if o.get("failed")]
        self.assertEqual(failed[0]["failed"]["leg"], "vehicle_to_event")
        self.assertEqual(out["options"][-1]["kind"], "fetch_first")   # ranked last, still there

    def test_too_late_to_leave_says_how_late(self):
        out = run(now="17:15")
        first = next(o for o in out["options"] if o["kind"] == "fetch_first")
        self.assertFalse(first["on_time"])
        self.assertEqual(first["late_by"], 10)

    def test_nothing_routable_is_a_reason_not_an_empty_answer(self):
        async def refused(a, b, mode, arrive):
            return None, "refused"
        out = run(route=refused)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "directions_refused")


class Words(unittest.TestCase):
    def test_hebrew_leads_with_the_leave_time_and_names_the_bus(self):
        text = vehicle_chain.say(run(), he=True, event_name="באות מוצאות")
        self.assertIn("באות מוצאות ב-18:00", text)
        self.assertIn("1. קודם לאסוף את האופניים: לצאת 17:05", text)
        self.assertIn("4 ב-17:09", text)
        self.assertIn("האופניים נשארים שם", text)

    def test_english_too(self):
        text = vehicle_chain.say(run(), he=False, event_name="Baot")
        self.assertIn("1. Get the bike first: leave 17:05", text)
        self.assertIn("4 at 17:09", text)


if __name__ == "__main__":
    unittest.main()


class Pickup(unittest.TestCase):
    """"I need to pick up my bike from Florentin, plan it" — no event named:
    every way it fits into her day is a branch, priced by what it ADDS."""

    EVENTS = [{"name": "באות מוצאות", "place": EVENT, "start": "18:00", "end": "21:00"},
              {"name": "past thing", "place": EVENT, "start": "09:00"},
              {"name": "no place", "place": None, "start": "19:00"}]

    def pickup(self, **kw):
        args = dict(route=fake_route(), here=HERE, vehicle_at=BIKE, home=HOME,
                    events=self.EVENTS, now="13:10")
        args.update(kw)
        return asyncio.run(vehicle_chain.plan_pickup(**args))

    def test_on_the_way_to_the_event_costs_only_the_detour(self):
        out = self.pickup()
        self.assertTrue(out["ok"])
        best = out["options"][0]
        self.assertIn(best["kind"], ("fetch_first", "fetch_after"))
        self.assertEqual(best["event"], "באות מוצאות")
        self.assertEqual(best["extra_min"], 10)      # 67 with the bike vs 57 without
        self.assertTrue(all(o.get("event") != "past thing" for o in out["options"]))

    def test_a_trip_of_its_own_is_offered_and_priced_in_full(self):
        TABLE[("here", "פלורנטין", "walk")] = 12
        try:
            own = next(o for o in self.pickup()["options"] if o["kind"] == "on_its_own")
            self.assertEqual(own["extra_min"], 12 + 2 + 12)
            self.assertTrue(own["fits"])
        finally:
            TABLE[("here", "פלורנטין", "walk")] = 35

    def test_said_with_what_it_adds_to_her_day(self):
        text = vehicle_chain.say_pickup(self.pickup(), he=True)
        self.assertIn("1. ", text)
        self.assertIn("+10 דק׳ ליום", text)
        self.assertIn("באות מוצאות", text)


class AfterTheEvent(unittest.TestCase):
    def test_a_leg_after_the_event_carries_no_clock_time_from_now(self):
        # Live, 19.10: "🚌 44 at 15:31" for the ride after a 21:00 end.
        global BUS
        BUS[("WE TLV", "פלורנטין")] = ("44", "15:20", "15:31")
        try:
            after = next(o for o in run()["options"] if o["kind"] == "fetch_after")
            leg = next(s for s in after["steps"] if s["from"] == "event")
            self.assertNotIn("board_at", leg)
            self.assertNotIn("15:31", vehicle_chain.say(run(), he=True))
        finally:
            BUS.pop(("WE TLV", "פלורנטין"))


GYM = {"lat": 32.09, "lng": 34.78, "name": "GYM"}


class Evening(unittest.TestCase):
    """"And I also want to train at 20" while Baot runs 18-21 (Koral, 19.10)."""

    EXTRA = {
        ("WE TLV", "GYM", "bike"): 8, ("WE TLV", "GYM", "walk"): 20, ("WE TLV", "GYM", "bus"): 14,
        ("GYM", "here", "bike"): 10, ("GYM", "here", "walk"): 25, ("GYM", "here", "bus"): 18,
        ("GYM", "פלורנטין", "walk"): 50, ("GYM", "פלורנטין", "bus"): 25,
        ("here", "WE TLV", "bike"): 15,
    }

    def setUp(self):
        TABLE.update(self.EXTRA)

    def tearDown(self):
        for k in self.EXTRA:
            TABLE.pop(k, None)

    def evening(self):
        return asyncio.run(vehicle_chain.plan_evening(
            route=fake_route(), here=HERE, vehicle_at=BIKE, home=HOME,
            events=[{"name": "באות", "place": EVENT, "start": "18:00", "end": "21:00"}],
            wish={"name": "אימון", "place": GYM, "start": "20:00"}, now="15:40"))

    def test_the_clash_is_named(self):
        out = self.evening()
        self.assertTrue(out["ok"])
        self.assertEqual(out["clash"], {"with": "באות", "start": "18:00", "end": "21:00"})

    def test_leave_early_is_offered_with_the_minute_to_leave(self):
        early = next(o for o in self.evening()["options"] if o["kind"] == "leave_early")
        # 20:00 − 8 min ride − 5 buffer − 2 unlock
        self.assertEqual(early["leave_event_at"], "19:45")
        self.assertEqual(early["wish_at"], "20:00")

    def test_training_after_is_the_other_way(self):
        kinds = {o["kind"] for o in self.evening()["options"]}
        self.assertEqual(kinds & {"leave_early", "after"}, {"leave_early", "after"})

    def test_the_bike_fetched_first_rides_baot_to_gym_to_home(self):
        early = [o for o in self.evening()["options"] if o["kind"] == "leave_early" and o["pickup"]]
        self.assertTrue(early)
        modes = [s["mode"] for s in early[0]["steps"]]
        self.assertEqual(modes[-2:], ["bike", "bike"])     # Baot → gym → home on the bike

    def test_said_in_hebrew(self):
        text = vehicle_chain.say_evening(self.evening(), he=True)
        self.assertIn("⚠️ אימון נופל בתוך באות (18:00–21:00)", text)
        self.assertIn("לצאת מבאות ב-19:45 לאימון ב-20:00", text)


class EveningWords(unittest.TestCase):
    def test_the_gym_is_named_and_every_option_shows_its_legs(self):
        TABLE.update(Evening.EXTRA)
        try:
            out = asyncio.run(vehicle_chain.plan_evening(
                route=fake_route(), here=HERE, vehicle_at=BIKE, home=HOME,
                events=[{"name": "באות", "place": EVENT, "start": "18:00", "end": "21:00"}],
                wish={"name": "אימון", "place": {**GYM, "formatted": "Space Gym, תל אביב"}, "start": "20:00"},
                now="15:40"))
        finally:
            for k in Evening.EXTRA:
                TABLE.pop(k, None)
        text = vehicle_chain.say_evening(out, he=True)
        self.assertIn("📍 אימון: Space Gym, תל אביב", text)
        self.assertIn("← אימון", text)          # a leg TO the gym is drawn
        self.assertIn("← הביתה", text)


class EveningTimes(unittest.TestCase):
    def test_the_bus_to_the_bike_is_the_one_the_leave_time_names(self):
        # Live, 19.10: "leave 17:12" beside "🚌 54 at 16:20" — the bus to the
        # bike was timed from now, the leave time from Baot's start.
        TABLE.update(Evening.EXTRA)
        try:
            out = asyncio.run(vehicle_chain.plan_evening(
                route=fake_route(), here=HERE, vehicle_at=BIKE, home=HOME,
                events=[{"name": "באות", "place": EVENT, "start": "18:00", "end": "21:00"}],
                wish={"name": "אימון", "place": GYM, "start": "20:00"}, now="15:40"))
        finally:
            for k in Evening.EXTRA:
                TABLE.pop(k, None)
        first = next(o for o in out["options"] if o["pickup"] and o["pickup"].startswith("before:באות"))
        bus = first["steps"][0]
        self.assertEqual(bus["mode"], "bus")
        self.assertEqual(first["leave_at"], bus["leave_at"])


class ForTheMap(unittest.TestCase):
    def test_every_leg_carries_its_line_and_both_ends(self):
        for o in run()["options"]:
            for st in o["steps"]:
                self.assertIn("polyline", st)
                self.assertIn("lat", st["to_pt"])
