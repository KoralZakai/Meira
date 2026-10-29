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

        async def fake_handle(content, user, learned, here=None, tier=None):
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

    def _mic(self, content):
        """A mic turn where the understanding step saved one task."""
        calls = []

        async def fake_act(phone, content, channel, history, about="", seen=None, result=None, **_):
            seen["kind"] = "do"
            return [{"id": "t1", "text": "שיחה עם דותן"}], "נשמר: שיחה עם דותן · 14:00 ✓", True

        async def fake_handle(content, user, learned, here=None, tier=None):
            calls.append(content)
            return {"type": "chat", "text": "Saved it!"}

        async def no_clash(*a, **k):
            return ""

        async def fake_persist(phone, content, response, channel):
            return []

        with patch.object(agent_turn, "act_on_understanding", fake_act), \
             patch.object(agent_turn, "handle_whatsapp_message", fake_handle), \
             patch.object(agent_turn, "persist_agent_tasks", fake_persist), \
             patch.object(agent_turn, "clash_note", no_clash), \
             patch.object(agent_turn.conversation, "append", lambda *a, **k: None), \
             patch.object(agent_turn.conversation, "get_history", lambda *a, **k: []):
            out = asyncio.run(agent_turn.run_turn(
                "972500000001", content, {"id": "u"}, None, channel="app", mode="voice_plan"))
        return calls, out

    def test_a_mic_save_the_understanding_did_skips_the_agent(self):
        # 19.10: the full ReAct pass ran only to say "saved" — 5-20 s for nothing.
        calls, out = self._mic("שיחה עם דותן משתיים עד שתיים וחצי")
        self.assertEqual(calls, [])
        self.assertEqual(out["text"], "נשמר: שיחה עם דותן · 14:00 ✓")
        self.assertEqual([t["id"] for t in out["tasks"]], ["t1"])

    def test_anything_the_understanding_cannot_do_still_goes_to_the_agent(self):
        for content in ("שיחה עם דותן בשתיים ותזכירי לי ב-13:30",
                        "meeting at 3, how do I get there?"):
            calls, _ = self._mic(content)
            self.assertEqual(len(calls), 1, content)

    def test_the_stamp_is_not_in_the_system_prompt(self):
        import lumi_agent
        self.assertNotIn("APP VOICE", lumi_agent._STATIC_RULES)


if __name__ == "__main__":
    unittest.main()
