"""Koral, 20.10 at 00:51 — "להתקשר לדותן ב 9 וחצי בבוקר".

1. Saved for 21.10: the model wrote "מחר" at night and the code trusted it.
2. The reply said "⚠️ I didn't save anything" AND "saved: … ✓" together.
3. "כן ביום שלישי" (that Tuesday morning) was read as chat; nothing moved.
"""
import asyncio
import datetime
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import lumi_agent  # noqa: E402
import tz  # noqa: E402
import understand  # noqa: E402

TUE = datetime.date(2026, 10, 20)


def at(hhmm: str):
    h, m = (int(x) for x in hhmm.split(":"))
    moment = datetime.datetime.combine(TUE, datetime.time(h, m), tzinfo=tz.now_il().tzinfo)
    return mock.patch.multiple(tz, now_il=lambda: moment, today_il=lambda: TUE)


class Night(unittest.TestCase):
    def test_tomorrow_at_night_is_the_coming_morning(self):
        with at("00:51"):
            self.assertEqual(tz.resolve_date_at("מחר"), TUE)
            self.assertEqual(tz.resolve_date_at("ביום שלישי"), TUE)
            self.assertEqual(tz.resolve_date_at("היום"), TUE)
            self.assertEqual(tz.resolve_date_at("21.10"), datetime.date(2026, 10, 21))
        with at("09:00"):
            self.assertEqual(tz.resolve_date_at("מחר"), datetime.date(2026, 10, 21))

    def test_the_call_lands_on_the_coming_morning_even_when_the_model_says_tomorrow(self):
        with at("00:51"):
            task = understand.task_from({"do": "add", "title": "שיחה עם דותן", "start": "09:30",
                                         "date_expression": "מחר"}, "להתקשר לדותן ב 9 וחצי בבוקר", TUE)
        self.assertEqual(task["date"], "2026-10-20")


class NoContradiction(unittest.TestCase):
    def test_the_guard_line_goes_when_the_code_did_save(self):
        text = f"משהו\n{lumi_agent._NOTHING_NOW[True]}"
        self.assertEqual(agent_turn.without_guard_notes(text), "משהו")
        self.assertEqual(agent_turn.without_guard_notes(lumi_agent._NOT_SAVED[False]), "")


class DateCorrection(unittest.TestCase):
    HIST = [{"role": "user", "content": "להתקשר לדותן ב 9 וחצי בבוקר"},
            {"role": "assistant", "content": "שמרתי: שיחת טלפון עם פול דותן · 09:30 21.10 ✓"}]
    TASK = {"id": "t1", "text": "שיחת טלפון עם פול דותן", "fixed_time": "09:30", "date": "2026-10-21"}

    def run_it(self, message, hist=None):
        updates = []
        with at("00:51"), \
             mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=[dict(self.TASK)])), \
             mock.patch.object(agent_turn.user_memory, "update_task", lambda p, i, patch: updates.append(patch)), \
             mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value=None)):
            saved, note = asyncio.run(agent_turn.date_correction("p", message, hist if hist is not None else self.HIST))
        return saved, note, updates

    def test_yes_on_tuesday_moves_the_call_to_the_coming_morning(self):
        saved, note, updates = self.run_it("כן ביום שלישי")
        self.assertEqual(updates, [{"date": "2026-10-20"}])
        self.assertIn("עדכנתי: שיחת טלפון עם פול דותן · 09:30 20.10 ✓", note)
        self.assertEqual(saved[0]["date"], "2026-10-20")

    def test_a_day_and_an_hour_move_it_too(self):
        saved, note, updates = self.run_it("היום ב9 וחצי@")
        self.assertEqual(updates, [{"date": "2026-10-20", "fixed_time": "09:30"}])

    def test_only_a_bare_day_after_a_save_counts(self):
        self.assertEqual(self.run_it("כן ביום שלישי תוסיפי גם פגישה")[0], [])
        self.assertEqual(self.run_it("כן ביום שלישי", hist=[{"role": "assistant", "content": "שלום!"}])[0], [])


if __name__ == "__main__":
    unittest.main()
