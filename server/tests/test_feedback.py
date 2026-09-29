"""feedback_store — a 👍/👎 changes what Meira does next, visibly and in code.

29.9: "how does Meira learn?" — until now, never from whether a suggestion was
any good. Places, the model and the network are mocked.
"""
import asyncio
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import errands_along  # noqa: E402
import feedback_store  # noqa: E402
import task_prep  # noqa: E402

KEY = "u1"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = mock.patch.object(feedback_store, "_PATH", os.path.join(self.tmp.name, "fb.json"))
        self.p.start()
        self.mem = mock.patch("user_memory.add_insight")
        self.insight = self.mem.start()

    def tearDown(self):
        self.p.stop(); self.mem.stop(); self.tmp.cleanup()


class Store(Base):
    def test_a_verdict_becomes_a_memory_sentence(self):
        feedback_store.record(KEY, "prep", "down", "Karaoke at Allenby", about="songs", reason="not useful")
        args = self.insight.call_args.args
        self.assertEqual(args[:2], (KEY, "preference"))
        self.assertIn("did not want preparation: Karaoke at Allenby (songs) — not useful", args[2])
        self.assertIn("did not want", feedback_store.lines(KEY, "prep"))

    def test_changing_her_mind_replaces_the_old_verdict(self):
        feedback_store.record(KEY, "errand", "down", "Yam laundry", place_id="p1")
        feedback_store.record(KEY, "errand", "up", "Yam laundry", place_id="p1")
        self.assertEqual(feedback_store.place_verdict(KEY, "p1"), "up")
        self.assertEqual(len(feedback_store.verdicts(KEY)), 1)

    def test_bad_input_is_refused(self):
        for args in (("nope", "up", "x"), ("errand", "meh", "x"), ("errand", "up", "  ")):
            with self.assertRaises(ValueError):
                feedback_store.record(KEY, *args)

    def test_verdicts_are_per_person(self):
        feedback_store.record(KEY, "errand", "down", "Yam", place_id="p1")
        self.assertIsNone(feedback_store.place_verdict("someone-else", "p1"))


def _places(names_ratings):
    """Fake Places: every sample finds the same shops, all open."""
    results = [{"place_id": pid, "name": pid, "formatted_address": "x, Tel Aviv",
                "geometry": {"location": {"lat": 32.0, "lng": 34.78}}, "rating": r}
               for pid, r in names_ratings]
    return mock.AsyncMock(return_value=results)


class Ranking(Base):
    PLAN = {"errand": True, "query_he": "מכבסה", "query_en": "laundromat", "minutes": 15, "why": ""}
    TRIP = [{"polyline": "_p~iF~ps|U_ulLnnqC", "leave": "08:00", "arrive": "08:40", "date": "2026-10-01"}]

    def _run(self, user_key=None):
        details = mock.AsyncMock(return_value={"periods": None, "weekday_text": []})
        with mock.patch.object(errands_along, "_nearby", _places([("best", 4.9), ("good", 4.5), ("ok", 4.0)])), \
             mock.patch.object(errands_along, "_details", details), \
             mock.patch.object(errands_along, "distance_to_route", return_value=100.0), \
             mock.patch.object(errands_along.config, "GOOGLE_MAPS_API_KEY", "k"), \
             mock.patch("errand_prices.enrich", mock.AsyncMock()):
            return asyncio.run(errands_along.along("laundry", self.TRIP, plan=self.PLAN, user_key=user_key))

    def test_without_verdicts_nothing_changes(self):
        res = self._run(KEY)
        self.assertEqual([c["place_id"] for c in res["candidates"]], ["best", "good", "ok"])
        self.assertTrue(res["candidates"][0]["recommended"])

    def test_a_turned_down_place_sinks_and_is_never_the_pick(self):
        feedback_store.record(KEY, "errand", "down", "best", place_id="best")
        res = self._run(KEY)
        ids = [c["place_id"] for c in res["candidates"]]
        self.assertEqual(ids[-1], "best")
        pick = [c for c in res["candidates"] if c.get("recommended")]
        self.assertEqual(pick[0]["place_id"], "good")
        self.assertEqual(res["candidates"][-1]["your_verdict"], "down")

    def test_a_liked_place_moves_up_and_says_why(self):
        feedback_store.record(KEY, "errand", "up", "ok", place_id="ok")
        res = self._run(KEY)
        self.assertEqual(res["candidates"][0]["place_id"], "ok")
        self.assertIn("you liked it before", res["candidates"][0]["why"])

    def test_anonymous_call_is_unchanged(self):
        feedback_store.record(KEY, "errand", "down", "best", place_id="best")
        res = self._run(None)
        self.assertEqual(res["candidates"][0]["place_id"], "best")


class PrepMemory(Base):
    def test_prep_planner_sees_her_verdicts_even_without_retrieval(self):
        feedback_store.record(KEY, "prep", "down", "Karaoke", about="songs", reason="I only sing Hebrew")
        with mock.patch("memory_recall.block_for", mock.AsyncMock(return_value=None)):
            block = asyncio.run(task_prep._memory_for(KEY, "Karaoke"))
        self.assertIn("I only sing Hebrew", block)

    def test_forget_drops_the_cached_prep(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(task_prep, "_PATH", os.path.join(d, "tp.json")):
            task_prep._cache_write(KEY, "k1", {"ok": True, "task": {"text": "Karaoke"}})
            task_prep._cache_write(KEY, "k2", {"ok": True, "task": {"text": "Dentist"}})
            self.assertEqual(task_prep.forget(KEY, "karaoke"), 1)
            self.assertIsNone(task_prep._cache_read(KEY, "k1"))
            self.assertIsNotNone(task_prep._cache_read(KEY, "k2"))


if __name__ == "__main__":
    unittest.main()
