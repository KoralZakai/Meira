"""One turn, the same task twice: saved once.

Live eval 20.10, "ללכת לבנק מחר": the agent called infer_task_details, a
failed update_task, find_task, then infer_task_details again — and both
copies were saved. The duplicate check compared each task only with what
was on her day BEFORE the turn, never with the one saved a moment earlier.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402


class SameTurnTwinsTest(unittest.TestCase):
    def test_the_second_copy_is_not_saved(self):
        added = []

        def add_task(phone, task):
            added.append(task)
            return {**task, "id": f"t{len(added)}"}

        bank = {"text": "ללכת לבנק", "date": "2026-10-21", "category": "general"}
        with mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: []), \
             mock.patch.object(agent_turn.user_memory, "add_task", add_task), \
             mock.patch.object(agent_turn.user_memory, "update_task", lambda *a, **k: True), \
             mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone",
                               mock.AsyncMock(return_value=None)), \
             mock.patch.object(agent_turn.supabase_tasks, "queue_pending", lambda *a: None), \
             mock.patch.object(agent_turn.task_grouping, "group_label", lambda *a: None):
            saved = asyncio.run(agent_turn.persist_agent_tasks(
                "972550000001", "ללכת לבנק מחר", {"tasks": [dict(bank), dict(bank)]}, "app"))
        self.assertEqual(len(added), 1)
        self.assertEqual([t["id"] for t in saved], ["t1"])


if __name__ == "__main__":
    unittest.main()
