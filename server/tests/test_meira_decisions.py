"""The decisions the meira-sim run found wrong, pinned on the server side.

1. "Now". At 15:00, "07:00 today?" came back `fits`, and the free windows
   started at the wake time. check_availability and find_clashes now refuse
   the past and never offer it.
2. Opening hours. Nothing knew a single one: a dentist at 19:30 was "free".
   place_hours reads Google Places' periods — overnight, 24/7 and special
   days included — and says WHY when it cannot answer.
3. Field work. "Site visit — Intel Haifa" fell through to `meeting`; for the
   technicians Meira is built for it is a working day.

Every test pins the clock or the network; none makes a live call.
"""
import asyncio
import os
import sys
import unittest
from datetime import date, datetime
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import categorize  # noqa: E402
import clashes  # noqa: E402
import lumi_agent  # noqa: E402
import place_hours  # noqa: E402
import tz  # noqa: E402

TODAY = "2026-10-12"


def _tool(name):
    for t in lumi_agent._make_tools("_test_phone_", "hi"):
        if getattr(t, "name", None) == name:
            return t
    raise AssertionError(f"tool {name!r} not found")


def _row(text, start, minutes=60, **kw):
    return {"id": text, "text": text, "fixed_time": start, "duration_minutes": minutes,
            "status": "pending", "date": TODAY, **kw}


class _Clock:
    """now_il / today_il stopped at 15:00 on TODAY."""

    def __enter__(self):
        self._patches = [
            mock.patch.object(tz, "now_il", lambda: datetime(2026, 10, 12, 15, 0, tzinfo=tz.IL)),
            mock.patch.object(tz, "today_il", lambda: date(2026, 10, 12)),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()


class CheckAvailabilityNowTests(unittest.TestCase):
    def _ask(self, rows, **args):
        async def _rows(_phone, _a, _b, include_location=False):
            return rows
        with _Clock(), \
                mock.patch.object(lumi_agent.task_store, "fetch_task_rows", _rows), \
                mock.patch.object(lumi_agent.user_profile, "get_profile",
                                  lambda _p: {"defaultWakeTime": "07:00", "sleepTime": "22:00"}):
            return asyncio.run(_tool("check_availability").ainvoke(args))

    def test_an_hour_that_has_gone_is_past_not_fits(self):
        res = self._ask([], date=TODAY, minutes=45, start_time="07:00")
        self.assertEqual(res["verdict"], "past")
        self.assertIn("15:00", res["conflicts"][0])

    def test_free_windows_start_at_now_not_at_wake(self):
        res = self._ask([_row("Gym", "18:00")], date=TODAY, minutes=45)
        self.assertEqual(res["verdict"], "fits")
        starts = [w["start"] for w in res["free_windows"]]
        self.assertTrue(starts, res)
        self.assertTrue(all(s >= "15:00" for s in starts), starts)

    def test_a_day_that_is_over_is_past(self):
        res = self._ask([], date="2026-10-11", minutes=45, start_time="10:00")
        self.assertEqual(res["verdict"], "past")

    def test_a_future_hour_today_is_still_judged_normally(self):
        res = self._ask([_row("Gym", "18:00")], date=TODAY, minutes=45, start_time="16:00")
        self.assertEqual(res["verdict"], "fits")


class ClashesNowTests(unittest.TestCase):
    def test_move_is_never_offered_before_now(self):
        day = [
            {"id": "a", "text": "study", "category": "course", "fixed_time": "08:00",
             "duration_minutes": 60, "is_fixed": False},
            {"id": "b", "text": "standup", "category": "meeting", "fixed_time": "08:30",
             "duration_minutes": 30, "is_fixed": True},
        ]
        without = clashes.resolve_clashes(day)
        early = [o["newTime"] for c in without for o in c["options"] if o["kind"] == "move"]
        self.assertTrue(early and early[0] < "15:00", early)     # the old answer: a morning slot
        with_now = clashes.resolve_clashes(day, now="15:00")
        moves = [o["newTime"] for c in with_now for o in c["options"] if o["kind"] == "move"]
        self.assertTrue(moves, with_now)
        self.assertTrue(all(t >= "15:00" for t in moves), moves)
        kept = [o for c in with_now for o in c["options"] if o["kind"] in ("end-earlier", "delay-next")]
        self.assertTrue(all(o["newTime"] >= "15:00" for o in kept), kept)


class PlaceHoursTests(unittest.TestCase):
    WEEK = [{"open": {"day": d, "time": "0800"}, "close": {"day": d, "time": "1900"}} for d in range(0, 5)]

    def test_regular_week(self):
        self.assertEqual(place_hours.intervals_on(self.WEEK, "2026-10-14"), [["08:00", "19:00"]])  # Wed
        self.assertEqual(place_hours.intervals_on(self.WEEK, "2026-10-17"), [])                  # Sat

    def test_overnight_and_24_7(self):
        bar = [{"open": {"day": 5, "time": "2000"}, "close": {"day": 6, "time": "0200"}}]
        self.assertEqual(place_hours.intervals_on(bar, "2026-10-16"), [["20:00", "24:00"]])      # Fri
        self.assertEqual(place_hours.intervals_on(bar, "2026-10-17"), [["00:00", "02:00"]])      # Sat
        self.assertEqual(place_hours.intervals_on([{"open": {"day": 0, "time": "0000"}}], "2026-10-17"),
                         [["00:00", "24:00"]])

    def test_a_special_day_overrides_the_week(self):
        # Chol HaMoed: closes at 13:00 on that date only.
        special = self.WEEK + [{"open": {"day": 3, "time": "0800", "date": "2026-10-14"},
                                "close": {"day": 3, "time": "1300", "date": "2026-10-14"}}]
        self.assertEqual(place_hours.intervals_on(special, "2026-10-14"), [["08:00", "13:00"]])

    def test_slot_verdicts_name_the_reason(self):
        day = [["08:00", "19:00"]]
        self.assertTrue(place_hours.slot_verdict(day, "09:30", "10:15")["open"])
        self.assertEqual(place_hours.slot_verdict(day, "19:30", "20:15")["why"], "closes_earlier")
        self.assertEqual(place_hours.slot_verdict(day, "06:30", "07:15")["why"], "opens_later")
        self.assertEqual(place_hours.slot_verdict([], "09:00", "10:00")["why"], "closed_all_day")
        split = [["08:00", "12:00"], ["16:00", "19:00"]]
        self.assertEqual(place_hours.slot_verdict(split, "13:00", "13:45")["why"], "between_shifts")

    def test_no_key_and_not_found_are_reasons_not_open(self):
        with mock.patch.object(place_hours.config, "GOOGLE_MAPS_API_KEY", ""):
            res = asyncio.run(place_hours.hours_for("Dentist Dizengoff", "2026-10-14"))
        self.assertEqual(res, {"ok": False, "reason": "not_configured"})

        class _Resp:
            def __init__(self, body):
                self._b = body

            def json(self):
                return self._b

        class _Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, params=None):
                return _Resp({"status": "ZERO_RESULTS", "results": []})

        place_hours.clear_cache()
        with mock.patch.object(place_hours.config, "GOOGLE_MAPS_API_KEY", "k"), \
                mock.patch.object(place_hours.httpx, "AsyncClient", _Client):
            res = asyncio.run(place_hours.hours_for("nowhere at all", "2026-10-14"))
        self.assertEqual(res, {"ok": False, "reason": "not_found"})

    def test_hours_are_read_from_place_details(self):
        calls = []

        class _Resp:
            def __init__(self, body):
                self._b = body

            def json(self):
                return self._b

        class _Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, params=None):
                calls.append(url)
                if "textsearch" in url:
                    return _Resp({"status": "OK", "results": [{"place_id": "p1"}]})
                return _Resp({"status": "OK", "result": {
                    "name": "Dizengoff Dental", "business_status": "OPERATIONAL",
                    "opening_hours": {"periods": PlaceHoursTests.WEEK}}})

        place_hours.clear_cache()
        with mock.patch.object(place_hours.config, "GOOGLE_MAPS_API_KEY", "k"), \
                mock.patch.object(place_hours.httpx, "AsyncClient", _Client):
            res = asyncio.run(place_hours.hours_for("Dentist — Dizengoff Center", "2026-10-14"))
        self.assertTrue(res["ok"])
        self.assertEqual(res["intervals"], [["08:00", "19:00"]])
        self.assertEqual(res["name"], "Dizengoff Dental")
        self.assertEqual(len(calls), 2)


class FieldWorkCategoryTests(unittest.TestCase):
    def test_site_visits_and_installs_are_work(self):
        for title in ("Site visit — Intel Haifa", "Site survey — Port of Ashdod",
                      "Install — Rafael", "Commissioning — Intel Haifa",
                      "maintenance at Elbit", "ביקור באתר — אינטל חיפה", "התקנה בבית לקוח"):
            self.assertEqual(categorize.infer(title)["category"], "work", title)

    def test_the_specific_kinds_still_win(self):
        self.assertEqual(categorize.infer("Interview — site visit round")["category"], "interview")
        self.assertEqual(categorize.infer("Dentist appointment")["category"], "doctor")


if __name__ == "__main__":
    unittest.main()
