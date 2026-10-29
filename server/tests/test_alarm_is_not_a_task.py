"""Koral, 20.10 01:14: "תשמרי את השיחה מחר ב 9 וחצי עם דותן! ושימי לי שעון מעורר
מתאים" → a task called "שעון מעורר לשיחה עם דותן" and "Alarm set" in English.
An alarm is a field of the task it is for."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import datetime  # noqa: E402
import understand  # noqa: E402

SAID = "תשמרי את השיחה מחר ב 9 וחצי עם דותן! ושימי לי שעון מעורר מתאים"


class AlarmIsAField(unittest.TestCase):
    def test_the_alarm_task_the_model_made_becomes_the_calls_alarm(self):
        acts = understand.alarm_onto_task([
            {"do": "add", "title": "שיחה עם דותן", "start": "09:30", "date_expression": "מחר"},
            {"do": "add", "title": "שעון מעורר לשיחה עם דותן", "start": "09:00"}], SAID)
        self.assertEqual(len(acts), 1)
        self.assertEqual(acts[0]["alarm"], "09:00")

    def test_a_suitable_alarm_is_half_an_hour_before(self):
        acts = understand.alarm_onto_task([{"do": "add", "title": "שיחה עם דותן", "start": "09:30"}], SAID)
        task = understand.task_from(acts[0], SAID, datetime.date(2026, 10, 19))
        self.assertEqual(task["alarmAt"], "09:00")
        self.assertEqual(task["alarmState"], "planned")

    def test_a_call_has_no_place(self):
        task = understand.task_from({"do": "add", "title": "שיחת טלפון עם דותן", "start": "09:30",
                                     "place": "מורדי הגטאות 23"}, "להתקשר לדותן", datetime.date(2026, 10, 19))
        self.assertNotIn("location", task)

    def test_no_alarm_asked_none_set(self):
        acts = understand.alarm_onto_task([{"do": "add", "title": "פגישה", "start": "10:00"}], "פגישה ב10")
        self.assertNotIn("alarm", acts[0])


if __name__ == "__main__":
    unittest.main()


class AlarmOnItsOwn(unittest.TestCase):
    """Live 20.10 01:34: "תוסיפי לי עוד שעון מעורר גם ב 9" → a task "עוד שעון מעורר"."""

    def test_an_alarm_only_message_is_an_alarm_on_her_task(self):
        acts = understand.alarm_onto_task([{"do": "add", "title": "עוד שעון מעורר", "start": "09:00"}],
                                          "תוסיפי לי עוד שעון מעורר גם ב 9")
        self.assertEqual(acts[0]["do"], "update")
        self.assertTrue(acts[0]["alarm_only"])
        patch = understand.patch_from(acts[0])
        self.assertEqual(patch, {"alarmAt": "09:00", "alarmState": "planned"})   # the call keeps 09:30

    def test_it_lands_on_the_call_just_saved(self):
        import asyncio
        from unittest import mock
        import agent_turn, tz
        now = datetime.datetime(2026, 10, 20, 1, 34, tzinfo=tz.now_il().tzinfo)
        day = [{"id": "c1", "text": "שיחה עם דותן", "fixed_time": "09:30", "date": "2026-10-20"},
               {"id": "i1", "text": "ראיון", "fixed_time": "13:00", "date": "2026-10-20"}]
        hist = [{"role": "assistant", "content": "שמרתי: שיחה עם דותן · 20.10 09:30 ✓",
                 "ts": (now - datetime.timedelta(minutes=1)).isoformat()}]
        updates = []
        result = {"kind": "do", "actions": [{"do": "add", "title": "עוד שעון מעורר", "start": "09:00"}], "ask": None}
        result["actions"] = understand.alarm_onto_task(result["actions"], "תוסיפי לי עוד שעון מעורר גם ב 9")
        with mock.patch.object(agent_turn._tz, "now_il", lambda: now), \
             mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=day)), \
             mock.patch.object(agent_turn.user_memory, "update_task", lambda p, i, patch: updates.append((i, patch))), \
             mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value="u1")), \
             mock.patch.object(agent_turn.supabase_tasks, "update_task", mock.AsyncMock(return_value=False)):
            saved, note, ok = asyncio.run(agent_turn.act_on_understanding(
                "p", "תוסיפי לי עוד שעון מעורר גם ב 9", "app", hist, result=result))
        self.assertEqual(updates, [("c1", {"alarmAt": "09:00", "alarmState": "planned"})])
        self.assertIn("⏰ שעון מעורר 20.10 ב-09:00, לפני: שיחה עם דותן (09:30) ✓", note)
        self.assertEqual(saved[0]["alarmAt"], "09:00")


class CodeDecidesAlarms(unittest.TestCase):
    """The understanding probe on the server, 20.10 01:40, her own sentences."""

    def test_the_hour_is_read_from_the_asking_part(self):
        self.assertEqual(understand.wake_request("תוסיפי לי עוד שעון מעורר גם ב 9"), "09:00")
        self.assertEqual(understand.wake_request("תעירי אותי ב-8"), "08:00")
        self.assertEqual(understand.wake_request("call Dotan at 9:30 in the morning and set an alarm"), "auto")
        self.assertEqual(understand.wake_request("תעירי אותי ב-7, הראיון ב-13:00"), "07:00")
        self.assertIsNone(understand.wake_request("לקנות שעון חדש"))

    def test_wake_me_at_8_never_moves_a_task(self):
        acts, kind = understand.wake_actions([{"do": "update", "task_id": None, "start": "08:00", "alarm": "auto"}],
                                             "תעירי אותי ב-8", "08:00")
        self.assertEqual(kind, "do")
        self.assertEqual(acts, [{"do": "update", "task_id": None, "alarm": "08:00", "alarm_only": True}])
        self.assertEqual(understand.patch_from(acts[0]), {"alarmAt": "08:00", "alarmState": "planned"})

    def test_an_alarm_only_message_the_model_called_a_question_still_acts(self):
        acts, kind = understand.wake_actions([], "תוסיפי לי עוד שעון מעורר גם ב 9", "09:00")
        self.assertEqual((kind, acts[0]["alarm"], acts[0]["alarm_only"]), ("do", "09:00", True))

    def test_no_hour_said_is_half_an_hour_before_never_the_tasks_own_minute(self):
        acts, _ = understand.wake_actions([{"do": "add", "title": "שיחה עם דותן", "start": "09:30", "alarm": "09:30"}],
                                          "call Dotan at 9:30 in the morning and set an alarm", "auto")
        task = understand.task_from(acts[0], "call Dotan at 9:30", datetime.date(2026, 10, 20))
        self.assertEqual(task["alarmAt"], "09:00")

    def test_the_prompt_no_longer_teaches_dotan_means_zoom(self):
        self.assertNotIn("שיחה עם דותן בזום", understand._SYSTEM)
        self.assertIn("Never add a word she did not say", understand._SYSTEM)


class RealAlarmForTheFirstTaskOfTheMorning(unittest.TestCase):
    """EXPECTED (Koral, 20.10): "set an alarm" = a REAL alarm for the first task
    of the coming morning, at the hour she said, or — none said — at the day's
    wake time from everything known (route + routine)."""

    DAY = [{"id": "doc", "text": "תור להקפאת ביציות", "fixed_time": "10:30", "date": "2026-10-21"},
           {"id": "gym", "text": "אימון", "fixed_time": "20:00", "date": "2026-10-20"},
           {"id": "late", "text": "שיחה", "fixed_time": "14:00", "date": "2026-10-21"}]

    def at(self, hhmm, wake, wake_by="08:33"):
        import asyncio
        from unittest import mock
        import agent_turn, tz
        h, m = (int(x) for x in hhmm.split(":"))
        now = datetime.datetime(2026, 10, 20, h, m, tzinfo=tz.now_il().tzinfo)
        plan = mock.AsyncMock(return_value={"wake_by": wake_by})
        with mock.patch.object(agent_turn._tz, "now_il", lambda: now), \
             mock.patch("day_plan.plan_day", plan), \
             mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value=None)), \
             mock.patch.object(agent_turn.user_profile, "get_profile", lambda k: {"morningRoutineMinutes": 45}):
            return asyncio.run(agent_turn.morning_alarm("p", self.DAY, wake))

    def test_the_evening_before_it_is_tomorrows_first_task_at_the_wake_time(self):
        first, at = self.at("22:00", "auto")
        self.assertEqual((first["id"], at), ("doc", "08:33"))

    def test_the_hour_she_said_wins(self):
        self.assertEqual(self.at("22:00", "07:00")[1], "07:00")

    def test_no_wake_time_known_is_the_start_less_her_routine(self):
        self.assertEqual(self.at("22:00", "auto", wake_by=None), (self.DAY[0], "09:45"))

    def test_an_evening_task_today_is_not_the_morning(self):
        self.assertEqual(self.at("15:00", "auto")[0]["id"], "doc")
