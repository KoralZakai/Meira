"""The reply must describe what was actually saved.

From a real conversation at 03:37 on Friday 28.8 — Lumi said one thing and
stored another, twice in two messages:

    "ב 11:00 יוגה ביגאל אלון 94"
        reply "✓ הוספתי ליום שישי, 28.8 | 11:00"   stored 2026-08-29
    "מחר שיחה ב 10:09 עם זוהר גיא"
        reply "✓ הוספתי ליום שישי, 28.8 | 10:09"   stored 2026-08-29, 10:00

The user reads the reply, believes the task is on Friday, and never sees it —
it is filed on Saturday. The prose is the model's; the tool argument is the
record, so where they disagree the record wins.
"""
import unittest
from datetime import date

import reply_consistency as rc


class ReplyDateTests(unittest.TestCase):
    def test_the_reported_bug_hebrew(self):
        out, n = rc.correct_reply_dates("✓ הוספתי ליום שישי, 28.8 | 11:00", date(2026, 8, 29))
        self.assertIn("29.8", out)
        self.assertIn("יום שבת", out)
        self.assertNotIn("28.8", out)
        self.assertNotIn("שישי", out)
        self.assertEqual(n, 2)

    def test_a_correct_reply_is_left_byte_identical(self):
        # The common case. Rewriting a correct reply would churn her messages
        # for nothing and risk mangling the model's phrasing.
        good = "✓ הוספתי ליום שבת, 29.8 | 11:00 🧘‍♀️ יוגה"
        out, n = rc.correct_reply_dates(good, date(2026, 8, 29))
        self.assertEqual(out, good)
        self.assertEqual(n, 0)

    def test_english_weekday(self):
        out, n = rc.correct_reply_dates("✓ Added for Friday, 28.8", date(2026, 8, 29))
        self.assertIn("Saturday", out)
        self.assertIn("29.8", out)
        self.assertEqual(n, 2)

    def test_slash_separator_is_preserved(self):
        out, _ = rc.correct_reply_dates("נשמר ל-28/8", date(2026, 8, 29))
        self.assertIn("29/8", out)

    def test_emoji_and_wording_survive(self):
        out, _ = rc.correct_reply_dates(
            "✿ ✓ הוספתי ליום שישי, 28.8 | 11:00\n🧘‍♀️ יוגה – יגאל אלון 94", date(2026, 8, 29))
        self.assertIn("🧘‍♀️ יוגה – יגאל אלון 94", out)
        self.assertIn("✿", out)

    def test_a_clock_time_is_never_read_as_a_date(self):
        # "11:00" must survive untouched — only D.M forms are dates.
        out, n = rc.correct_reply_dates("ב-11:00 ליום שבת, 29.8", date(2026, 8, 29))
        self.assertIn("11:00", out)
        self.assertEqual(n, 0)

    def test_non_dates_are_left_alone(self):
        # 13.45 is not a date (no 13th month); must not be rewritten.
        out, n = rc.correct_reply_dates("עלות 13.45 שקל", date(2026, 8, 29))
        self.assertIn("13.45", out)
        self.assertEqual(n, 0)

    def test_empty_reply_is_safe(self):
        self.assertEqual(rc.correct_reply_dates("", date(2026, 8, 29)), ("", 0))
        self.assertEqual(rc.correct_reply_dates("שלום", None), ("שלום", 0))


class TaskTimeTests(unittest.TestCase):
    def test_the_reported_bug_minutes_restored(self):
        task, fixed = rc.correct_task_time({"fixed_time": "10:00"}, "מחר שיחה ב 10:09 עם זוהר גיא")
        self.assertTrue(fixed)
        self.assertEqual(task["fixed_time"], "10:09")

    def test_an_already_correct_time_is_untouched(self):
        task, fixed = rc.correct_task_time({"fixed_time": "10:09"}, "שיחה ב 10:09")
        self.assertFalse(fixed)
        self.assertEqual(task["fixed_time"], "10:09")

    def test_a_different_hour_is_a_real_decision_not_a_typo(self):
        # "יוגה ב-11:00" scheduled with a 09:00 prep reminder must NOT be
        # dragged to 11:00 — the model chose that time deliberately.
        task, fixed = rc.correct_task_time({"fixed_time": "09:00"}, "יוגה ב 11:00")
        self.assertFalse(fixed)
        self.assertEqual(task["fixed_time"], "09:00")

    def test_two_times_in_the_message_are_ambiguous(self):
        task, fixed = rc.correct_task_time({"fixed_time": "10:00"}, "בין 10:09 ל-12:30")
        self.assertFalse(fixed)

    def test_no_time_and_no_fixed_time_are_safe(self):
        self.assertEqual(rc.correct_task_time({"fixed_time": "10:00"}, "שיחה מחר")[1], False)
        self.assertEqual(rc.correct_task_time({}, "שיחה ב 10:09")[1], False)
        self.assertEqual(rc.correct_task_time(None, "10:09")[1], False)

    def test_the_original_task_object_is_not_mutated(self):
        original = {"fixed_time": "10:00"}
        task, _ = rc.correct_task_time(original, "שיחה ב 10:09")
        self.assertEqual(original["fixed_time"], "10:00")
        self.assertEqual(task["fixed_time"], "10:09")

    def test_times_in_reads_padded_and_unpadded(self):
        self.assertEqual(rc.times_in("ב 9:05 ואז ב-10:09"), ["09:05", "10:09"])
        self.assertEqual(rc.times_in("no times here"), [])


if __name__ == "__main__":
    unittest.main()
