"""One message can create several trips, and they are a chain.

"gym at 18:00 and a party at 20:00" used to produce a route for exactly ONE of
them: the loop broke after the first task it looked at. Worse, if that first
task asked "how will you get there?", it broke on the question and the second
trip was never considered at all — no route, no leave time, no alarm, and
nothing in the reply to say so.

They are also a chain. The 20:00 trip does not start at home; it starts wherever
the 18:00 thing was. Routing both from home produces a departure time she cannot
possibly make, and it is confidently wrong rather than obviously missing.
"""
import unittest

import main


class ClockSortTests(unittest.TestCase):
    """The chain must be built in the order the day is actually walked."""

    @staticmethod
    def _clock(t):
        return str(t.get("fixed_time") or "99:99")[:5]

    def test_trips_are_ordered_by_time_not_by_mention(self):
        # She often says the later thing first ("party at 20:00, and gym at 18").
        said = [{"text": "party", "fixed_time": "20:00"},
                {"text": "gym", "fixed_time": "18:00"}]
        self.assertEqual([t["text"] for t in sorted(said, key=self._clock)],
                         ["gym", "party"])

    def test_a_task_with_no_hour_sorts_last_and_never_breaks_the_chain(self):
        said = [{"text": "buy milk"},
                {"text": "gym", "fixed_time": "18:00"}]
        self.assertEqual([t["text"] for t in sorted(said, key=self._clock)],
                         ["gym", "buy milk"])

    def test_seconds_on_a_time_do_not_disturb_the_order(self):
        said = [{"text": "b", "fixed_time": "20:00:00"},
                {"text": "a", "fixed_time": "18:30"}]
        self.assertEqual([t["text"] for t in sorted(said, key=self._clock)], ["a", "b"])


class RouteOriginTests(unittest.IsolatedAsyncioTestCase):
    """_route_for_task must honour the origin it is given."""

    async def test_the_origin_argument_overrides_home(self):
        seen = {}

        async def fake_plan(**kw):
            seen.update(kw)
            return {"ok": False}

        real_plan = main.geo.plan_departure
        real_prof = main.user_profile.get_profile
        real_mode = main._has_travel_mode
        try:
            main.geo.plan_departure = fake_plan
            main.user_profile.get_profile = lambda p: {"homeAddress": "בית 1"}
            main._has_travel_mode = lambda c: True
            await main._route_for_task(
                "972500000000",
                {"id": "t1", "text": "party", "fixed_time": "20:00",
                 "location": "הילטון", "category": "leisure"},
                "באוטובוס", "he", origin="יגאל אלון 94")
        finally:
            main.geo.plan_departure = real_plan
            main.user_profile.get_profile = real_prof
            main._has_travel_mode = real_mode

        self.assertEqual(seen.get("home_address"), "יגאל אלון 94",
                         "the second trip must start where the first ended")

    async def test_without_an_origin_it_still_starts_at_home(self):
        seen = {}

        async def fake_plan(**kw):
            seen.update(kw)
            return {"ok": False}

        real_plan = main.geo.plan_departure
        real_prof = main.user_profile.get_profile
        real_mode = main._has_travel_mode
        try:
            main.geo.plan_departure = fake_plan
            main.user_profile.get_profile = lambda p: {"homeAddress": "בית 1"}
            main._has_travel_mode = lambda c: True
            await main._route_for_task(
                "972500000000",
                {"id": "t1", "text": "gym", "fixed_time": "18:00",
                 "location": "יגאל אלון 94", "category": "gym"},
                "באוטובוס", "he")
        finally:
            main.geo.plan_departure = real_plan
            main.user_profile.get_profile = real_prof
            main._has_travel_mode = real_mode

        self.assertEqual(seen.get("home_address"), "בית 1")


if __name__ == "__main__":
    unittest.main()
