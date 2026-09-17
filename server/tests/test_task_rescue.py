"""The task gets created even when the model will not create it.

The message that produced this module, sent twice, six hours into a day of
guards:

    12:46  "לדבר עם יניר מחר ב 16:00"  ->  "✓ עודכן: שיחה עם יניר"
    13:34  "לדבר עם יניר מחר ב 16:00"  ->  "✓ שיחה עם יניר ממתינה ליום שני"
    stored: 30 tasks before, 30 after, no יניר in any store

Block "עודכן" and it writes "ממתינה". The wording was never the problem — the
task not existing was. So the rescue does not argue with the model at all: when
a turn saves nothing and the message names an hour, the task is built from the
user's own words.

It must stay narrow. A rescue that fires on ordinary conversation would fill her
day with junk, which is its own way of making Lumi untrustworthy.
"""
import unittest
from datetime import date

import task_rescue
import tz


class RecognisingATaskTests(unittest.TestCase):
    def test_the_message_that_kept_being_lost(self):
        self.assertTrue(task_rescue.looks_like_a_task("לדבר עם יניר מחר ב 16:00"))

    def test_english_equivalent(self):
        self.assertTrue(task_rescue.looks_like_a_task("call Yanir tomorrow at 16:00"))

    def test_no_hour_is_still_a_commitment(self):
        # "שיחה עם יניר מחר" is a real thing to do. Refusing to save it until an
        # hour appears is how something the user said out loud disappears.
        self.assertTrue(task_rescue.looks_like_a_task("לדבר עם יניר מחר"))

    def test_a_question_is_not_an_instruction(self):
        for text in ["מתי הפגישה עם יניר?", "מה יש לי מחר?", "when is my meeting?"]:
            self.assertFalse(task_rescue.looks_like_a_task(text), text)

    def test_plain_conversation_is_left_alone(self):
        for text in [
            "כן תשאלי אותי שאלות ב rt embedded cpp שאלות design והבנה",
            "מה יש לי מחר?",
            "תודה!",
            "what's on my plate today?",
        ]:
            self.assertFalse(task_rescue.looks_like_a_task(text), text)

    def test_a_long_message_is_a_conversation(self):
        long = "לדבר עם יניר ב 16:00 " + "ועוד מילה " * 12
        self.assertFalse(task_rescue.looks_like_a_task(long))


class TitleTests(unittest.TestCase):
    def test_time_and_date_leave_the_title(self):
        self.assertEqual(task_rescue.title_from("לדבר עם יניר מחר ב 16:00"), "לדבר עם יניר")

    def test_english_title(self):
        self.assertEqual(task_rescue.title_from("call Yanir tomorrow at 16:00"), "call Yanir")

    def test_clock_time_is_zero_padded(self):
        self.assertEqual(task_rescue.clock_time("פגישה ב 9:05"), "09:05")


class RescueTests(unittest.TestCase):
    def test_it_builds_the_task_the_user_asked_for(self):
        t = task_rescue.rescue("לדבר עם יניר מחר ב 16:00", [])
        self.assertIsNotNone(t)
        self.assertEqual(t["text"], "לדבר עם יניר")
        self.assertEqual(t["fixed_time"], "16:00")
        # tomorrow, resolved by the same parser the webhook's date guard uses
        self.assertEqual(t["date"], tz.resolve_date("מחר").isoformat())
        self.assertTrue(t["rescued"], "a rescued task is marked as such")

    def test_it_never_duplicates_a_real_save(self):
        tomorrow = tz.resolve_date("מחר").isoformat()
        existing = [{"text": "לדבר עם יניר", "date": tomorrow, "fixed_time": "16:00"}]
        self.assertIsNone(task_rescue.rescue("לדבר עם יניר מחר ב 16:00", existing))

    def test_a_similar_task_on_another_day_is_not_a_duplicate(self):
        existing = [{"text": "לדבר עם יניר", "date": "2026-01-01", "fixed_time": "16:00"}]
        self.assertIsNotNone(task_rescue.rescue("לדבר עם יניר מחר ב 16:00", existing))

    def test_no_hour_saves_a_dated_task_without_a_time(self):
        t = task_rescue.rescue("לדבר עם יניר מחר", [])
        self.assertEqual(t["text"], "לדבר עם יניר")
        self.assertEqual(t["date"], tz.resolve_date("מחר").isoformat())
        self.assertNotIn("fixed_time", t, "no hour invented")

    def test_no_date_waits_in_the_general_list(self):
        # NOT dumped on today, where it would read as "late" by the evening for
        # no reason the user would recognise.
        t = task_rescue.rescue("לדבר עם יניר", [])
        self.assertIsNotNone(t)
        self.assertNotIn("date", t)

    def test_conversation_is_never_rescued(self):
        self.assertIsNone(task_rescue.rescue("מה יש לי מחר?", []))


if __name__ == "__main__":
    unittest.main()


class SameIntentTests(unittest.IsolatedAsyncioTestCase):
    """Said again with a new time — update it, do not clone it."""

    async def test_the_same_task_reworded_is_found(self):
        existing = [{"id": "1", "text": "לדבר עם יניר", "date": "2026-08-31",
                     "fixed_time": "16:00", "status": "pending"}]
        match, score, _ = await task_rescue.find_same_intent("שיחה עם יניר", existing)
        self.assertIsNotNone(match, f"scored only {score}")
        self.assertEqual(match["id"], "1")

    async def test_a_different_task_is_not_matched(self):
        existing = [{"id": "1", "text": "לקנות חלב", "date": "2026-08-31", "status": "pending"}]
        match, _s, _e = await task_rescue.find_same_intent("לדבר עם יניר", existing)
        self.assertIsNone(match)

    async def test_a_finished_task_is_not_re_used(self):
        # Doing something and then planning it again is a NEW commitment.
        existing = [{"id": "1", "text": "לדבר עם יניר", "date": "2026-08-20",
                     "status": "complete"}]
        match, _s, _e = await task_rescue.find_same_intent("לדבר עם יניר", existing)
        self.assertIsNone(match)

    def test_only_when_and_where_are_updated(self):
        existing = {"text": "לדבר עם יניר", "date": "2026-08-31", "fixed_time": "16:00"}
        new = {"text": "שיחה עם יניר", "date": "2026-08-31", "fixed_time": "18:00"}
        patch = task_rescue.changed_fields(existing, new)
        self.assertEqual(patch, {"fixed_time": "18:00"},
                         "the title matched — rewriting it would churn for nothing")

    def test_nothing_changed_is_an_empty_patch(self):
        same = {"text": "לדבר עם יניר", "date": "2026-08-31", "fixed_time": "16:00"}
        self.assertEqual(task_rescue.changed_fields(same, dict(same)), {})


class FreeSlotTests(unittest.TestCase):
    """No hour is a decision not yet made — offer three, do not nag."""

    def test_it_avoids_hours_already_taken(self):
        existing = [{"date": "2026-08-31", "fixed_time": "09:00"},
                    {"date": "2026-08-31", "fixed_time": "10:00"}]
        slots = task_rescue.free_slots(existing, "2026-08-31")
        self.assertNotIn("09:00", slots)
        self.assertNotIn("10:00", slots)
        self.assertEqual(len(slots), 3)

    def test_it_never_offers_an_hour_that_has_gone(self):
        slots = task_rescue.free_slots([], "2026-08-31", now_hhmm="17:30")
        self.assertTrue(all(s > "17:30" for s in slots), slots)

    def test_another_day_does_not_block_this_one(self):
        existing = [{"date": "2026-01-01", "fixed_time": "09:00"}]
        self.assertIn("09:00", task_rescue.free_slots(existing, "2026-08-31"))


class ThresholdCalibrationTests(unittest.TestCase):
    """The two scorers do not share a scale, and mixing them loses a workout.

    Measured on this account's embedding model with her real tasks:
      0.946 לדבר עם יניר ~ שיחה עם יניר    same thing
      0.912 אימון בוקר   ~ אימון ערב        TWO DIFFERENT WORKOUTS
      0.623 תור לרופא רן קידר ~ כנס האקריות unrelated
    """

    def test_auto_merge_sits_above_morning_vs_evening_training(self):
        self.assertGreater(task_rescue.same_threshold(True), 0.912,
                           "0.912 must NOT silently merge two workouts")

    def test_a_reworded_task_still_auto_merges(self):
        self.assertLessEqual(task_rescue.same_threshold(True), 0.946)

    def test_unrelated_tasks_do_not_even_raise_a_question(self):
        self.assertGreater(task_rescue.maybe_threshold(True), 0.623,
                           "a doctor and a conference are not 'maybe the same'")

    def test_the_lexical_scale_is_kept_for_the_fallback(self):
        self.assertEqual(task_rescue.same_threshold(False), task_rescue.LEXICAL_SAME)
        self.assertEqual(task_rescue.maybe_threshold(False), task_rescue.LEXICAL_MAYBE)

    def test_curated_synonyms_carry_what_the_model_cannot(self):
        # 0.691 is barely above two unrelated tasks — but known_places knows
        # both are @fitness, and a curated synonym beats a guess.
        self.assertTrue(task_rescue.same_activity("יוגה", "אימון כושר"))
        self.assertFalse(task_rescue.same_activity("יוגה", "ראיון עבודה"))
