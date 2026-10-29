"""lumi_agent tool closures (behaviour C) — web_search / find_place.

Pins the "don't invent" guards: web_search refuses when NO search provider is
configured; find_place wraps geo.find_place and returns ok:false with a
don't-invent message when the place isn't found.

web_search has two providers since Tavily landed — Tavily first, Google as the
fallback — so every test here pins BOTH off unless it is the one exercising
that provider. A test that leaves Tavily configured makes a real, billed
network call.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import asyncio  # noqa: E402
import lumi_agent  # noqa: E402


def _tool(name):
    tools = lumi_agent._make_tools("_test_phone_", "hi")
    for t in tools:
        if getattr(t, "name", None) == name:
            return t
    raise AssertionError(f"tool {name!r} not found")


class WebSearchToolTests(unittest.TestCase):
    def test_returns_ok_false_when_creds_unset(self):
        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", ""), \
                mock.patch.object(lumi_agent.config, "GOOGLE_SEARCH_API_KEY", ""), \
                mock.patch.object(lumi_agent.config, "GOOGLE_CSE_ID", ""):
            res = asyncio.run(_tool("web_search").ainvoke({"query": "anything"}))
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "search_not_configured")

    def test_prefers_tavily_when_configured(self):
        """Google is fully configured here — Tavily must still win, and Google
        must not be called at all."""
        async def _tavily(query, **kw):
            return {"ok": True, "query": query, "source": "tavily",
                    "results": [{"title": "T", "link": "https://t", "snippet": "s"}]}

        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(lumi_agent.config, "GOOGLE_SEARCH_API_KEY", "g"), \
                mock.patch.object(lumi_agent.config, "GOOGLE_CSE_ID", "cx"), \
                mock.patch.object(lumi_agent.tavily_search, "search", _tavily):
            res = asyncio.run(_tool("web_search").ainvoke({"query": "anything"}))
        self.assertTrue(res["ok"])
        self.assertEqual(res["source"], "tavily")
        self.assertEqual(res["results"][0]["link"], "https://t")

    def test_falls_back_to_google_when_tavily_is_down(self):
        """A Tavily outage must not tell the user we have no internet — it
        drops to Google. With Google unset too, and only then, we refuse."""
        async def _down(query, **kw):
            return {"ok": False, "error": "rate_limited"}

        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(lumi_agent.config, "GOOGLE_SEARCH_API_KEY", ""), \
                mock.patch.object(lumi_agent.config, "GOOGLE_CSE_ID", ""), \
                mock.patch.object(lumi_agent.tavily_search, "search", _down):
            res = asyncio.run(_tool("web_search").ainvoke({"query": "anything"}))
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "search_not_configured")


class FindPlaceToolTests(unittest.TestCase):
    def test_not_found_returns_ok_false_with_dont_invent_message(self):
        async def _none(_q):
            return None
        with mock.patch.object(lumi_agent.geo, "find_place", _none):
            res = asyncio.run(_tool("find_place").ainvoke({"query": "ghost co"}))
        self.assertFalse(res["ok"])
        self.assertIn("invent", res["message"].lower())

    def test_found_returns_address(self):
        async def _hit(_q):
            return {"name": "MER Group", "formatted": "Yahadut Canada 5, Or Yehuda",
                    "lat": 32.03, "lng": 34.85, "place_id": "PID"}
        with mock.patch.object(lumi_agent.geo, "find_place", _hit):
            res = asyncio.run(_tool("find_place").ainvoke({"query": "MER Group"}))
        self.assertTrue(res["ok"])
        self.assertEqual(res["address"], "Yahadut Canada 5, Or Yehuda")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class AskMyHistoryToolTests(unittest.TestCase):
    """The number comes from code; no opt-in means no number, and a failed
    lookup is never 0."""

    def _run(self, args, *, opted=True, report=None, search=None):
        rep = report or {"ok": True, "period": {"from": "2026-10-18", "to": "2026-10-20",
                                                "label": "this_week"},
                         "current": {"workouts": 2}, "previous": {"workouts": 1}}
        with mock.patch.object(lumi_agent.user_profile, "get_profile", return_value={"language": "he"}), \
                mock.patch.object(lumi_agent.history_store, "key_of", side_effect=lambda k: k), \
                mock.patch.object(lumi_agent.history_store, "opted_in", return_value=opted), \
                mock.patch.object(lumi_agent.history_store, "targets", return_value={"workouts": 3}), \
                mock.patch.object(lumi_agent.history_store, "report", mock.AsyncMock(return_value=rep)), \
                mock.patch.object(lumi_agent.history_store, "search",
                                  mock.AsyncMock(return_value=search or ([], None))):
            return asyncio.run(_tool("ask_my_history").ainvoke(args))

    def test_without_her_yes_there_is_no_number(self):
        out = self._run({"question": "כמה פעמים התאמנתי השבוע?"}, opted=False)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "not_opted_in")
        self.assertIn("פרטיות", out["say"])

    def test_the_counted_number_with_the_gap(self):
        out = self._run({"question": "כמה פעמים התאמנתי השבוע?"})
        self.assertEqual((out["metric"], out["value"], out["target"]), ("workouts", 2, 3))
        self.assertIn("2 אימונים", out["say"])
        self.assertIn("עוד 1", out["say"])

    def test_a_failed_report_is_not_zero(self):
        out = self._run({"question": "כמה פעמים התאמנתי?"}, report={"ok": False, "reason": "http_500"})
        self.assertFalse(out["ok"])
        self.assertNotIn("value", out)

    def test_an_open_question_is_counted_from_the_nearest_events(self):
        rows = [{"kind": "completed", "day": "2026-10-19", "text": "פגישת תזה"},
                {"kind": "completed", "day": "2026-10-20", "text": "תזה עם המנחה"},
                {"kind": "moved", "day": "2026-10-20", "text": "תזה"},            # a move is not a time she went
                {"kind": "completed", "day": "2026-10-01", "text": "תזה"}]        # outside the week
        out = self._run({"question": "כמה פעמים עבדתי על התזה?"}, search=(rows, None))
        self.assertEqual((out["metric"], out["value"]), ("matched", 2))
        self.assertIn("19.10", out["say"])

    def test_set_weekly_target_rejects_unknown_metrics(self):
        out = asyncio.run(_tool("set_weekly_target").ainvoke({"metric": "sleep", "value": 8}))
        self.assertFalse(out["ok"])
class TransitDisruptionsToolTests(unittest.TestCase):
    """The agent's door to transit_alerts: her home is the origin, and a
    search that could not run is never reported as 'no disruptions'."""

    def _run(self, args, result):
        seen = {}

        async def _dis(**kw):
            seen.update(kw)
            return result

        prof = {"homeAddress": "Dizengoff 50, Tel Aviv-Yafo, Israel", "transportType": "train",
                "language": "he"}
        with mock.patch.object(lumi_agent.user_profile, "get_profile", return_value=prof), \
                mock.patch.object(lumi_agent.transit_alerts, "disruptions_for", _dis):
            out = asyncio.run(_tool("transit_disruptions").ainvoke(args))
        return out, seen

    def test_home_and_profile_mode_feed_the_search(self):
        out, seen = self._run({"destination": "Herzl 3, Haifa, Israel", "lines": "115"},
                              {"ok": True, "checked": True, "alerts": []})
        self.assertIn("Haifa", seen["places"])
        self.assertIn("Tel Aviv-Yafo", seen["places"])
        self.assertIn("115", seen["lines"])
        self.assertIn("train", seen["modes"])
        self.assertIn("אין דיווחים", out["say"])

    def test_could_not_check_is_said_as_such(self):
        out, _ = self._run({"destination": "Haifa", "lines": "1"},
                           {"ok": False, "checked": False, "reason": "rate_limited"})
        self.assertFalse(out["checked"])
        self.assertIn("לא הצלחתי", out["say"])


class FindTimeTogetherToolTests(unittest.TestCase):
    def test_unknown_names_send_her_to_the_app(self):
        with mock.patch.object(lumi_agent.user_memory, "find_contact", return_value=None):
            out = asyncio.run(_tool("find_time_together").ainvoke(
                {"title": "party", "members": ["דנה"], "slots": ["2026-10-23 20:00"]}))
        self.assertEqual((out["ok"], out["need"], out["unknown"]), (False, "app", ["דנה"]))

    def test_known_contacts_create_the_group(self):
        create = mock.AsyncMock(return_value={"ok": True, "groupId": "g", "invites": []})
        with mock.patch.object(lumi_agent.user_memory, "find_contact",
                               return_value={"name": "Dana", "number": "972501111111"}), \
                mock.patch.object(lumi_agent.group_time, "create", create):
            out = asyncio.run(_tool("find_time_together").ainvoke(
                {"title": "party", "members": ["Dana"], "slots": ["2026-10-23 20:00", "bad"]}))
        self.assertTrue(out["ok"])
        args = create.await_args.args
        self.assertEqual(args[4], [{"day": "2026-10-23", "start": "20:00"}])
        self.assertEqual(args[5], [{"name": "Dana", "phone": "972501111111"}])
