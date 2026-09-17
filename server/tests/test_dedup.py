"""Duplicate-task scoring: differently-worded same task vs genuinely different.

The app shows many versions of one task because read-time dedup compares EXACT
text — "חדר כושר 6" and "אימון 18:00" are the same appointment and both survive.
These tests pin the hybrid scorer: structured facts (date/time/place/category)
carry the decision, text similarity refines it, and embeddings are optional.

No network: embeddings are not configured in the test env, so every case here
exercises the lexical + structured fallback — which is the path that must be
correct on its own, since Nebius's documented embedding model is English-only.
"""
import os
import tempfile
import unittest

_TMP = tempfile.mkdtemp()
os.environ["DATA_DIR"] = _TMP

import config  # noqa: E402
config.DATA_DIR = _TMP
config.EMBED_MODEL = None          # force the no-embeddings path

import dedup_service  # noqa: E402


def task(tid, text, date="2026-09-01", time=None, loc=None, cat=None, created=1):
    return {"id": tid, "text": text, "date": date, "fixedTime": time,
            "location": loc, "category": cat, "status": "pending",
            "createdAt": created}


class StructuredScoreTests(unittest.TestCase):
    def test_different_days_never_match(self):
        a = task("a", "ראיון עבודה", date="2026-09-01", time="10:00")
        b = task("b", "ראיון עבודה", date="2026-09-02", time="10:00")
        self.assertEqual(dedup_service.structured_score(a, b), 0.0)

    def test_same_day_different_time_is_not_a_duplicate(self):
        """Two gym slots on one day are two real tasks, not a duplicate."""
        a = task("a", "אימון", time="08:00")
        b = task("b", "אימון", time="18:00")
        self.assertEqual(dedup_service.pair_score(a, b), 0.0)

    def test_same_day_same_time_different_wording_IS_a_duplicate(self):
        """THE reported bug — different words, same appointment."""
        a = task("a", "חדר כושר", time="18:00", cat="gym")
        b = task("b", "אימון ערב", time="18:00", cat="gym")
        self.assertGreaterEqual(dedup_service.pair_score(a, b),
                                dedup_service.DUPLICATE_THRESHOLD)

    def test_one_task_missing_a_time_still_compares(self):
        """A timeless row and a timed row on one day can still be the same."""
        a = task("a", "ראיון עבודה במגדלי אמזון", time="10:00")
        b = task("b", "ראיון עבודה במגדלי אמזון")
        self.assertGreater(dedup_service.pair_score(a, b), dedup_service.UNSURE_THRESHOLD)

    def test_unrelated_same_slot_tasks_do_not_merge(self):
        """Same day and hour is suggestive, but the text must not contradict."""
        a = task("a", "לקנות חלב ולחם במכולת", time="10:00", cat="general")
        b = task("b", "ראיון עבודה במגדלי אמזון", time="10:00", cat="interview")
        self.assertLess(dedup_service.pair_score(a, b), dedup_service.DUPLICATE_THRESHOLD)


class MergeTests(unittest.TestCase):
    def test_richest_row_survives_and_absorbs_the_rest(self):
        """Merging must never lose a location or a time."""
        bare = task("bare", "ראיון", time="10:00", created=5)
        rich = task("rich", "ראיון עבודה", time="10:00",
                    loc={"address": "מגדלי אמזון"}, cat="interview", created=9)
        winner, losers = dedup_service.merge_fields([bare, rich])
        self.assertEqual(winner["id"], "rich")
        self.assertEqual([l["id"] for l in losers], ["bare"])
        self.assertEqual(winner["location"]["address"], "מגדלי אמזון")

    def test_survivor_gains_fields_it_lacked(self):
        """A located row outranks a wordier one — a location is what enables
        routing — and the survivor still absorbs the other's time."""
        timed_no_loc = task("a", "ראיון עבודה מפורט מאוד כאן", time="10:00", created=1)
        located_no_time = task("b", "ראיון", loc={"address": "תל אביב"}, created=2)
        winner, losers = dedup_service.merge_fields([timed_no_loc, located_no_time])
        self.assertEqual(winner["id"], "b", "the located row survives")
        self.assertEqual([l["id"] for l in losers], ["a"])
        self.assertEqual(winner["fixedTime"], "10:00", "absorbed the time it lacked")


class CosineTests(unittest.TestCase):
    def test_cosine_basics(self):
        self.assertAlmostEqual(dedup_service.cosine([1, 0], [1, 0]), 1.0)
        self.assertAlmostEqual(dedup_service.cosine([1, 0], [0, 1]), 0.0)
        self.assertEqual(dedup_service.cosine([], [1, 0]), 0.0, "empty is safe")
        self.assertEqual(dedup_service.cosine([1, 0, 0], [1, 0]), 0.0, "length mismatch is safe")


class NoEmbeddingsFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_embeddings_disabled_returns_none_not_an_error(self):
        """Dedup must still run with no embedding model configured."""
        self.assertIsNone(await dedup_service.embed_texts(["שלום"]))

    async def test_clustering_works_without_embeddings(self):
        rows = [
            task("1", "חדר כושר", time="18:00", cat="gym"),
            task("2", "אימון ערב", time="18:00", cat="gym"),
            task("3", "ראיון עבודה", time="10:00", cat="interview"),
        ]
        clusters = await dedup_service.find_clusters(rows)
        self.assertEqual(len(clusters), 1, "the two gym rows cluster, the interview stands alone")
        self.assertEqual({t["id"] for t in clusters[0]}, {"1", "2"})


if __name__ == "__main__":
    unittest.main()
