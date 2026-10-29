"""past_log — her real sentences of 29.10 11:31-11:34 (Thu)."""
import asyncio
import os
import sys
import unittest
from datetime import date
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import history_stats  # noqa: E402
import past_log  # noqa: E402

THU = date(2026, 10, 29)
KICK = {"id": "k", "text": "קיקבוקס", "date": "2026-10-25", "fixed_time": "20:30", "status": "complete"}
WRONG = {"id": "w", "text": "And I did went to Zumba", "date": "2026-11-02", "fixed_time": "16:15",
         "status": "pending"}
MIDBURN = {"id": "m", "text": "חופשה במידברן", "date": "2026-11-02", "fixed_time": "08:00", "status": "pending"}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class Reading(unittest.TestCase):
    def test_a_past_weekday_is_the_one_that_came(self):
        self.assertEqual(past_log.report("And I did went to Zumba on monday", THU),
                         [(date(2026, 10, 26), "זומבה")])
        self.assertEqual(past_log.report("אני התאמנתי ביום ראשון וביום שני", THU),
                         [(date(2026, 10, 25), None), (date(2026, 10, 26), None)])
        self.assertEqual(past_log.report("But I did went to קיקבוקס on Sundays and I did", THU),
                         [(date(2026, 10, 25), "קיקבוקס")])

    def test_the_sunday_that_was_not_the_next_one(self):
        said = past_log.report("אבל לא ביום ראשון ושני הבאים, אני בעבר התאמנתי ביום ראשון שהיה.", THU)
        self.assertEqual(said, [(date(2026, 10, 25), None)])

    def test_plans_and_questions_are_not_reports(self):
        self.assertIsNone(past_log.report("תוסיפי זומבה ביום שני", THU))
        self.assertIsNone(past_log.report("אני אלך לזומבה ביום שני", THU))
        self.assertIsNone(past_log.report("באיזה ימים התאמנתי השבוע?", THU))
        self.assertTrue(past_log.asks_workouts("באיזה ימים התאמנתי השבוע?"))
        self.assertTrue(past_log.asks_workouts("How many times did I work out today? Not today, this week."))

    def test_not_today_this_week(self):
        p = history_stats.period("How many times did I work out today? Not today, this week.", THU)
        self.assertEqual((p["from"], p["label"]), ("2026-10-25", "this_week"))

    def test_zumba_and_kickboxing_are_workouts(self):
        self.assertTrue(history_stats.is_workout({"text": "kickboxing"}))
        self.assertTrue(history_stats.is_workout({"text": "Zumba"}))


class Counting(unittest.TestCase):
    def test_the_ticked_kickboxing_is_counted_and_named(self):
        line = past_log.count_line([KICK, WRONG], "2026-10-25", "2026-10-29", THU, "this_week", True)
        self.assertIn("אימון אחד", line)
        self.assertIn("ראשון 25.10 קיקבוקס", line)
        self.assertNotIn("Zumba", line, "a future report-titled row is not a workout done")

    def test_an_open_past_workout_is_asked_about_not_zero(self):
        z = {"id": "z", "text": "זומבה", "date": "2026-10-26", "status": "pending"}
        line = past_log.count_line([z], "2026-10-25", "2026-10-29", THU, "this_week", True)
        self.assertIn("הלכת?", line)


class TheTurn(unittest.TestCase):
    def setUp(self):
        self.patched = []
        self.added = []

        async def patch(phone, tid, p):
            self.patched.append((tid, p))
            return True

        def add(phone, task, trust_status=False):
            self.added.append(task)
            return {**task, "id": "new"}

        async def rows(phone, a=None, b=None, include_location=False):
            return [KICK, WRONG], "supabase"

        for p in (mock.patch.object(agent_turn, "_patch_task", patch),
                  mock.patch.object(agent_turn.user_memory, "add_task", add),
                  mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value=None)),
                  mock.patch("task_store.fetch_tasks_with_source", rows),
                  mock.patch.object(agent_turn._tz, "today_il", lambda: THU)):
            p.start()
            self.addCleanup(p.stop)

    def test_zumba_on_monday_is_logged_on_26_10_and_the_wrong_one_removed(self):
        text = run(agent_turn.past_turn("p", "And I did went to Zumba on monday", False))
        self.assertEqual(self.added[0]["date"], "2026-10-26")
        self.assertEqual(self.added[0]["status"], "complete")
        self.assertIn(("w", {"status": "cancelled"}), self.patched)
        self.assertIn("Mon 26.10", text)

    def test_kickboxing_already_ticked_is_not_doubled(self):
        text = run(agent_turn.past_turn("p", "התאמנתי ביום ראשון בקיקבוקס", True))
        self.assertEqual(self.added, [])
        self.assertIn("כבר היה מסומן", text)

    def test_a_plan_is_not_this_step(self):
        self.assertIsNone(run(agent_turn.past_turn("p", "תוסיפי זומבה ביום שני", True)))


class AwayDays(unittest.TestCase):
    def test_a_save_on_her_vacation_day_is_said(self):
        lines = agent_turn.away_lines([{"id": "z", "text": "זומבה", "date": "2026-11-02"}], [MIDBURN], True)
        self.assertEqual(len(lines), 1)
        self.assertIn("חופשה במידברן", lines[0])
        self.assertEqual(agent_turn.away_lines([{"id": "z", "text": "זומבה", "date": "2026-11-01"}],
                                               [MIDBURN], True), [])


class Deleting(unittest.TestCase):
    """'תמחקי את הזומבה בראשון' got '⚠️ nothing saved' (29.10)."""

    def setUp(self):
        self.patched, self.store = [], {}
        zumba = {"id": "z", "text": "Zumba", "date": "2026-11-01", "fixed_time": "16:15", "status": "pending"}
        call = {"id": "c1", "text": "שיחה עם יוסי", "date": "2026-10-30", "fixed_time": "10:00"}
        call2 = {"id": "c2", "text": "שיחה עם יוסי", "date": "2026-10-31", "fixed_time": "11:00"}

        async def patch(phone, tid, p):
            self.patched.append((tid, p))
            return True

        for p in (mock.patch.object(agent_turn, "_patch_task", patch),
                  mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=[zumba, call, call2])),
                  mock.patch.object(agent_turn.session, "get_pending_choice", lambda ph: self.store.get("c")),
                  mock.patch.object(agent_turn.session, "set_pending_choice",
                                    lambda ph, o, n, opts=None, ctx=None: self.store.update(c={"owner": o, "options": opts})),
                  mock.patch.object(agent_turn.session, "clear_pending_choice", lambda ph: self.store.pop("c", None)),
                  mock.patch.object(agent_turn._tz, "today_il", lambda: THU)):
            p.start()
            self.addCleanup(p.stop)

    def test_her_sentence_deletes_the_sunday_zumba(self):
        text = run(agent_turn.delete_turn("p", "תמחקי את הזומבה בראשון", True))
        self.assertEqual(self.patched, [("z", {"status": "cancelled"})])
        self.assertIn("מחקתי: Zumba", text)

    def test_dont_delete_is_not_a_delete(self):
        self.assertIsNone(run(agent_turn.delete_turn("p", "לא  תמחקי את הזומבה", True)))

    def test_two_alike_asks_which_and_her_number_deletes_it(self):
        text = run(agent_turn.delete_turn("p", "תבטלי את השיחה עם יוסי", True))
        self.assertIn("איזו", text)
        self.assertEqual(self.patched, [])
        text = run(agent_turn.delete_turn("p", "2", True))
        self.assertEqual(self.patched, [("c2", {"status": "cancelled"})])

    def test_nothing_found_is_said(self):
        text = run(agent_turn.delete_turn("p", "תמחקי את הפילאטיס", True))
        self.assertIn("לא מצאתי", text)

    def test_a_generic_word_with_no_day_asks_first(self):
        text = run(agent_turn.delete_turn("p", "תמחקי את השיחה", True))
        self.assertIn("איזו", text)
        self.assertEqual(self.patched, [])


class SafeWrites(unittest.TestCase):
    def test_a_patch_that_changed_nothing_is_not_a_tick(self):
        with mock.patch.object(agent_turn.user_memory, "update_task", lambda *a: None), \
                mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value="u")), \
                mock.patch.object(agent_turn.supabase_tasks, "update_task", mock.AsyncMock(return_value=False)):
            self.assertFalse(run(agent_turn._patch_task("p", "x", {"status": "cancelled"})))

    def test_mcp_cannot_delete_by_words(self):
        import inspect
        src = inspect.getsource(agent_turn.run_turn)
        self.assertIn('None if channel == "mcp" else await delete_turn(', src)


if __name__ == "__main__":
    unittest.main()
