"""transit_alerts — news about HER route, and an honest "couldn't check".

Tavily is mocked. What is tested is the code's filter (a disruption word AND
one of her terms), and silent-state rule 1: "nothing reported" and "could not
look" are different answers.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transit_alerts  # noqa: E402


def run(c):
    return asyncio.run(c)


def res(*rows):
    return {"ok": True, "results": [
        {"title": t, "link": f"https://news.example/{i}", "snippet": s, "published": "2026-10-19"}
        for i, (t, s) in enumerate(rows)]}


CLOSURE_HAIFA = ("רכבת ישראל: ללא רכבות בין תל אביב לחיפה בסוף השבוע",
                 "בשל עבודות תשתית לא תפעל הרכבת בקטע תל אביב–חיפה.")
CLOSURE_EILAT = ("כביש 90 ייסגר לתנועה", "עבודות סלילה ליד אילת, הסטות תנועה.")
HAIFA_NO_DISRUPTION = ("פסטיבל אוכל בחיפה", "אלפים צפויים להגיע לנמל חיפה.")
LINE_251 = ("שינויים בקווי האוטובוס", "קו 251 יוסט מרחוב הרצל בשל עבודות.")
NUMBER_ONLY = ("עבודות בתל אביב", "4 צמתים ייחסמו הלילה.")


class Filter(unittest.TestCase):
    def setUp(self):
        transit_alerts._cache.clear()
        self.cfg = mock.patch.object(transit_alerts.tavily_search, "is_configured", return_value=True)
        self.cfg.start()

    def tearDown(self):
        self.cfg.stop()

    def _search(self, value):
        return mock.patch.object(transit_alerts.tavily_search, "search",
                                 mock.AsyncMock(return_value=value))

    def test_a_closure_on_her_city_is_kept_with_its_link(self):
        with self._search(res(CLOSURE_HAIFA, CLOSURE_EILAT)):
            got = run(transit_alerts.disruptions_for(places=["חיפה"], modes=["heavy_rail"]))
        self.assertTrue(got["checked"])
        self.assertEqual([a["title"] for a in got["alerts"]], [CLOSURE_HAIFA[0]])
        self.assertEqual(got["alerts"][0]["link"], "https://news.example/0")
        self.assertIn("חיפה", got["alerts"][0]["matched"])

    def test_an_english_address_matches_hebrew_news(self):
        s = mock.AsyncMock(return_value=res(CLOSURE_HAIFA))
        with mock.patch.object(transit_alerts.tavily_search, "search", s):
            got = run(transit_alerts.disruptions_for(places=["Haifa"], modes=["train"]))
        self.assertEqual(len(got["alerts"]), 1)
        self.assertIn("חיפה", s.await_args.args[0])

    def test_her_city_without_a_disruption_word_is_dropped(self):
        with self._search(res(HAIFA_NO_DISRUPTION)):
            got = run(transit_alerts.disruptions_for(places=["חיפה"]))
        self.assertTrue(got["checked"])
        self.assertEqual(got["alerts"], [])

    def test_her_line_is_matched_next_to_the_word_line(self):
        with self._search(res(LINE_251, NUMBER_ONLY)):
            got = run(transit_alerts.disruptions_for(lines=["251", "4"], modes=["bus"]))
        self.assertEqual([a["matched"] for a in got["alerts"]], [["251"]])

    def test_not_configured_is_not_an_empty_list(self):
        with mock.patch.object(transit_alerts.tavily_search, "is_configured", return_value=False):
            got = run(transit_alerts.disruptions_for(places=["חיפה"]))
        self.assertFalse(got["checked"])
        self.assertEqual(got["reason"], "not_configured")
        self.assertNotIn("alerts", got)

    def test_every_search_failing_is_not_checked(self):
        with self._search({"ok": False, "error": "rate_limited"}):
            got = run(transit_alerts.disruptions_for(places=["חיפה"], modes=["train", "bus"]))
        self.assertFalse(got["checked"])
        self.assertEqual(got["reason"], "rate_limited")

    def test_one_of_two_searches_failing_is_partial(self):
        s = mock.AsyncMock(side_effect=[res(CLOSURE_HAIFA), {"ok": False, "error": "http_500"}])
        with mock.patch.object(transit_alerts.tavily_search, "search", s):
            got = run(transit_alerts.disruptions_for(places=["חיפה"], modes=["train", "bus"]))
        self.assertTrue(got["checked"])
        self.assertTrue(got["partial"])
        self.assertEqual(len(got["alerts"]), 1)

    def test_no_route_terms_does_not_search(self):
        s = mock.AsyncMock()
        with mock.patch.object(transit_alerts.tavily_search, "search", s):
            got = run(transit_alerts.disruptions_for(places=["Israel", ""]))
        self.assertFalse(got["checked"])
        s.assert_not_called()

    def test_the_same_route_twice_is_one_search(self):
        s = mock.AsyncMock(return_value=res(CLOSURE_HAIFA))
        with mock.patch.object(transit_alerts.tavily_search, "search", s):
            run(transit_alerts.disruptions_for(places=["חיפה"], modes=["bus"]))
            run(transit_alerts.disruptions_for(places=["חיפה"], modes=["bus"]))
        self.assertEqual(s.await_count, 1)

    def test_searches_are_news_from_israeli_sources(self):
        s = mock.AsyncMock(return_value=res())
        with mock.patch.object(transit_alerts.tavily_search, "search", s):
            run(transit_alerts.disruptions_for(places=["חיפה"], modes=["bus"]))
        kw = s.await_args.kwargs
        self.assertEqual(kw["topic"], "news")
        self.assertIn("rail.co.il", kw["include_domains"])
        self.assertLessEqual(kw["days"], 7)


class Terms(unittest.TestCase):
    def test_address_drops_number_and_country(self):
        self.assertEqual(transit_alerts.places_from_address("Herzl 12, Haifa, Israel"),
                         ["Herzl", "Haifa"])

    def test_terms_from_a_transit_plan(self):
        plan = {"legs": [
            {"type": "walk", "from": "home", "to": "stop", "minutes": 5},
            {"type": "heavy_rail", "line": "Israel Railways", "from": "תל אביב - סבידור מרכז",
             "to": "חיפה - חוף הכרמל", "minutes": 55},
            {"type": "bus", "line": "115", "from": "חוף הכרמל", "to": "הרצל", "minutes": 12}]}
        t = transit_alerts.terms_from_plan(plan, origin="Dizengoff 50, Tel Aviv-Yafo, Israel",
                                           destination="Herzl 3, Haifa, Israel")
        self.assertIn("Haifa", t["places"])
        self.assertIn("115", t["lines"])
        self.assertIn("heavy_rail", t["modes"])
        self.assertIn("חיפה - חוף הכרמל", t["stations"])
        self.assertNotIn("home", t["stations"])


class Say(unittest.TestCase):
    def test_three_outcomes_differ_in_both_languages(self):
        for he in (True, False):
            no = transit_alerts.say({"checked": False, "reason": "timeout"}, he=he)
            none = transit_alerts.say({"checked": True, "alerts": []}, he=he)
            some = transit_alerts.say({"checked": True, "alerts": [
                {"title": "T", "link": "https://x.example"}]}, he=he)
            self.assertEqual(len({no, none, some}), 3)
            self.assertIn("https://x.example", some)


if __name__ == "__main__":
    unittest.main()
