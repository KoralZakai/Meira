"""Profile extraction waits only for a message that may state a profile fact.

19.10: until onboarding was complete, EVERY agent turn first ran a model call
to look for home / transport / routine in the message, and the reply waited
for it — 1-2 s on "call Dotan at 5", which names none of them.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lumi_agent  # noqa: E402


class ProfileHint(unittest.TestCase):
    def test_a_profile_fact_is_waited_for(self):
        for msg in ("אני גרה ברמת גן", "I live on Herzl 5", "אני נוסעת באוטובוס",
                    "my morning routine is 40 minutes", "קוראים לי קורל"):
            self.assertTrue(lumi_agent._PROFILE_HINT_RE.search(msg), msg)

    def test_an_ordinary_task_is_not(self):
        for msg in ("שיחה עם דותן ב-5", "call Dotan at 5", "תוסיפי פגישה מחר ב-10",
                    "אני צריכה לקנות חלב"):
            self.assertFalse(lumi_agent._PROFILE_HINT_RE.search(msg), msg)


class NotWaited(unittest.TestCase):
    def test_the_turn_does_not_wait_for_extraction_without_a_hint(self):
        order = []

        async def slow_extract(client, content, phone):
            await asyncio.sleep(0.05)
            order.append("extract")

        async def stop_here(*a, **k):
            order.append("memory")
            raise RuntimeError("stop the turn here")

        async def go():
            with mock.patch.object(lumi_agent, "_extract_profile", slow_extract), \
                 mock.patch.object(lumi_agent, "_get_raw_client", lambda: None), \
                 mock.patch.object(lumi_agent.user_profile, "missing_fields", lambda p: ["homeAddress"]), \
                 mock.patch.object(lumi_agent.user_profile, "get_profile", lambda p: {}), \
                 mock.patch.object(lumi_agent.memory_recall, "block_for", stop_here):
                with self.assertRaises(RuntimeError):
                    await lumi_agent.handle_whatsapp_message("call Dotan at 5", {"id": "p1"}, None)
                await asyncio.sleep(0.1)

        asyncio.run(go())
        self.assertEqual(order, ["memory", "extract"])


if __name__ == "__main__":
    unittest.main()
