"""The app's mic turn: the model must not pin clock times the planner will set.

After a voice turn the app runs day_planner over the day. A time the model
invents ("work on Meira at 16:00") becomes a fixed time the planner cannot
move — so the instruction rides in the user turn, next to `now` and `here`,
where the model reliably reads it. It is NOT added to the system prompt: the
static prefix must stay byte-identical for the provider's cache
(test_prompt_cache).
"""
import asyncio
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402


class VoicePlanStampTest(unittest.TestCase):
    def _run(self, **kw):
        seen = {}

        async def fake_handle(content, user, learned, here=None):
            seen["content"] = content
            return {"type": "chat", "text": "Got it!"}

        async def fake_persist(phone, content, response, channel):
            return [{"text": "saved"}]

        with patch.object(agent_turn, "handle_whatsapp_message", fake_handle), \
             patch.object(agent_turn, "persist_agent_tasks", fake_persist):
            out = asyncio.run(agent_turn.run_turn(
                "972500000001", "I must work on Meira today", {"id": "u"}, None, **kw))
        return seen["content"], out

    def test_voice_plan_turn_carries_the_instruction(self):
        content, out = self._run(channel="app", mode="voice_plan")
        self.assertIn("Do NOT give a flexible task a clock time", content)
        self.assertTrue(content.endswith("I must work on Meira today"))
        self.assertEqual(out["text"], "Got it!")

    def test_ordinary_turns_are_unchanged(self):
        content, _ = self._run(channel="app")
        self.assertNotIn("APP VOICE", content)
        content, _ = self._run(channel="app", mode="something-else")
        self.assertNotIn("APP VOICE", content)

    def test_the_stamp_is_not_in_the_system_prompt(self):
        import lumi_agent
        self.assertNotIn("APP VOICE", lumi_agent._STATIC_RULES)


if __name__ == "__main__":
    unittest.main()
