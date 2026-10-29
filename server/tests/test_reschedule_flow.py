"""The whole "my interview moved" conversation, end to end (19.10, Koral).

Move → Meira names a free hour → "כן" books it → she asks the morning hour (7/8/9) →
"ב-8" sets the wake-up. Everything Meira SAYS must be backed by something that saved:
no ✓ when the diary failed, no 🔔 when the reminder failed, no promise to wake her
that nothing booked.
"""
import asyncio
import os
import sys
import unittest
from datetime import date, datetime
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import reminders  # noqa: E402
import session  # noqa: E402
import tz  # noqa: E402

PHONE = "0501234567"
TODAY = date(2026, 10, 18)
NOW = datetime(2026, 10, 18, 10, 0, tzinfo=tz.IL)
TASKS = [
    {"id": "w", "date": "2026-10-19", "fixed_time": "13:00", "category": "interview",
     "text": "Your Phone Screen at Workday for JR-0104334 Senior Applied AI Engineer"},
    {"id": "m", "date": "2026-10-19", "fixed_time": "18:00", "category": "meeting", "text": "פגישה עם דנה"},
]
SAID = "העיון שלי מחר ב-Work Day נתחל ליום שלישי"


def run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


class Flow(unittest.TestCase):
    def setUp(self):
        session.clear_pending_offer(PHONE)
        self.reminded = []
        self.saved_tasks = []
        self.persist_ok = True
        self.remind_ok = True
        self.level = "gentle"

        async def her_days(phone, days=14):
            return [dict(t) for t in TASKS]

        async def persist(phone, content, response, channel):
            if not self.persist_ok:
                return []
            self.saved_tasks.extend(response["tasks"])
            return [{**t, "id": "s1"} for t in response["tasks"]]

        async def no_clash(phone, tasks, he=True):
            return ""

        def schedule(phone, hhmm, text, day=None, **kw):
            self.reminded.append((day, hhmm, text))
            return self.remind_ok

        self.patches = [
            mock.patch.object(agent_turn, "_her_days", her_days),
            mock.patch.object(agent_turn, "persist_agent_tasks", persist),
            mock.patch.object(agent_turn, "clash_note", no_clash),
            mock.patch.object(agent_turn.user_memory, "update_task", lambda *a, **k: True),
            mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value=None)),
            mock.patch.object(agent_turn._tz, "today_il", lambda: TODAY),
            mock.patch.object(agent_turn._tz, "now_il", lambda: NOW),
            mock.patch.object(agent_turn.user_profile, "get_profile", lambda k: {"nudgeLevel": self.level}),
            mock.patch.object(reminders, "schedule", schedule),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        session.clear_pending_offer(PHONE)

    def say(self, text):
        return run(agent_turn.reschedule_turn(PHONE, text, "app", PHONE))

    def test_the_move_names_a_free_hour(self):
        r = self.say(SAID)
        self.assertIn("20:00", r["text"])
        self.assertEqual(r["text"].count("?"), 1)
        self.assertNotIn("להעיר", r["text"])
        self.assertEqual(session.get_pending_offer(PHONE)["proposed_time"], "20:00")

    def test_yes_books_that_hour_then_asks_the_morning_hours(self):
        self.say(SAID)
        r = self.say("כן")
        self.assertEqual((self.saved_tasks[0]["date"], self.saved_tasks[0]["fixed_time"]), ("2026-10-19", "20:00"))
        self.assertEqual([h for _, h, _ in self.reminded], ["19:30", "20:00"])    # gentle: heads-up + reminder
        self.assertIn("✓", r["text"])
        self.assertIn("🔔", r["text"])
        self.assertIn("07:00 / 08:00 / 09:00", r["text"])                          # flexible, not 06:40
        self.assertEqual(session.get_pending_offer(PHONE)["stage"], "morning")

    def test_the_morning_answer_sets_the_wake_up(self):
        self.say(SAID)
        self.say("כן")
        self.reminded.clear()
        r = self.say("ב-8")
        self.assertIn("08:00", r["text"])
        self.assertEqual(self.reminded[-1][:2], ("2026-10-20", "08:00"))
        self.assertIsNone(session.get_pending_offer(PHONE))
        self.assertEqual(self.saved_tasks[-1]["date"], "2026-10-19")               # no second diary entry

    def test_an_hour_she_says_is_an_evening_hour(self):
        self.say(SAID)
        self.say("ב-9")
        self.assertEqual(self.saved_tasks[0]["fixed_time"], "21:00")

    def test_the_diary_failing_is_not_a_check_mark(self):
        self.persist_ok = False
        self.say(SAID)
        r = self.say("כן")
        self.assertNotIn("✓", r["text"])
        self.assertIn("לא הצלחתי", r["text"])
        self.assertEqual(self.reminded, [])
        self.assertIsNotNone(session.get_pending_offer(PHONE))        # she can try again

    def test_a_failed_reminder_drops_the_bell_only(self):
        self.remind_ok = False
        self.say(SAID)
        r = self.say("כן")
        self.assertIn("✓", r["text"])
        self.assertNotIn("🔔", r["text"])

    def test_how_pushy_she_chose(self):
        for level, hours in (("alarm", ["20:00"]), ("gentle", ["19:30", "20:00"]),
                             ("motivating", ["19:00", "20:00", "20:30"])):
            with self.subTest(level):
                self.level, self.reminded = level, []
                session.clear_pending_offer(PHONE)
                self.say(SAID)
                self.say("כן")
                self.assertEqual([h for _, h, _ in self.reminded], hours)

    def test_later_is_kept_no_is_dropped(self):
        self.say(SAID)
        self.assertIn("נשארת", self.say("אחר כך")["text"])
        self.assertIsNotNone(session.get_pending_offer(PHONE))
        self.say("לא צריך")
        self.assertIsNone(session.get_pending_offer(PHONE))

    def test_another_hour_lists_free_ones(self):
        self.say(SAID)
        r = self.say("שעה אחרת")
        self.assertIn("20:00", r["text"])
        self.assertIsNotNone(session.get_pending_offer(PHONE))

    def test_a_day_part_is_picked_from_the_free_windows_and_said(self):
        self.say(SAID)
        r = self.say("בערב")
        self.assertEqual(self.saved_tasks[0]["fixed_time"], "19:00")      # first free half hour after the 18:00 call
        self.assertIn("19:00", r["text"])


if __name__ == "__main__":
    unittest.main()


class AppProfileNudgeLevel(unittest.TestCase):
    """The Profile choice reaches the server with the next chat turn (rule 7: that turn is the trigger)."""

    def test_the_app_can_set_the_level_and_junk_cannot(self):
        import user_profile
        key = "nudge-test"
        with mock.patch.object(user_profile, "get_profile", return_value={}), \
                mock.patch.object(user_profile, "update_profile") as upd:
            self.assertEqual(agent_turn.sync_app_profile(key, {"nudgeLevel": "motivating"}),
                             {"nudgeLevel": "motivating"})
            upd.assert_called_once_with(key, nudgeLevel="motivating")
            self.assertEqual(agent_turn.sync_app_profile(key, {"nudgeLevel": "LOUD"}), {})
            self.assertEqual(agent_turn.sync_app_profile(key, {"nudgeLevel": ""}), {})
