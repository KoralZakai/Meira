"""Koral, 20.10 00:47-00:49: "call with Dotan at 9:30" on the mic, heard as
"the TAN", "Paul Dothan", "Dotana", "Dott. Anna" — five tasks. A retry within
minutes, at the same hour, replaces the task Meira just saved."""
import asyncio
import datetime
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import tz  # noqa: E402

NOW = datetime.datetime(2026, 10, 20, 0, 48, tzinfo=tz.now_il().tzinfo)
OLD = {"id": "t-tan", "text": "שיחת טלפון עם טאן", "fixed_time": "09:30", "date": "2026-10-21"}


def hist(minutes_ago: float, line: str):
    ts = (NOW - datetime.timedelta(minutes=minutes_ago)).isoformat()
    return [{"role": "user", "content": "Call the TAN tomorrow morning on 9.30.", "ts": ts},
            {"role": "assistant", "content": line, "ts": ts}]


class Retry(unittest.TestCase):
    def go(self, history, new_task):
        patches = []
        with mock.patch.object(agent_turn._tz, "now_il", lambda: NOW), \
             mock.patch.object(agent_turn.user_memory, "update_task", lambda p, i, patch: patches.append((i, patch))), \
             mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value="u1")), \
             mock.patch.object(agent_turn.supabase_tasks, "update_task", mock.AsyncMock(return_value=True)):
            redone, fresh = asyncio.run(agent_turn.replace_recent_retries(
                "p", [new_task], history, [dict(OLD)], he=True))
        return redone, fresh, patches

    def test_the_same_hour_minutes_later_replaces_the_mis_heard_one(self):
        new = {"text": "שיחת טלפון עם דותן", "fixed_time": "09:30", "date": "2026-10-20", "category": "call"}
        redone, fresh, patches = self.go(hist(1, "Saved: שיחת טלפון עם טאן · 21.10 09:30 ✓"), new)
        self.assertEqual(fresh, [])
        self.assertEqual(patches[0][0], "t-tan")
        self.assertEqual(patches[0][1]["text"], "שיחת טלפון עם דותן")
        self.assertIn("במקום \"שיחת טלפון עם טאן\"", redone[0][1])

    def test_another_hour_or_long_ago_is_a_new_task(self):
        new = {"text": "פגישה", "fixed_time": "11:00", "date": "2026-10-20"}
        self.assertEqual(self.go(hist(1, "Saved: שיחת טלפון עם טאן · 21.10 09:30 ✓"), new)[1], [new])
        same_hour = {"text": "שיחה עם דותן", "fixed_time": "09:30", "date": "2026-10-20"}
        self.assertEqual(self.go(hist(30, "Saved: שיחת טלפון עם טאן · 21.10 09:30 ✓"), same_hour)[1], [same_hour])


if __name__ == "__main__":
    unittest.main()
