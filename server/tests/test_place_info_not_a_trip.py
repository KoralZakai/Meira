"""A question about a place's hours is not a trip to it (live eval 20.10)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import understand  # noqa: E402

POST = {"what": "places", "category": "סניף דואר", "modes": [], "origin": "auto"}


class PlaceInfoTest(unittest.TestCase):
    def test_hours_questions_drop_the_lookup(self):
        for m in ("מה שעות הפתיחה של הדואר בישראל?", "עד מתי הדואר פתוח היום?",
                  "what are the opening hours of the post office?",
                  "what time does the post office close?"):
            self.assertIsNone(understand.lookup_of(POST, m), m)
        self.assertIsNone(understand.lookup_of(
            {"what": "route", "destination": "הדואר"}, "מתי הדואר נסגר?"))

    def test_getting_there_still_looks_up(self):
        for m in ("איפה הדואר הכי קרוב?", "where is the nearest post office?"):
            self.assertEqual(understand.lookup_of(POST, m)["what"], "places", m)

    def test_the_prompt_says_a_bare_todo_is_a_save(self):
        self.assertIn("ללכת לבנק מחר", understand._SYSTEM)

    def test_the_prompt_keeps_the_title_in_her_language(self):
        # "go to the bank tomorrow" was saved as "לך לבנק" (live, 20.10).
        self.assertIn("English message → English title", understand._SYSTEM)

    def test_an_english_message_never_saves_a_hebrew_title(self):
        from datetime import date
        cases = [("buy a gift for Noa on Thursday", "מתנה לנועה", "Thursday", "Buy a gift for Noa"),
                 ("go to the bank tomorrow", "לך לבנק", "tomorrow", "Go to the bank"),
                 ("add a call with Dotan at 9:30", "שיחה עם דותן", None, "Call with Dotan")]
        for msg, title, expr, want in cases:
            t = understand.task_from({"do": "add", "title": title, "date_expression": expr,
                                      "start": None}, msg, date(2026, 10, 20))
            self.assertEqual(t["text"], want, msg)
        t = understand.task_from({"do": "add", "title": "מתנה לנועה", "date_expression": "ביום חמישי"},
                                 "לקנות מתנה לנועה ביום חמישי", date(2026, 10, 20))
        self.assertEqual(t["text"], "מתנה לנועה")


if __name__ == "__main__":
    unittest.main()
