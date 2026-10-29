"""errands_along — a to-do placed ON her route, open when she passes.

Koral, 29.9: "fix my coffee machine — suggest places on the way that are open
at the hours I pass by them." Google and the model are mocked; the geometry,
the clock and the ranking are the code's and are tested for real.
"""
import asyncio
import os
import sys
import unittest
from datetime import date
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import errands_along as ea  # noqa: E402


def encode(points):
    """Google polyline encoder, for building test routes."""
    out, plat, plng = [], 0, 0
    for lat, lng in points:
        for v, prev in ((round(lat * 1e5), plat), (round(lng * 1e5), plng)):
            d = v - prev
            d = ~(d << 1) if d < 0 else d << 1
            while d >= 0x20:
                out.append(chr((0x20 | (d & 0x1F)) + 63))
                d >>= 5
            out.append(chr(d + 63))
        plat, plng = round(lat * 1e5), round(lng * 1e5)
    return "".join(out)


# Home (Mordei ha-Geta'ot) → Allenby 30, roughly: a straight-ish line north-west.
ROUTE = [(32.0560 + i * 0.002, 34.7900 - i * 0.0015) for i in range(11)]
POLY = encode(ROUTE)


class Geometry(unittest.TestCase):
    def test_google_reference_polyline(self):
        pts = ea.decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
        self.assertEqual(pts, [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)])

    def test_round_trip(self):
        self.assertEqual(len(ea.decode_polyline(POLY)), len(ROUTE))

    def test_pass_times_run_from_leave_to_arrive(self):
        s = ea.samples(ROUTE, "17:30", "17:50", n=4)
        self.assertEqual([x["pass_at"] for x in s], ["17:32", "17:38", "17:42", "17:48"])

    def test_no_times_no_samples(self):
        self.assertEqual(ea.samples(ROUTE, "", "17:50"), [])


# Monday 28.9.2026 — Google day 1.
MON = date(2026, 9, 28)
SHOP = [{"open": {"day": d, "time": "0900"}, "close": {"day": d, "time": "1800"}} for d in range(0, 6)]
WEEK = [f"{d}: 09:00–18:00" for d in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")]
BAR = [{"open": {"day": 1, "time": "2000"}, "close": {"day": 2, "time": "0200"}}]


class OpeningHours(unittest.TestCase):
    def test_open_in_hours(self):
        self.assertTrue(ea.open_at(SHOP, MON, "17:40"))

    def test_closed_after_hours(self):
        self.assertFalse(ea.open_at(SHOP, MON, "18:10"))

    def test_closed_on_a_day_off(self):
        self.assertFalse(ea.open_at(SHOP, date(2026, 10, 3), "12:00"))   # Saturday, Google day 6

    def test_past_midnight(self):
        self.assertTrue(ea.open_at(BAR, date(2026, 9, 29), "01:00"))     # Tuesday 01:00

    def test_always_open(self):
        self.assertTrue(ea.open_at([{"open": {"day": 0, "time": "0000"}}], MON, "03:00"))

    def test_unknown_is_not_open(self):
        self.assertIsNone(ea.open_at(None, MON, "10:00"))


class Along(unittest.TestCase):
    TRIP = [{"polyline": POLY, "leave": "17:30", "arrive": "17:50", "date": "2026-09-28", "label": "Karaoke"}]
    PLAN = {"errand": True, "query_he": "תיקון מכונות קפה", "query_en": "coffee machine repair",
            "minutes": 20, "why": "repair shop"}

    def _run(self, nearby, hours, **kw):
        with mock.patch.object(ea.config, "GOOGLE_MAPS_API_KEY", "k"), \
             mock.patch.object(ea, "_nearby", nearby), mock.patch.object(ea, "_details", hours):
            return asyncio.run(ea.along("לתקן את מכונת הקפה", self.TRIP, plan=self.PLAN, **kw))

    def test_open_on_route_wins_and_far_ones_are_dropped(self):
        on = ROUTE[5]
        results = [
            {"place_id": "open", "name": "Fix-It Coffee", "geometry": {"location": {"lat": on[0] + 0.001, "lng": on[1]}}},
            {"place_id": "closed", "name": "Closed Early", "geometry": {"location": {"lat": on[0], "lng": on[1] + 0.001}}},
            {"place_id": "far", "name": "Far Away", "geometry": {"location": {"lat": on[0] + 0.05, "lng": on[1]}}},
        ]
        early = [{"open": {"day": 1, "time": "0800"}, "close": {"day": 1, "time": "1200"}}]

        async def details(_c, pid):
            return {"periods": SHOP if pid == "open" else early, "weekday_text": WEEK,
                    "price_level": 1, "rating": 4.6, "reviews": 120}
        out = self._run(mock.AsyncMock(return_value=results), details)
        self.assertTrue(out["ok"])
        self.assertEqual([c["place_id"] for c in out["candidates"]], ["open"])
        c = out["candidates"][0]
        self.assertTrue(c["open_when_passing"])
        self.assertLess(c["off_route_m"], ea._RADIUS_M)
        self.assertIn("query_place_id=open", c["maps_url"])
        self.assertEqual(c["trip"], "Karaoke")
        self.assertTrue(c["recommended"])
        self.assertEqual(c["hours_today"], "09:00–18:00")
        self.assertEqual(c["price_level"], 1)
        self.assertIn("open_when_passing", c["why"])

    def test_better_rated_open_place_is_recommended_over_a_closer_one(self):
        on = ROUTE[5]
        results = [
            {"place_id": "near", "name": "Near", "geometry": {"location": {"lat": on[0], "lng": on[1]}}},
            {"place_id": "good", "name": "Good", "geometry": {"location": {"lat": on[0] + 0.002, "lng": on[1]}}},
        ]

        async def details(_c, pid):
            return {"periods": SHOP, "weekday_text": WEEK, "rating": 3.1 if pid == "near" else 4.8}
        out = self._run(mock.AsyncMock(return_value=results), details)
        self.assertEqual(out["candidates"][0]["place_id"], "good")
        self.assertTrue(out["candidates"][0]["recommended"])
        self.assertNotIn("recommended", out["candidates"][1])

    def test_every_failure_has_its_own_reason(self):
        with mock.patch.object(ea.config, "GOOGLE_MAPS_API_KEY", "k"):
            self.assertEqual(asyncio.run(ea.along("x", []))["reason"], "no_route")
            self.assertEqual(asyncio.run(ea.along("write report", self.TRIP,
                             plan={**self.PLAN, "errand": False}))["reason"], "not_an_errand")
        self.assertEqual(self._run(mock.AsyncMock(return_value=[]), mock.AsyncMock())["reason"],
                         "nothing_on_route")
        refused = mock.AsyncMock(side_effect=ea.PlacesRefused("REQUEST_DENIED"))
        self.assertEqual(self._run(refused, mock.AsyncMock())["reason"], "places_refused")

    def test_prices_false_spends_no_web_search_and_no_model(self):
        # The Add screen's suggestion row only needs WHICH place is on the way.
        on = ROUTE[5]
        res = [{"place_id": "p", "name": "Shop", "geometry": {"location": {"lat": on[0], "lng": on[1]}}}]
        boom = mock.AsyncMock(side_effect=AssertionError("prices must not be fetched"))
        with mock.patch("errand_prices.enrich", boom):
            out = self._run(mock.AsyncMock(return_value=res),
                            mock.AsyncMock(return_value={"periods": SHOP, "weekday_text": WEEK}),
                            prices=False)
        self.assertTrue(out["ok"])
        boom.assert_not_called()

    def test_all_closed_says_so(self):
        on = ROUTE[3]
        res = [{"place_id": "c", "name": "Shut", "geometry": {"location": {"lat": on[0], "lng": on[1]}}}]
        out = self._run(mock.AsyncMock(return_value=res),
                        mock.AsyncMock(return_value={"periods": [{"open": {"day": 1, "time": "0800"}, "close": {"day": 1, "time": "1000"}}]}))
        self.assertEqual(out["reason"], "nothing_open_when_passing")
        self.assertEqual(out["closed"][0]["name"], "Shut")


if __name__ == "__main__":
    unittest.main()
