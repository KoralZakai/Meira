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
