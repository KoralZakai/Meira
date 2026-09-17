"""Self-check for the origin-verification + transport rules in plan_departure.

Run: python test_origin_verification.py  (no network needed — asserts the
refusal paths that fire BEFORE any Google call, and the transit-leg parser).
"""
import asyncio
import unittest

import geo
import user_profile
from lumi_agent import _make_tools


def _tool(tools, name):
    return next(t for t in tools if t.name == name)


class OriginVerification(unittest.TestCase):
    PHONE = "__test_origin__"

    def setUp(self):
        user_profile.update_profile(self.PHONE, homeAddress="Herzl 1, Tel Aviv",
                                    transportType="bus")

    def _plan(self, **kwargs):
        tools = _make_tools(self.PHONE, "test")
        return asyncio.run(_tool(tools, "plan_departure").ainvoke(
            {"destination": "Dizengoff 50", "arrival_time": "10:00", **kwargs}))

    def test_refuses_unconfirmed_home_start(self):
        """Home exists but the user never confirmed leaving from home -> refuse."""
        res = self._plan()
        self.assertFalse(res["ok"])
        self.assertEqual(res["need"], "start_confirmation")

    def test_refuses_when_no_start_at_all(self):
        user_profile.update_profile("__test_nohome__", transportType="bus")
        tools = _make_tools("__test_nohome__", "test")
        res = asyncio.run(_tool(tools, "plan_departure").ainvoke(
            {"destination": "Dizengoff 50", "arrival_time": "10:00"}))
        self.assertFalse(res["ok"])
        self.assertEqual(res["need"], "start")

    def test_asks_transport_when_unknown(self):
        user_profile.update_profile("__test_notrans__", homeAddress="Herzl 1")
        # clear transport default by writing empty string
        user_profile.update_profile("__test_notrans__", transportType="")
        tools = _make_tools("__test_notrans__", "test")
        res = asyncio.run(_tool(tools, "plan_departure").ainvoke(
            {"destination": "Dizengoff 50", "arrival_time": "10:00",
             "start_confirmed": True}))
        self.assertFalse(res["ok"])
        self.assertEqual(res["need"], "transport")


class TransitLegs(unittest.TestCase):
    def test_parses_walk_and_bus_legs(self):
        steps = [
            {"travel_mode": "WALKING", "duration": {"value": 360},
             "html_instructions": "Walk to Arlozorov/Namir"},
            {"travel_mode": "TRANSIT", "duration": {"value": 1500},
             "transit_details": {
                 "line": {"short_name": "251", "vehicle": {"type": "BUS"}},
                 "departure_stop": {"name": "Arlozorov"},
                 "arrival_stop": {"name": "Central St"},
                 "departure_time": {"text": "08:20"},
                 "arrival_time": {"text": "08:45"},
                 "num_stops": 7}},
        ]
        legs = geo._transit_legs(steps)
        self.assertEqual(len(legs), 2)
        self.assertEqual(legs[0]["type"], "walk")
        self.assertEqual(legs[0]["minutes"], 6)
        self.assertEqual(legs[1]["type"], "bus")
        self.assertEqual(legs[1]["line"], "251")
        self.assertEqual(legs[1]["from"], "Arlozorov")
        self.assertEqual(legs[1]["departTime"], "08:20")


if __name__ == "__main__":
    unittest.main()
