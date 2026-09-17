"""The Hebrew sentence that produced a task in no place at all.

Reported: "מחר לחתום אבטלה בנהריה ב10 בבוקר" hit a generic fallback. The model
step is the only thing that ever read a location, so whenever it failed — no
key, a timeout, a refusal — every task came back with location None and the
whole sentence as its title.

Hebrew marks place with the prefix ב ("in/at") and marks the clock with the
SAME letter, which is why this needs care rather than one regex: "בנהריה" is a
town, "ב10" and "בבוקר" are a time.
"""
import datetime
import unittest

import task_extract


class HebrewPlaceFallback(unittest.TestCase):
    def test_extracts_the_town_not_the_hour(self):
        text = "מחר לחתום אבטלה בנהריה ב10 בבוקר"
        self.assertEqual(task_extract.extract_place(text), "נהריה")

    def test_time_words_are_never_places(self):
        for text in ("ב10 בבוקר", "פגישה בערב", "נחזור בצהריים", "מתחיל בלילה"):
            self.assertIsNone(task_extract.extract_place(text), text)

    def test_multiword_places(self):
        self.assertEqual(task_extract.extract_place("ראיון בתל אביב"), "תל אביב")

    def test_english_places_too(self):
        self.assertEqual(task_extract.extract_place("interview at Tel Aviv University"),
                         "Tel Aviv University")

    def test_the_title_loses_the_when_and_the_where(self):
        text = "מחר לחתום אבטלה בנהריה ב10 בבוקר"
        place = task_extract.extract_place(text)
        self.assertEqual(task_extract.strip_when(task_extract.strip_place(text, place)),
                         "לחתום אבטלה")

    def test_the_whole_sentence_end_to_end(self):
        """Every field the timeline needs, with no model available."""
        task = task_extract.finalize({}, "מחר לחתום אבטלה בנהריה ב10 בבוקר",
                                     datetime.date(2026, 9, 8))
        self.assertEqual(task["text"], "לחתום אבטלה")
        self.assertEqual(task["location"], "נהריה")
        self.assertEqual(task["fixed_time"], "10:00")
        self.assertEqual(task["date"], "2026-09-09")      # tomorrow, not today

    def test_a_model_written_title_is_left_alone(self):
        """Cleaning applies only when we fell back to the raw sentence."""
        task = task_extract.finalize(
            {"text": "לחתום אבטלה", "location": "נהריה", "date_expression": "מחר"},
            "מחר לחתום אבטלה בנהריה ב10 בבוקר", datetime.date(2026, 9, 8))
        self.assertEqual(task["text"], "לחתום אבטלה")
        self.assertEqual(task["location"], "נהריה")


if __name__ == "__main__":
    unittest.main()
