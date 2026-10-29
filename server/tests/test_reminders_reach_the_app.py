"""13.10, Koral: "Meira wrote she would remind me and she didn't."

On 10.10: "send my CV to Tali, tomorrow at 14:00". Three things went wrong:
  - "מחר ב 14:00" changed the hour and left the date on 10.10;
  - Meira asked for Tali's phone, as if SHE were to message Tali;
  - a reminder went only to WhatsApp — and the account was disabled.
And on 13.10 a meetup with no date was saved on 10.10.
"""
import unittest
from datetime import timedelta

import agent_turn
from tz import today_il, resolve_date


class ReminderIsATimedTask(unittest.TestCase):
    def test_a_reminder_becomes_a_task_the_app_alerts(self):
        r = {"ok": True, "text": "לשלוח קורות חיים לטלי", "time": "14:00", "date": "2026-10-11"}
        out = agent_turn.reminder_tasks([r], [], [])
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["date"], out[0]["fixed_time"]), ("2026-10-11", "14:00"))

    def test_not_twice_when_the_task_was_saved_this_turn(self):
        r = {"ok": True, "text": "x", "time": "14:00", "date": "2026-10-11"}
        saved = [{"text": "לשלוח קורות חיים לטלי", "date": "2026-10-11", "fixed_time": "14:00"}]
        self.assertEqual(agent_turn.reminder_tasks([r], saved, []), [])

    def test_not_twice_when_a_task_was_moved_to_that_minute(self):
        r = {"ok": True, "text": "x", "time": "14:00", "date": "2026-10-11"}
        self.assertEqual(agent_turn.reminder_tasks([r], [], [{"id": "1", "fixed_time": "14:00"}]), [])

    def test_two_reminders_at_one_minute_are_one_task(self):
        r = {"ok": True, "text": "x", "time": "09:00", "date": "2026-10-11"}
        self.assertEqual(len(agent_turn.reminder_tasks([r, dict(r)], [], [])), 1)


class TheDayIsCodes(unittest.TestCase):
    def test_a_meetup_with_no_date_is_today_not_three_days_ago(self):
        past = (today_il() - timedelta(days=3)).isoformat()
        out = agent_turn.override_task_date(
            {"text": "מיטאפ", "date": past, "fixed_time": "18:00"},
            "יש מיטאפ בפאלו אלטו ביגאל אלון 94 ב 18:00 עד 20:00")
        self.assertEqual(out["date"], today_il().isoformat())

    def test_tomorrow_at_two_moves_the_day_too(self):
        out = agent_turn.override_task_date({"date": None}, "מחר ב 14:00")
        self.assertEqual(out["date"], resolve_date("מחר").isoformat())


class HerTaskNotAMessage(unittest.TestCase):
    def test_the_prompt_says_her_task_is_hers(self):
        import lumi_agent
        rules = lumi_agent._STATIC_RULES
        self.assertIn("HER TASK vs A MESSAGE FOR SOMEONE", rules)
        self.assertIn("NEVER ask for the other person's phone", rules)


if __name__ == "__main__":
    unittest.main()
