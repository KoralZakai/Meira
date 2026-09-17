"""The Tavily-backed tools: read_page, place_live_info, recency, agent watch.

Every test pins the same thing from a different angle: these tools must refuse
plainly when they cannot answer, and must never hand the model something it
could dress up as fact. A closed shop reported as "closed" when the evidence is
a phrase in a snippet is the failure mode here, so `closed_hint` is a hint and
is tested as one.

No test may leave Tavily configured with a real key — that would make a live,
billed call on every CI run.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import agent_runner  # noqa: E402
import lumi_agent  # noqa: E402
import tavily_search  # noqa: E402


def _tool(name):
    for t in lumi_agent._make_tools("_test_phone_", "hi"):
        if getattr(t, "name", None) == name:
            return t
    raise AssertionError(f"tool {name!r} not found")


class ReadPageTests(unittest.TestCase):
    def test_it_refuses_a_url_the_model_invented(self):
        """Only URLs that came back from web_search are openable. A composed
        one is the model guessing, and guessed links are this codebase's
        oldest bug."""
        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", "tvly-test"):
            res = asyncio.run(_tool("read_page").ainvoke({"url": "example.com/jobs"}))
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "bad_url")

    def test_it_returns_the_page_text(self):
        async def _extract(urls, **kw):
            return {"ok": True, "pages": [{"url": urls[0], "text": "Full job description…"}]}
        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(lumi_agent.tavily_search, "extract", _extract):
            res = asyncio.run(_tool("read_page").ainvoke({"url": "https://x.com/job"}))
        self.assertTrue(res["ok"])
        self.assertIn("Full job description", res["text"])

    def test_an_empty_page_is_a_refusal_not_an_empty_answer(self):
        async def _extract(urls, **kw):
            return {"ok": True, "pages": [{"url": urls[0], "text": ""}]}
        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(lumi_agent.tavily_search, "extract", _extract):
            res = asyncio.run(_tool("read_page").ainvoke({"url": "https://x.com/job"}))
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "empty")


class PlaceLiveInfoTests(unittest.TestCase):
    @staticmethod
    def _search_returning(snippet):
        async def _search(query, **kw):
            return {"ok": True, "query": query,
                    "results": [{"title": "t", "link": "https://l", "snippet": snippet}]}
        return _search

    def test_a_closure_phrase_becomes_a_hint_not_a_verdict(self):
        with mock.patch.object(tavily_search.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(tavily_search, "search",
                                  self._search_returning("This location is permanently closed")):
            res = asyncio.run(tavily_search.place_facts("Space Gym"))
        self.assertTrue(res["ok"])
        self.assertTrue(res["closed_hint"])      # a hint …
        self.assertNotIn("closed", str(res.get("answer") or ""))  # … not an assertion

    def test_an_ordinary_listing_raises_no_closure_hint(self):
        with mock.patch.object(tavily_search.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(tavily_search, "search",
                                  self._search_returning("Open today 06:00-23:00")):
            res = asyncio.run(tavily_search.place_facts("Space Gym"))
        self.assertFalse(res["closed_hint"])

    def test_hebrew_closure_wording_is_caught_too(self):
        """Most of what Lumi reads about Israeli businesses is in Hebrew — an
        English-only marker list would find nothing, which is how every
        fallback regex in this project broke the first time."""
        with mock.patch.object(tavily_search.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(tavily_search, "search",
                                  self._search_returning("העסק נסגר בחודש שעבר")):
            res = asyncio.run(tavily_search.place_facts("חדר כושר"))
        self.assertTrue(res["closed_hint"])


class RecencyTests(unittest.TestCase):
    def test_recent_days_switches_the_search_to_news(self):
        seen = {}

        async def _search(query, **kw):
            seen.update(kw)
            return {"ok": True, "query": query, "results": []}

        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(lumi_agent.tavily_search, "search", _search):
            asyncio.run(_tool("web_search").ainvoke({"query": "Ceva", "recent_days": 30}))
        self.assertEqual(seen["topic"], "news")
        self.assertEqual(seen["days"], 30)

    def test_the_default_search_is_not_date_filtered(self):
        """A background fact is not news; filtering by date would hide the best
        source for 'what does this company do'."""
        seen = {}

        async def _search(query, **kw):
            seen.update(kw)
            return {"ok": True, "query": query, "results": []}

        with mock.patch.object(lumi_agent.config, "TAVILY_API_KEY", "tvly-test"), \
                mock.patch.object(lumi_agent.tavily_search, "search", _search):
            asyncio.run(_tool("web_search").ainvoke({"query": "what is an NPU"}))
        self.assertEqual(seen["topic"], "general")
        self.assertIsNone(seen["days"])


class AgentWatchTests(unittest.TestCase):
    def test_an_agent_without_a_watch_makes_no_search(self):
        called = []
        with mock.patch.object(agent_runner.tavily_search, "search",
                               lambda *a, **k: called.append(1)):
            facts = asyncio.run(agent_runner._watch_facts({"name": "planner"}))
        self.assertEqual(facts, "")
        self.assertEqual(called, [])

    def test_a_watch_becomes_facts_with_links(self):
        async def _search(query, **kw):
            return {"ok": True, "results": [
                {"title": "Ceva wins award", "link": "https://n/1", "snippet": "…"}]}
        with mock.patch.object(agent_runner.tavily_search, "is_configured", lambda: True), \
                mock.patch.object(agent_runner.tavily_search, "search", _search):
            facts = asyncio.run(agent_runner._watch_facts({"watch": "Ceva news"}))
        self.assertIn("Ceva wins award", facts)
        self.assertIn("https://n/1", facts)

    def test_no_news_is_silence_not_an_apology(self):
        """An agent that fires on a quiet week must simply not mention news —
        never explain that its search failed."""
        async def _empty(query, **kw):
            return {"ok": True, "results": []}
        with mock.patch.object(agent_runner.tavily_search, "is_configured", lambda: True), \
                mock.patch.object(agent_runner.tavily_search, "search", _empty):
            self.assertEqual(asyncio.run(agent_runner._watch_facts({"watch": "x"})), "")


if __name__ == "__main__":
    unittest.main()
