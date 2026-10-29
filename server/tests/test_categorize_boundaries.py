"""A keyword must START a word - "דחוף" is not a beach, "brunch" is not a run.

The evaluation harness (server/evals, accuracy suite) found that categorize.infer
matched keywords as bare substrings:

    "דחוף לשלוח מייל לבוס"     -> leisure   ("חוף", the beach, sits inside "דחוף", urgent)
    "brunch with Dana"         -> gym       ("run" sits inside "brunch")
    "פגישת צוות" (team meeting) -> general   (only the "פגישה" spelling was listed)

Hebrew glues one-letter prefixes (ב ל מ ה ו ש כ) onto a word, so a keyword may be
preceded by up to two of those and by no other letter; the END of a keyword stays
open so "אימון" still finds "אימונים". tests/run-categorize-parity.ts runs the
same fixture through the TypeScript port.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import categorize  # noqa: E402
from categorize import has_keyword, infer  # noqa: E402

GOLDEN = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                      "tests", "fixtures", "categorize-golden.json")


class HasKeyword(unittest.TestCase):
    def test_a_keyword_inside_a_longer_word_does_not_count(self):
        for text, kw in [("דחוף לשלוח", "חוף"), ("brunch", "run"), ("bring", "ring"),
                         ("during", "ring"), ("recall", "call"), ("headphones", "phone"),
                         ("async", "sync"), ("11:15", "1:1"), ("1:15", "1:1")]:
            self.assertFalse(has_keyword(text, kw), f"{kw!r} in {text!r}")

    def test_a_keyword_that_starts_a_word_counts(self):
        for text, kw in [("run", "run"), ("a run", "run"), ("running late", "run"),
                         ("go-run", "run"), ("חוף", "חוף"), ("יום בחוף", "חוף"),
                         ("אימונים", "אימונ"), ("meeting 1:1", "1:1"), ("(call mom)", "call")]:
            self.assertTrue(has_keyword(text, kw), f"{kw!r} in {text!r}")

    def test_one_or_two_hebrew_prefix_letters_are_allowed_but_not_three(self):
        self.assertTrue(has_keyword("בחוף", "חוף"))          # ב
        self.assertTrue(has_keyword("מהחוף", "חוף"))         # מ + ה
        self.assertTrue(has_keyword("ולחוף", "חוף"))         # ו + ל
        self.assertFalse(has_keyword("ושבחוף", "חוף"))       # three prefixes: not a word we know
        self.assertFalse(has_keyword("דחוף", "חוף"))         # ד is not a prefix
        self.assertFalse(has_keyword("תחוף", "חוף"))

    def test_a_prefix_only_counts_at_the_start_of_the_word(self):
        # "מ" + "פגישה" is a word; "מ" glued after a non-prefix letter is not.
        self.assertTrue(has_keyword("מפגישה", "פגישה"))
        self.assertFalse(has_keyword("אמפגישה", "פגישה"))

    def test_a_later_occurrence_is_found_when_the_first_is_inside_a_word(self):
        self.assertTrue(has_keyword("brunch then run", "run"))
        self.assertTrue(has_keyword("דחוף, ללכת לחוף", "חוף"))

    def test_digit_keywords_do_not_run_on(self):
        self.assertTrue(has_keyword("1:1 with Dana", "1:1"))
        self.assertTrue(has_keyword("at 1:1.", "1:1"))
        self.assertFalse(has_keyword("at 1:15", "1:1"))
        self.assertFalse(has_keyword("at 21:15", "1:1"))


class TheEvalFindings(unittest.TestCase):
    def test_urgent_is_not_a_beach(self):
        got = infer("דחוף לשלוח מייל לבוס")
        self.assertEqual((got["category"], got["priority"]), ("general", "must"))

    def test_brunch_is_leisure_not_gym(self):
        self.assertEqual(infer("brunch with Dana on Friday")["category"], "leisure")

    def test_team_meeting_in_the_construct_form_is_a_meeting(self):
        self.assertEqual(infer("פגישת צוות")["category"], "meeting")

    def test_the_beach_still_is(self):
        self.assertEqual(infer("יום בחוף")["category"], "leisure")
        self.assertEqual(infer("beach day")["category"], "leisure")

    def test_water_is_not_the_sea(self):
        self.assertEqual(infer("לקנות מים")["category"], "general")
        self.assertEqual(infer("לצאת לים")["category"], "leisure")


class GoldenFixture(unittest.TestCase):
    """The same file tests/run-categorize-parity.ts runs through the TS port."""

    def test_every_case_gets_its_hand_labelled_answer(self):
        with open(GOLDEN, encoding="utf-8") as handle:
            cases = json.load(handle)["cases"]
        self.assertGreater(len(cases), 20)
        for case in cases:
            with self.subTest(text=case["text"]):
                got = infer(case["text"])
                self.assertEqual((got["category"], got["priority"]),
                                 (case["category"], case["priority"]))

    def test_every_category_in_the_fixture_is_a_real_one(self):
        with open(GOLDEN, encoding="utf-8") as handle:
            cases = json.load(handle)["cases"]
        for case in cases:
            self.assertIn(case["category"], categorize.VALID_CATEGORIES)
            self.assertIn(case["priority"], categorize.VALID_PRIORITIES)


if __name__ == "__main__":
    unittest.main()
