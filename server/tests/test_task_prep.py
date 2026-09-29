"""task_prep — Meira prepares for any task, and never invents what she hands over.

Koral, 29.9: "I had a karaoke — why didn't Meira suggest songs to sing, with
the lyrics?" The model and Tavily are mocked; what is tested is what the CODE
guarantees: laundry costs no search, an uncited item never reaches her, every
failure says which one it is, and nothing about her goes into a search query
that the plan did not write.
"""
import asyncio
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import task_prep  # noqa: E402

KARAOKE = {"id": "k1", "text": "קריוקי באלנבי 30", "category": "leisure",
           "date": "2026-09-28", "time": "21:30", "location": "Allenby St 30"}
SOURCES = [
    {"title": "Top 20 karaoke songs in Hebrew", "link": "https://a.example/top20", "snippet": "…"},
    {"title": "Lyrics: Yellow — Coldplay", "link": "https://b.example/yellow", "snippet": "…"},
]


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = mock.patch.object(task_prep, "_PATH", os.path.join(self.tmp.name, "tp.json"))
        self.path.start()
        self.cfg = mock.patch.object(task_prep.tavily_search, "is_configured", return_value=True)
        self.cfg.start()
        self.mem = mock.patch.object(task_prep, "_memory_for", mock.AsyncMock(return_value=""))
        self.mem.start()

    def tearDown(self):
        self.path.stop(); self.cfg.stop(); self.mem.stop(); self.tmp.cleanup()


class Karaoke(Base):
    def test_songs_come_back_cited_and_uncited_ones_are_dropped(self):
        async def llm(source, system, user, max_tokens):
            if source == "task_prep_plan":
                return {"prep": True, "kind": "songs", "why": "karaoke night",
                        "queries": ["שירים לקריוקי בעברית", "karaoke songs lyrics"]}
            return {"headline_he": "שירים לתרגל", "headline_en": "Songs to practise",
                    "items_he": ["Yellow — Coldplay [2]", "שיר שהמציא המודל"],
                    "items_en": ["Yellow — Coldplay [2]", "Invented song [9]"]}
        search = mock.AsyncMock(return_value={"ok": True, "results": SOURCES})
        with mock.patch.object(task_prep, "_llm_json", llm), \
             mock.patch.object(task_prep.tavily_search, "search", search):
            out = run(task_prep.build(KARAOKE, "u1"))
        self.assertTrue(out["ok"])
        self.assertEqual(out["kind"], "songs")
        self.assertEqual(out["items_en"], ["Yellow — Coldplay [2]"])
        self.assertEqual(out["items_he"], ["Yellow — Coldplay [2]"])
        self.assertEqual(out["dropped_items"], 2)
        self.assertEqual(out["sources"][1]["link"], "https://b.example/yellow")
        # The searches are the plan's, about the task — nothing else was sent.
        sent = [c.args[0] for c in search.call_args_list]
        self.assertEqual(sent, ["שירים לקריוקי בעברית", "karaoke songs lyrics"])

    def test_second_ask_is_cached(self):
        calls = {"n": 0}

        async def llm(source, *a, **k):
            calls["n"] += 1
            if source == "task_prep_plan":
                return {"prep": True, "kind": "songs", "queries": ["karaoke songs"]}
            return {"headline_en": "x", "items_en": ["Yellow — Coldplay [1]"], "items_he": ["Yellow [1]"]}
        with mock.patch.object(task_prep, "_llm_json", llm), \
             mock.patch.object(task_prep.tavily_search, "search",
                               mock.AsyncMock(return_value={"ok": True, "results": SOURCES})):
            run(task_prep.build(KARAOKE, "u1"))
            again = run(task_prep.build(KARAOKE, "u1"))
        self.assertTrue(again["cached"])
        self.assertEqual(calls["n"], 2)

    def test_cache_is_per_user(self):
        task_prep._cache_write("u1", task_prep.task_key(KARAOKE), {"ok": True, "items_en": ["x [1]"]})
        self.assertIsNone(task_prep._cache_read("u2", task_prep.task_key(KARAOKE)))


class NothingToPrepare(Base):
    def test_laundry_costs_no_search(self):
        search = mock.AsyncMock()
        with mock.patch.object(task_prep, "_llm_json",
                               mock.AsyncMock(return_value={"prep": False, "why": "chore", "queries": []})), \
             mock.patch.object(task_prep.tavily_search, "search", search):
            out = run(task_prep.build({"id": "l", "text": "laundry"}, "u1"))
        self.assertEqual(out, {"ok": False, "reason": "nothing_to_prepare", "why": "chore"})
        search.assert_not_called()

    def test_prep_true_without_queries_is_not_prep(self):
        self.assertFalse(task_prep._clean_plan({"prep": True, "queries": []})["prep"])


class EveryFailureSaysWhich(Base):
    def test_reasons_are_distinct(self):
        with mock.patch.object(task_prep.tavily_search, "is_configured", return_value=False):
            self.assertEqual(run(task_prep.build(KARAOKE, "u1"))["reason"], "search_not_configured")
        with mock.patch.object(task_prep, "_llm_json", mock.AsyncMock(return_value=None)):
            self.assertEqual(run(task_prep.build(KARAOKE, "u1"))["reason"], "plan_failed")

        async def plan_ok(source, *a, **k):
            return {"prep": True, "kind": "songs", "queries": ["q"]} if source == "task_prep_plan" else None
        with mock.patch.object(task_prep, "_llm_json", plan_ok), \
             mock.patch.object(task_prep.tavily_search, "search",
                               mock.AsyncMock(return_value={"ok": False, "error": "rate_limited"})):
            self.assertEqual(run(task_prep.build(KARAOKE, "u1", force=True))["reason"], "no_sources")
        with mock.patch.object(task_prep, "_llm_json", plan_ok), \
             mock.patch.object(task_prep.tavily_search, "search",
                               mock.AsyncMock(return_value={"ok": True, "results": SOURCES})):
            self.assertEqual(run(task_prep.build(KARAOKE, "u1", force=True))["reason"], "compose_failed")

    def test_all_items_uncited_is_its_own_reason(self):
        async def llm(source, *a, **k):
            if source == "task_prep_plan":
                return {"prep": True, "kind": "songs", "queries": ["q"]}
            return {"items_en": ["made up"], "items_he": ["מומצא"]}
        with mock.patch.object(task_prep, "_llm_json", llm), \
             mock.patch.object(task_prep.tavily_search, "search",
                               mock.AsyncMock(return_value={"ok": True, "results": SOURCES})):
            self.assertEqual(run(task_prep.build(KARAOKE, "u1"))["reason"], "nothing_cited")


class Deletion(unittest.TestCase):
    def test_store_is_on_the_deletion_list(self):
        import account_deletion
        self.assertIn("task_prep", account_deletion._STORE_MODULES)


if __name__ == "__main__":
    unittest.main()
