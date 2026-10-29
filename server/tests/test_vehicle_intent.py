"""Reading "my bike is elsewhere" by meaning, not a word list (Koral, 19.10).

Live: "אני צריכה לקחת את האופנים שלי מפלורנטין תחשבי לי מתי ואיך" — the word
list knew "לאסוף", not "לקחת", nor the spelling "אופנים"; the general step
called it a route; the agent then wrote the heading of a plan with nothing
under it, and "כן" repeated it. A focused reader now fills the slots.
"""
import asyncio
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import understand  # noqa: E402
import vehicle_intent  # noqa: E402

LIVE = "אני צריכה לקחת את האופנים שלי מפלורנטין  תחשבי לי מתי ואיך"


def _client_saying(*payloads):
    replies = [SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(p)))],
                               usage=None) for p in payloads]
    client = mock.MagicMock()
    client.chat.completions.create = mock.AsyncMock(side_effect=replies)
    return client


class Slots(unittest.TestCase):
    def test_a_plan_with_a_place_is_a_vehicle_lookup(self):
        got = vehicle_intent.slots_of({"is_vehicle_plan": True, "vehicle": "bike", "vehicle_at": "פלורנטין",
                                       "event_task_id": None, "event_words": None,
                                       "also": [{"what": "אימון", "start": "20:00"}]})
        self.assertEqual((got["what"], got["vehicle_at"], got["also"][0]["start"]), ("vehicle", "פלורנטין", "20:00"))

    def test_not_a_plan_or_no_place_is_nothing(self):
        self.assertIsNone(vehicle_intent.slots_of({"is_vehicle_plan": False, "vehicle_at": "x"}))
        self.assertIsNone(vehicle_intent.slots_of({"is_vehicle_plan": True, "vehicle_at": None}))

    def test_yes_after_the_offer_still_opens_the_reader(self):
        hist = [{"role": "user", "content": LIVE},
                {"role": "assistant", "content": "רוצה שאחשב מסלול מדויק?"}]
        self.assertTrue(vehicle_intent.mentions_vehicle("כן", hist))
        self.assertFalse(vehicle_intent.mentions_vehicle("כן", [{"role": "user", "content": "פגישה ב-5"}]))


class InUnderstand(unittest.TestCase):
    def test_the_live_sentence_becomes_a_vehicle_question_even_when_the_main_step_says_route(self):
        main = {"understood": "x", "kind": "question", "actions": [], "ask": None,
                "lookup": {"what": "route", "destination": "פלורנטין"}}
        focused = {"is_vehicle_plan": True, "vehicle": "bike", "vehicle_at": "פלורנטין",
                   "event_task_id": None, "event_words": None, "also": []}
        main_client, focused_client = _client_saying(main), _client_saying(focused)
        with mock.patch.object(understand, "_client", lambda: main_client), \
             mock.patch.object(vehicle_intent, "_client", lambda: focused_client):
            out = asyncio.run(understand.understand(LIVE, [], [], "15:35"))
        self.assertEqual(out["kind"], "question")
        self.assertEqual(out["lookup"]["what"], "vehicle")
        self.assertEqual(out["lookup"]["vehicle_at"], "פלורנטין")

    def test_when_the_reader_cannot_run_the_words_still_carry_it(self):
        main = {"understood": "x", "kind": "question", "actions": [], "ask": None, "lookup": None}
        broken = mock.MagicMock()
        broken.chat.completions.create = mock.AsyncMock(side_effect=RuntimeError("down"))
        with mock.patch.object(understand, "_client", lambda: _client_saying(main)), \
             mock.patch.object(vehicle_intent, "_client", lambda: broken):
            out = asyncio.run(understand.understand(LIVE, [], [], "15:35"))
        self.assertEqual(out["lookup"]["vehicle_at"], "פלורנטין")


if __name__ == "__main__":
    unittest.main()


class Urgent(unittest.TestCase):
    """Live, 19.10: the chat chip "What's urgent?" answered with the nearest hospital."""

    def test_urgent_is_about_her_day(self):
        self.assertIsNone(understand.lookup_of({"what": "places", "category": "חירום"}, "What's urgent?"))
        self.assertIsNone(understand.lookup_of({"what": "places", "category": "חירום"}, "מה דחוף היום?"))

    def test_an_er_she_names_is_still_found(self):
        got = understand.lookup_of({"what": "places", "category": "חדר מיון"}, "מה חדר המיון הכי קרוב? זה דחוף")
        self.assertEqual(got["category"], "חדר מיון")
