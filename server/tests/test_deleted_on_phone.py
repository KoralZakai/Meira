"""Koral, 20.10 01:15: "השיחה עם דותן היום!" → "שיחת טלפון עם דותן · היום ✓" —
for a call she had DELETED on the phone. The server's memory still held it,
the cloud PATCH matched no row (a 204 all the same), and Meira confirmed it."""
import asyncio
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import supabase_tasks  # noqa: E402
import tz  # noqa: E402


class _Client:
    def __init__(self, status, payload):
        self.status, self.payload = status, payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def patch(self, *a, **k):
        return SimpleNamespace(status_code=self.status, content=b"x" if self.payload is not None else b"",
                               json=lambda: self.payload, text="")

    async def get(self, *a, **k):
        return SimpleNamespace(status_code=200, json=lambda: [], text="")


class CloudUpdate(unittest.TestCase):
    def run_patch(self, status, payload):
        with mock.patch.object(supabase_tasks, "_enabled", lambda: True), \
             mock.patch.object(supabase_tasks, "sealing_on", lambda: False), \
             mock.patch.object(supabase_tasks.httpx, "AsyncClient", lambda **k: _Client(status, payload)):
            return asyncio.run(supabase_tasks.update_task("u1", "t1", {"date": "2026-10-20"}))

    def test_no_row_is_not_a_success(self):
        self.assertFalse(self.run_patch(200, []))
        self.assertFalse(self.run_patch(204, None))

    def test_the_row_back_is_a_success(self):
        self.assertTrue(self.run_patch(200, [{"id": "t1"}]))


class HerDay(unittest.TestCase):
    def test_a_task_only_the_servers_memory_holds_is_not_offered(self):
        today = tz.today_il().isoformat()
        cloud = [{"id": "kept", "text": "a", "date": today, "status": "pending"}]
        memory = [{"id": "kept", "text": "a", "date": today},
                  {"id": "deleted-on-phone", "text": "שיחה עם דותן", "date": today},
                  {"id": "undated", "text": "b", "date": None}]
        with mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value="u1")), \
             mock.patch.object(agent_turn.supabase_tasks, "tasks_for_user", mock.AsyncMock(return_value=cloud)), \
             mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: memory):
            ids = {t["id"] for t in asyncio.run(agent_turn._her_days("p"))}
        self.assertEqual(ids, {"kept", "undated"})


if __name__ == "__main__":
    unittest.main()
