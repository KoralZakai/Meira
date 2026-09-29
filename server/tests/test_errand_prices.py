"""errand_prices — a price she sees is a price the page states.

Tavily and the model are mocked. What is tested is the CODE's guarantee: a
number that is not in the cited snippet never reaches her, a dead search key
is not "no price", and the query is about the place, not about her.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import errand_prices  # noqa: E402

PLACE = {"place_id": "p1", "name": "מכבסת הים", "address": "Ben Yehuda 120, Tel Aviv-Yafo, Israel"}
SNIPS = [{"title": "מכבסת הים — מחירון", "link": "https://yam.example/prices",
          "snippet": "כביסה וקיפול 12 ₪ לק\"ג. ניקוי יבש לחולצה 18 ₪."},
         {"title": "Reviews", "link": "https://r.example", "snippet": "Friendly staff."}]


def run(c):
    return asyncio.run(c)


class Prices(unittest.TestCase):
    def setUp(self):
        errand_prices._cache.clear()
        self.cfg = mock.patch.object(errand_prices.tavily_search, "is_configured", return_value=True)
        self.cfg.start()

    def tearDown(self):
        self.cfg.stop()

    def _with(self, read, search=None):
        s = mock.AsyncMock(return_value=search or {"ok": True, "results": SNIPS})
        return (mock.patch.object(errand_prices.tavily_search, "search", s),
                mock.patch.object(errand_prices, "_read", mock.AsyncMock(return_value=read)), s)

    def test_a_price_the_page_states_is_kept_with_its_source(self):
        a, b, _ = self._with({"price": "12 ₪ לק\"ג", "source": 1})
        with a, b:
            got = run(errand_prices.price_for(PLACE, "מכבסה"))
        self.assertEqual(got["price"], "12 ₪ לק\"ג")
        self.assertEqual(got["source_url"], "https://yam.example/prices")

    def test_an_invented_number_is_dropped(self):
        a, b, _ = self._with({"price": "₪30 per load", "source": 1})
        with a, b:
            got = run(errand_prices.price_for(PLACE, "מכבסה"))
        self.assertNotIn("price", got)
        self.assertEqual(got["reason"], "price_not_in_source")

    def test_a_price_cited_to_the_wrong_snippet_is_dropped(self):
        a, b, _ = self._with({"price": "18 ₪", "source": 2})
        with a, b:
            self.assertNotIn("price", run(errand_prices.price_for(PLACE, "מכבסה")))

    def test_no_price_in_the_snippets_says_so(self):
        a, b, _ = self._with({"price": "", "source": 0})
        with a, b:
            self.assertEqual(run(errand_prices.price_for(PLACE, "מכבסה"))["reason"], "no_price_published")

    def test_a_dead_search_key_is_not_no_price(self):
        a, b, _ = self._with({"price": "12 ₪", "source": 1}, search={"ok": False, "error": "unauthorized"})
        with a, b:
            self.assertEqual(run(errand_prices.price_for(PLACE, "מכבסה"))["reason"], "search_failed: unauthorized")

    def test_the_query_is_about_the_place_not_her(self):
        q = errand_prices.query_for(PLACE, "מכבסה")
        self.assertIn("מכבסת הים", q)
        self.assertIn("Tel Aviv-Yafo", q)

    def test_enrich_marks_each_place(self):
        a, b, s = self._with({"price": "12 ₪ לק\"ג", "source": 1})
        cands = [dict(PLACE), {**PLACE, "place_id": "p2"}, {**PLACE, "place_id": "p3"}, {**PLACE, "place_id": "p4"}]
        with a, b:
            run(errand_prices.enrich(cands, "מכבסה"))
        self.assertTrue(all("price" in c for c in cands[:3]))
        self.assertNotIn("price", cands[3])   # at most MAX_PLACES searches
        self.assertEqual(s.await_count, 3)

    def test_verified(self):
        self.assertTrue(errand_prices.verified("from ₪1,200", "prices from ₪1200 a month"))
        self.assertFalse(errand_prices.verified("₪35", "no numbers here"))
        self.assertFalse(errand_prices.verified("cheap", "cheap and cheerful"))
        self.assertFalse(errand_prices.verified("₪35", "a set menu for ₪135"))


if __name__ == "__main__":
    unittest.main()
