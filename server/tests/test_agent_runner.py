"""agent_runner tests — LLM + WhatsApp mocked, temp agents.json.

Covers: fire→send→next_run advance, grace skip, template fallback on LLM
failure, custom-agent skip on LLM failure, smart_alarm schedules a wake row.
"""
import os
import tempfile
import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch

import agents_store
import agent_runner
from tz import IL


def _il(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=IL)


def _make_due(phone: str, *, template=None, name="T", when=_il(2026, 7, 22, 7, 0)):
    a = agents_store.create_agent(
        phone, name=None if template else name, soul=None if template else "be brief",
        days=None if template else [0, 1, 2, 3, 4, 5, 6],
        time=None if template else "07:00", template=template, created_via="test")
    assert "error" not in a, a
    items = agents_store._load()
    for it in items:
        if it["id"] == a["id"]:
            it["next_run"] = when.isoformat()
    agents_store._save(items)
    return a


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fd, self._tmp = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(self._tmp)
        self._orig = agents_store._PATH
        agents_store._PATH = self._tmp

    def tearDown(self):
        agents_store._PATH = self._orig
        if os.path.exists(self._tmp):
            os.unlink(self._tmp)

    async def test_fires_sends_and_advances(self):
        a = _make_due("972r", name="Daily")
        send = AsyncMock()
        with patch.object(agent_runner.WhatsAppService, "send_message", send), \
             patch.object(agent_runner, "_compose", AsyncMock(return_value="hello line")):
            fired = await agent_runner.run_due(now=_il(2026, 7, 22, 7, 1))
        self.assertEqual(fired, 1)
        send.assert_awaited_once()
        text = send.await_args.args[1]
        self.assertIn("Daily", text)      # emoji+name header
        self.assertIn("hello line", text)
        after = agents_store.get_agent("972r", a["id"])
        self.assertEqual(after["run_count"], 1)
        self.assertEqual(after["next_run"], _il(2026, 7, 23, 7, 0).isoformat())

    async def test_grace_skip_still_advances(self):
        a = _make_due("972g", name="Stale")
        send = AsyncMock()
        with patch.object(agent_runner.WhatsAppService, "send_message", send):
            fired = await agent_runner.run_due(now=_il(2026, 7, 22, 9, 0))  # 2h late
        self.assertEqual(fired, 0)
        send.assert_not_awaited()
        after = agents_store.get_agent("972g", a["id"])
        self.assertEqual(after["run_count"], 1)  # marked ran anyway — no hot-loop
        self.assertEqual(after["next_run"], _il(2026, 7, 23, 7, 0).isoformat())

    async def test_template_falls_back_to_facts_on_llm_failure(self):
        _make_due("972f", template="morning_planner")
        send = AsyncMock()
        with patch.object(agent_runner.WhatsAppService, "send_message", send), \
             patch.object(agent_runner, "_compose", AsyncMock(return_value=None)), \
             patch.object(agent_runner, "_morning_facts",
                          AsyncMock(return_value=("FACTS BLOCK", False))):
            fired = await agent_runner.run_due(now=_il(2026, 7, 22, 7, 1))
        self.assertEqual(fired, 1)
        self.assertIn("FACTS BLOCK", send.await_args.args[1])

    async def test_custom_agent_skips_on_llm_failure(self):
        _make_due("972c", name="Custom")
        send = AsyncMock()
        with patch.object(agent_runner.WhatsAppService, "send_message", send), \
             patch.object(agent_runner, "_compose", AsyncMock(return_value=None)):
            await agent_runner.run_due(now=_il(2026, 7, 22, 7, 1))
        send.assert_not_awaited()  # nothing sent, but next_run advanced (no retry storm)

    async def test_smart_alarm_schedules_wake_reminder(self):
        a = _make_due("972a", template="smart_alarm", when=_il(2026, 7, 22, 21, 30))
        send = AsyncMock()
        sched = unittest.mock.MagicMock(return_value=True)
        tomorrow = "2026-07-23"
        task = {"id": "t1", "text": "ראיון", "fixed_time": "11:30", "date": tomorrow,
                "status": "pending", "location": None}
        with patch.object(agent_runner.WhatsAppService, "send_message", send), \
             patch.object(agent_runner, "_compose", AsyncMock(return_value="sleep well")), \
             patch.object(agent_runner.reminders, "schedule", sched), \
             patch.object(agent_runner.user_memory, "tasks_for_phone",
                          return_value=[task]), \
             patch.object(agent_runner, "today_il",
                          return_value=_il(2026, 7, 22, 21, 31).date()):
            fired = await agent_runner.run_due(now=_il(2026, 7, 22, 21, 31))
        self.assertEqual(fired, 1)
        sched.assert_called_once()
        args, kwargs = sched.call_args
        self.assertEqual(args[0], "972a")
        # wake = 11:30 − (0 travel + 45 routine + 10 buffer) = 10:35
        self.assertEqual(args[1], "10:35")
        self.assertEqual(kwargs.get("day"), tomorrow)
        self.assertEqual(kwargs.get("dest_key"), f"agent:{a['id']}")


if __name__ == "__main__":
    unittest.main()
