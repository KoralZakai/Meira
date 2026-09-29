"""understand — the conversation read for meaning, then acted on by code.

Koral, 2026-09-28: the app saved a task titled "תוסיפי לי שיחה עם דותן בזום 5."
— the agent answered in prose, and the regex rescue took her request, word for
word, as the task. She asked for an agent that understands what she wants and
then acts. The model is mocked here; what is tested is everything the CODE
does with its answer: the title it keeps, the date and hour it resolves, what
an update touches, and the fallback when the model is unreachable.
"""
import asyncio
import json
import os
import sys
import unittest
from datetime import date
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_turn  # noqa: E402
import task_rescue  # noqa: E402
import understand  # noqa: E402

TODAY = date(2026, 9, 28)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _model_says(payload):
    reply = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))],
                            usage=None)
    client = mock.MagicMock()
    client.chat.completions.create = mock.AsyncMock(return_value=reply)
    return mock.patch.object(understand, "_client", lambda: client)


class TheDotanCall(unittest.TestCase):
    SAID = "תוסיפי לי שיחה עם דותן בזום 5."

    def test_the_title_is_the_thing_not_the_request(self):
        action = {"do": "add", "title": "שיחת זום עם דותן", "start": "17:00", "end": None,
                  "date_expression": None, "place": None}
        task = understand.task_from(action, self.SAID, TODAY)
        self.assertEqual(task["text"], "שיחת זום עם דותן")
        self.assertEqual(task["fixed_time"], "17:00")
        self.assertEqual(task["category"], "zoom")
        self.assertEqual(task["date"], TODAY.isoformat())

    def test_a_range_is_its_length(self):
        action = {"do": "add", "title": "שיחה עם דותן", "start": "14:00", "end": "14:30"}
        self.assertEqual(understand.task_from(action, "", TODAY)["duration_minutes"], 30)

    def test_no_time_no_day_is_a_flexible_task(self):
        task = understand.task_from({"do": "add", "title": "לשלוח קורות חיים לצ׳קפוינט"}, "", TODAY)
        self.assertIsNone(task["date"])
        self.assertIsNone(task["fixed_time"])

    def test_reserve_duty_is_a_working_day_on_its_date(self):
        task = understand.task_from({"do": "add", "title": "מילואים בפיקוד העורף",
                                     "date_expression": "8 באוקטובר", "place": "רמלה"}, "", TODAY)
        self.assertEqual(task["date"], "2026-10-08")
        self.assertEqual(task["location"], "רמלה")


class TheTurn(unittest.TestCase):
    DAY = [{"id": "g1", "text": "אימון", "date": "2026-09-28", "fixed_time": "18:00",
            "status": "pending"}]

    def _act(self, payload, message):
        added, updated = [], []
        with _model_says(payload), \
                mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=self.DAY)), \
                mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: self.DAY), \
                mock.patch.object(agent_turn.user_memory, "add_task",
                                  lambda p, t: added.append(t) or {"id": "new1"}), \
                mock.patch.object(agent_turn.user_memory, "update_task",
                                  lambda p, i, patch: updated.append((i, patch))), \
                mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone",
                                  mock.AsyncMock(return_value=None)), \
                mock.patch.object(agent_turn.session, "set_active_task", lambda *a: None):
            saved, note, ok = run(agent_turn.act_on_understanding("u-phone", message, "app", []))
        return saved, note, ok, added, updated

    def test_an_add_is_saved_with_the_models_title(self):
        saved, note, ok, added, _ = self._act(
            {"understood": "להוסיף שיחת זום עם דותן ב-17:00",
             "actions": [{"do": "add", "title": "שיחת זום עם דותן", "start": "17:00"}]},
            "תוסיפי לי שיחה עם דותן בזום 5.")
        self.assertTrue(ok)
        self.assertEqual([t["text"] for t in added], ["שיחת זום עם דותן"])
        self.assertIn("17:00", note)

    def test_moving_a_task_updates_it_and_adds_nothing(self):
        _, note, ok, added, updated = self._act(
            {"understood": "להזיז את האימון ל-19:00",
             "actions": [{"do": "update", "task_id": "g1", "start": "19:00", "end": "21:00"}]},
            "תזיזי את האימון לשבע")
        self.assertEqual(added, [])
        self.assertEqual(updated, [("g1", {"fixed_time": "19:00", "duration_minutes": 120})])
        self.assertIn("עדכנתי", note)

    def test_an_id_that_is_not_hers_touches_nothing(self):
        _, _, ok, added, updated = self._act(
            {"understood": "?", "actions": [{"do": "update", "task_id": "someone-else", "start": "19:00"}]},
            "תזיזי ל-7")
        self.assertTrue(ok)
        self.assertEqual((added, updated), ([], []))

    def test_chat_is_understood_as_nothing_to_do(self):
        saved, note, ok, added, _ = self._act({"understood": "תודה", "actions": []}, "תודה!")
        self.assertTrue(ok)
        self.assertEqual((saved, added, note), ([], [], ""))

    def test_unclear_is_asked_not_guessed(self):
        saved, note, ok, added, _ = self._act(
            {"understood": "מילואים, תאריך לא ברור", "ask": "התכוונת ל-8 באוקטובר",
             "actions": []}, "יש לי מילואים ב-80 באוקטובר")
        self.assertTrue(ok)
        self.assertEqual(added, [])
        self.assertTrue(note.endswith("התכוונת ל-8 באוקטובר?"))

    def test_an_unreachable_model_falls_back(self):
        client = mock.MagicMock()
        client.chat.completions.create = mock.AsyncMock(side_effect=TimeoutError("no answer"))
        with mock.patch.object(understand, "_client", lambda: client):
            self.assertIsNone(run(understand.understand("תוסיפי לי שיחה", [], [])))


class TheMicTurn(unittest.TestCase):
    """voice_plan: understand → act → the agent is TOLD, and saves nothing twice."""

    def test_saved_once_and_the_agent_knows(self):
        seen, added = {}, []

        async def agent(stamped, user, learned, here=None):
            seen["stamped"] = stamped
            # The agent saves the same call again, as it would.
            return {"text": "נקבע ✓", "tasks": [{"text": "שיחת זום עם דותן",
                                                "date": date.today().isoformat(), "fixed_time": "17:00"}]}

        store = []
        with _model_says({"understood": "שיחה", "actions": [
                    {"do": "add", "title": "שיחת זום עם דותן", "start": "17:00"}]}), \
                mock.patch.object(agent_turn, "handle_whatsapp_message", agent), \
                mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=[])), \
                mock.patch.object(agent_turn, "clash_note", mock.AsyncMock(return_value="")), \
                mock.patch.object(agent_turn, "meira_just_asked", lambda k: False), \
                mock.patch.object(agent_turn.conversation, "get_history", lambda k: []), \
                mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: list(store)), \
                mock.patch.object(agent_turn.user_memory, "add_task",
                                  lambda p, t: (store.append({**t, "id": f"t{len(store)}", "status": "pending"}),
                                                added.append(t), {"id": f"t{len(store) - 1}"})[2]), \
                mock.patch.object(agent_turn.user_memory, "update_task", lambda *a: None), \
                mock.patch.object(agent_turn.supabase_tasks, "user_id_for_phone",
                                  mock.AsyncMock(return_value=None)), \
                mock.patch.object(agent_turn.session, "set_active_task", lambda *a: None):
            out = run(agent_turn.run_turn("mic-phone", "תוסיפי לי שיחה עם דותן בזום 5.",
                                          {"id": "mic-phone"}, mode="voice_plan"))
        self.assertEqual(len(added), 1)
        self.assertIn("ALREADY DONE", seen["stamped"])
        self.assertIn("שיחת זום עם דותן", seen["stamped"])
        self.assertEqual([t["text"] for t in out["tasks"]], ["שיחת זום עם דותן"])


class TheFallbackTitle(unittest.TestCase):
    def test_the_request_is_not_the_title(self):
        self.assertEqual(task_rescue.title_from("תוסיפי לי שיחה עם דותן"), "שיחה עם דותן")
        self.assertEqual(task_rescue.title_from("add a call with Dotan to my schedule"),
                         "a call with Dotan")


if __name__ == "__main__":
    unittest.main()
