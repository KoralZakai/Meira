"""The question reaches the planner (Koral, 19.10).

"האופניים שלי ברחוב פלורנטין, ואני צריכה להיות במפגש של באות" got back
"where is the meetup and when?" — the event was on her day. Now the
understanding names the event by its id and the answer is worked out in code.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import understand  # noqa: E402
from tests.test_vehicle_chain import fake_route, HERE, BIKE, EVENT  # noqa: E402

BAOT = {"id": "ev-baot", "text": "באות מוצאות - Faye", "fixed_time": "18:00", "duration_minutes": 180,
        "date": "2026-10-19", "status": "pending",
        "location": {"address": "WE TLV", "lat": EVENT["lat"], "lng": EVENT["lng"], "displayName": "WE TLV"}}


class Understood(unittest.TestCase):
    def test_the_vehicle_lookup_is_kept(self):
        got = understand.lookup_of({"what": "vehicle", "vehicle": "bike", "vehicle_at": "פלורנטין",
                                    "event_task_id": "ev-baot"})
        self.assertEqual((got["what"], got["vehicle_at"], got["event_task_id"]),
                         ("vehicle", "פלורנטין", "ev-baot"))
        self.assertIsNone(understand.lookup_of({"what": "vehicle"}))   # where is it? nothing to run

    def test_typed_it_is_read_as_a_question_first(self):
        self.assertTrue(agent_turn.may_be_a_question("האופניים שלי ברחוב פלורנטין, ואני צריכה להיות במפגש של באות"))
        self.assertTrue(agent_turn.may_be_a_question("אני צריכה לאסוף את האופניים מפלורנטין, תכנני לי"))


class Answered(unittest.TestCase):
    def answer(self, event_task_id, words=None, memory=()):
        async def origin(profile, here, origin="auto"):
            return dict(HERE), "here", None

        async def dest(text, profile, recall=None):
            return (dict(HERE), True, None) if text == "home" else (dict(BIKE), False, None)

        async def no_geocode(*a, **k):
            return None

        with mock.patch.object(agent_turn.place_ranker, "resolve_origin", origin), \
             mock.patch.object(agent_turn.place_ranker, "resolve_destination", dest), \
             mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value="u1")), \
             mock.patch.object(agent_turn.supabase_tasks, "tasks_for_user", mock.AsyncMock(return_value=[BAOT])), \
             mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: [dict(t) for t in memory]), \
             mock.patch.object(agent_turn.user_profile, "get_profile", lambda k: {"homeAddress": "x"}), \
             mock.patch("geo.directions_detailed", fake_route()), \
             mock.patch("geo.geocode", no_geocode), \
             mock.patch.object(agent_turn._tz, "now_il", lambda: __import__("datetime").datetime(2026, 10, 19, 13, 10)):
            # The fake routes by place NAME; the event's point carries WE TLV.
            return asyncio.run(agent_turn.answer_lookup(
                {"what": "vehicle", "vehicle": "bike", "vehicle_at": "פלורנטין",
                 "event_task_id": event_task_id, "event_words": words, "origin": "auto"},
                "האופניים שלי בפלורנטין", {"id": "u1"}, "u1", "972500000001", None))

    def test_the_named_event_from_her_day_is_planned_without_asking(self):
        out = self.answer("ev-baot")
        self.assertIsNotNone(out)
        self.assertEqual(out["type"], "answer")
        self.assertIn("באות מוצאות - Faye ב-18:00", out["text"])
        self.assertIn("לצאת 17:05", out["text"])

    def test_no_event_named_searches_her_day(self):
        out = self.answer(None)
        self.assertIn("הדרכים לאסוף את האופניים היום", out["text"])
        self.assertIn("באות מוצאות", out["text"])


if __name__ == "__main__":
    unittest.main()


class FromHerWords(unittest.TestCase):
    """Live, 19.10 after the deploy: the model called it a route to "באות" and
    Meira asked where the meetup was. Code decides now."""

    def test_the_sentence_is_a_vehicle_question_whatever_the_model_said(self):
        got = understand.vehicle_lookup("האופניים שלי ברחוב פלורנטין, ואני צריכה להיות במפגש של באות. מה לעשות?",
                                        {"what": "route", "destination": "באות"})
        self.assertEqual((got["what"], got["vehicle"], got["vehicle_at"], got["event_words"]),
                         ("vehicle", "bike", "רחוב פלורנטין", "באות"))
        self.assertEqual(understand.vehicle_lookup("אני צריכה לאסוף את האופניים מפלורנטין, תכנני לי")["vehicle_at"],
                         "פלורנטין")
        self.assertEqual(understand.vehicle_lookup("my car is at the beach")["vehicle"], "car")
        self.assertIsNone(understand.vehicle_lookup("שיחה עם דותן ב-5"))

    def test_the_event_is_found_by_a_word_of_its_name(self):
        events = [{"id": "a", "name": "סרט ברציף", "start": "17:00"},
                  {"id": "b", "name": "באות מוצאות - Faye", "start": "18:00"}]
        self.assertEqual(agent_turn.event_named(events, "במפגש של באות", "13:10")["id"], "b")
        self.assertIsNone(agent_turn.event_named(events, "אני צריכה , תכנני לי את המסלול", "13:10"))

    def test_named_by_words_is_planned_for_that_event(self):
        out = Answered.answer(self, None, words="המפגש של באות")
        self.assertIn("באות מוצאות - Faye ב-18:00", out["text"])


class OneEventOnce(unittest.TestCase):
    def test_the_same_event_from_two_stores_is_one_branch(self):
        events_seen = []

        async def capture(**kw):
            events_seen.extend(kw["events"])
            return {"ok": False, "reason": "no_route"}

        with mock.patch("vehicle_chain.plan_pickup", capture):
            Answered.answer(self, None, memory=[BAOT])
        self.assertEqual(len(events_seen), 1)


class SaysWhatIsMissing(unittest.TestCase):
    def test_a_place_not_on_the_map_is_said_never_an_empty_plan(self):
        async def origin(profile, here, origin="auto"):
            return dict(HERE), "here", None

        async def nowhere(text, profile, recall=None):
            return None, False, "destination_not_found"

        with mock.patch.object(agent_turn.place_ranker, "resolve_origin", origin), \
             mock.patch.object(agent_turn.place_ranker, "resolve_destination", nowhere), \
             mock.patch.object(agent_turn.user_profile, "get_profile", lambda k: {}):
            out = asyncio.run(agent_turn.answer_lookup(
                {"what": "vehicle", "vehicle": "bike", "vehicle_at": "פלורנטין תחשבי"},
                "האופניים שלי", {"id": "u1"}, "u1", "972500000001", None))
        self.assertIn("לא מצאתי במפה", out["text"])
        self.assertFalse(out["chain"]["ok"])
        self.assertNotIn("answer", out)   # the installed AnswerCard needs `results`


class WithAWish(unittest.TestCase):
    def test_a_wish_at_20_plans_the_evening_with_the_clash(self):
        from tests.test_vehicle_chain import GYM, Evening, TABLE
        TABLE.update(Evening.EXTRA)
        try:
            async def origin(profile, here, origin="auto"):
                return dict(HERE), "here", None

            async def dest(text, profile, recall=None):
                return {"home": (dict(HERE), True, None), "חדר כושר": (dict(GYM), False, None)}.get(
                    text, (dict(BIKE), False, None))

            with mock.patch.object(agent_turn.place_ranker, "resolve_origin", origin), \
                 mock.patch.object(agent_turn.place_ranker, "resolve_destination", dest), \
                 mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone", mock.AsyncMock(return_value="u1")), \
                 mock.patch.object(agent_turn.supabase_tasks, "tasks_for_user", mock.AsyncMock(return_value=[BAOT])), \
                 mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: []), \
                 mock.patch.object(agent_turn.user_profile, "get_profile", lambda k: {"homeAddress": "x"}), \
                 mock.patch("geo.directions_detailed", fake_route()), \
                 mock.patch.object(agent_turn._tz, "now_il", lambda: __import__("datetime").datetime(2026, 10, 19, 15, 40)):
                out = asyncio.run(agent_turn.answer_lookup(
                    {"what": "vehicle", "vehicle": "bike", "vehicle_at": "פלורנטין", "event_task_id": None,
                     "also": [{"what": "חדר כושר", "start": "20:00", "end": None, "place": None}]},
                    "וגם בא לי להתאמן ב-20", {"id": "u1"}, "u1", "972500000001", None))
        finally:
            for k in Evening.EXTRA:
                TABLE.pop(k, None)
        self.assertIn("נופל בתוך באות מוצאות - Faye (18:00–21:00)", out["text"])
        self.assertIn("ב-19:45", out["text"])


class TheCardNamesTheEvent(unittest.TestCase):
    def test_the_named_plan_carries_the_event_name_for_the_map(self):
        out = Answered.answer(self, "ev-baot")
        self.assertEqual(out["chain"]["event"], "באות מוצאות - Faye")
