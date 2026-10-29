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

    def _turn(self, message):
        seen, added = {}, []

        async def agent(stamped, user, learned, here=None, tier=None):
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
                mock.patch.object(agent_turn.session, "set_active_task", lambda *a: None), \
                mock.patch.object(agent_turn.session, "set_last_saved", lambda *a: None):
            out = run(agent_turn.run_turn("mic-phone", message,
                                          {"id": "mic-phone"}, mode="voice_plan"))
        return seen, added, out

    def test_saved_once_and_the_agent_is_not_asked_to_repeat_it(self):
        # 19.10: a mic message the understanding fully did no longer runs the
        # agent just to say "saved" — and it is still saved exactly once.
        seen, added, out = self._turn("תוסיפי לי שיחה עם דותן בזום 5.")
        self.assertEqual(len(added), 1)
        self.assertNotIn("stamped", seen)
        self.assertEqual([t["text"] for t in out["tasks"]], ["שיחת זום עם דותן"])
        self.assertIn("שיחת זום עם דותן", out["text"])

    def test_saved_once_and_the_agent_knows_when_it_is_still_needed(self):
        seen, added, out = self._turn("תוסיפי לי שיחה עם דותן בזום 5 ותזכירי לי לפני.")
        self.assertEqual(len(added), 1)
        self.assertIn("ALREADY DONE", seen["stamped"])
        self.assertIn("שיחת זום עם דותן", seen["stamped"])
        self.assertEqual([t["text"] for t in out["tasks"]], ["שיחת זום עם דותן"])


class AQuestionIsAnswered(unittest.TestCase):
    """7.10: "what's the fastest beach by car from home?" on the mic came back as
    "which beach?" and then "where do you live?". A question is Meira's to
    answer — this step must not bounce it back, and must not save it."""
    SAID = "מה החוף הכי מהיר להגיע אליו באוטו מהבית?"

    def test_a_question_carries_no_ask_even_if_the_model_writes_one(self):
        with _model_says({"understood": "החוף הכי מהיר באוטו", "kind": "question",
                          "ask": "לאיזה חוף?", "actions": []}):
            out = run(understand.understand(self.SAID, [], []))
        self.assertEqual(out["kind"], "question")
        self.assertIsNone(out["ask"])
        self.assertEqual(out["actions"], [])

    def test_a_missing_kind_is_read_from_the_actions(self):
        with _model_says({"understood": "x", "actions": [{"do": "add", "title": "אימון"}]}):
            self.assertEqual(run(understand.understand("אימון", [], []))["kind"], "do")
        with _model_says({"understood": "תודה", "actions": []}):
            self.assertEqual(run(understand.understand("תודה", [], []))["kind"], "chat")

    def test_it_is_told_where_she_lives_and_is(self):
        about = understand.about_her({"homeAddress": "יגאל אלון 94", "transportType": "car"},
                                     {"lat": 32.07, "lng": 34.79, "label": "רוטשילד"})
        self.assertIn("יגאל אלון 94", about)
        self.assertIn("car", about)
        self.assertIn("רוטשילד", about)
        self.assertIn("not saved", understand.about_her({}, None))
        reply = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
            content=json.dumps({"understood": "", "kind": "question", "actions": []})))], usage=None)
        client = mock.MagicMock()
        client.chat.completions.create = mock.AsyncMock(return_value=reply)
        with mock.patch.object(understand, "_client", lambda: client):
            run(understand.understand(self.SAID, [], [], about=about))
        sent = client.chat.completions.create.call_args.kwargs["messages"][-1]["content"]
        self.assertIn("ABOUT HER", sent)
        self.assertIn("יגאל אלון 94", sent)

    def test_the_mic_answers_and_saves_nothing(self):
        seen, added = {}, []

        async def agent(stamped, user, learned, here=None, tier=None):
            seen["stamped"] = stamped
            return {"text": "🏖️ חוף הילטון — ~23 דק׳", "tasks": []}

        with _model_says({"understood": "החוף הכי מהיר", "kind": "question",
                          "ask": "לאיזה חוף?", "actions": []}), \
                mock.patch.object(agent_turn, "handle_whatsapp_message", agent), \
                mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=[])), \
                mock.patch.object(agent_turn, "clash_note", mock.AsyncMock(return_value="")), \
                mock.patch.object(agent_turn, "meira_just_asked", lambda k: False), \
                mock.patch.object(agent_turn.conversation, "get_history", lambda k: []), \
                mock.patch.object(agent_turn.user_profile, "get_profile",
                                  lambda k: {"homeAddress": "יגאל אלון 94"}), \
                mock.patch.object(agent_turn.user_memory, "tasks_for_phone", lambda p: []), \
                mock.patch.object(agent_turn.user_memory, "add_task",
                                  lambda p, t: added.append(t) or {"id": "x"}), \
                mock.patch.object(agent_turn, "rescue_turn",
                                  mock.AsyncMock(side_effect=AssertionError("rescue ran"))):
            out = run(agent_turn.run_turn("mic-phone", self.SAID, {"id": "mic-phone"},
                                          mode="voice_plan"))
        self.assertEqual(added, [])
        self.assertIn("SHE ASKED A QUESTION", seen["stamped"])
        self.assertNotIn("PLAN TODAY", seen["stamped"])
        self.assertEqual(out["type"], "answer")
        self.assertNotIn("?", out["text"])
        self.assertEqual(out["tasks"], [])


class TheFallbackTitle(unittest.TestCase):
    def test_the_request_is_not_the_title(self):
        self.assertEqual(task_rescue.title_from("תוסיפי לי שיחה עם דותן"), "שיחה עם דותן")
        self.assertEqual(task_rescue.title_from("add a call with Dotan to my schedule"),
                         "a call with Dotan")


if __name__ == "__main__":
    unittest.main()


class AQuestionAboutHerPast(unittest.TestCase):
    """'כמה פעמים התאמנתי השבוע?' names a workout and is not one. Even when the
    model files it as an add, nothing is saved (Feature 2, 20.10)."""

    def test_a_count_of_her_past_is_never_saved(self):
        wrong = {"understood": "אימון", "kind": "do", "ask": None, "lookup": None,
                 "actions": [{"do": "add", "title": "אימון", "start": None, "end": None,
                              "date_expression": "השבוע", "place": None}]}
        with _model_says(wrong):
            out = run(understand.understand("כמה פעמים התאמנתי השבוע?", [], []))
        self.assertEqual(out["kind"], "question")
        self.assertEqual(out["actions"], [])

    def test_adding_a_workout_still_adds(self):
        add = {"understood": "אימון", "kind": "do", "ask": None, "lookup": None,
               "actions": [{"do": "add", "title": "אימון", "start": "19:00", "end": None,
                            "date_expression": "מחר", "place": None}]}
        with _model_says(add):
            out = run(understand.understand("תוסיפי אימון מחר ב-19", [], []))
        self.assertEqual(out["kind"], "do")
        self.assertEqual(len(out["actions"]), 1)


class RenameTests(unittest.TestCase):
    def test_an_update_can_rename_and_keeps_the_rest(self):
        import understand
        patch = understand.patch_from({"do": "update", "task_id": "x", "title": "יוגה"})
        self.assertEqual(patch, {"text": "יוגה"})          # place, hour, way stay as they were

    def test_the_prompt_teaches_the_replacement(self):
        import understand
        self.assertIn('"title"', understand._SYSTEM)
        self.assertIn("REPLACES or RENAMES", understand._SYSTEM)
