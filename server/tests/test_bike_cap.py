"""29.10 live: Tel Aviv → Haifa planned by bike (327 min, leave 04:23)."""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import geo  # noqa: E402

G = {"lat": 32.0, "lng": 34.8, "formatted": "x", "partial": False}


class BikeCap(unittest.TestCase):
    def test_a_long_bike_trip_becomes_public_transport_and_says_so(self):
        async def directions(a, b, mode, arrive):
            if mode == "bike":
                return {"minutes": 327, "mode": "bicycling", "modeLabel": "by bike", "transport": "bike"}
            return {"minutes": 95, "mode": "transit", "modeLabel": "by train", "transport": "train",
                    "departAt": "08:10", "arriveAtReal": "09:45"}
        with mock.patch.object(geo, "geocode", mock.AsyncMock(return_value=G)), \
                mock.patch.object(geo, "directions", directions):
            out = asyncio.new_event_loop().run_until_complete(
                geo.plan_departure("Intel Haifa", "10:00", "Tel Aviv", "bike"))
        self.assertTrue(out["ok"])
        self.assertEqual(out["plan"]["fallbackFrom"], {"transport": "bike", "minutes": 327})
        self.assertIn("327", out["plan"]["modeNote"])
        self.assertNotEqual(out["plan"]["transport"], "bike")

    def test_a_short_bike_trip_stays_a_bike_trip(self):
        async def directions(a, b, mode, arrive):
            return {"minutes": 18, "mode": "bicycling", "modeLabel": "by bike", "transport": "bike"}
        with mock.patch.object(geo, "geocode", mock.AsyncMock(return_value=G)), \
                mock.patch.object(geo, "directions", directions):
            out = asyncio.new_event_loop().run_until_complete(
                geo.plan_departure("gym", "18:00", "home", "bike"))
        self.assertEqual(out["plan"]["transport"], "bike")
        self.assertNotIn("fallbackFrom", out["plan"])


if __name__ == "__main__":
    unittest.main()
