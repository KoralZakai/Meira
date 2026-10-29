"""Meira asks, she answers, Meira learns (questions_store, user_rules, 6.10).

Koral: "for anything unclear, pop up a question; after it, record what
happened and how I answered, learn from it, and update the rules / memory /
data". These pin each half: the data changes where it lives, the memory
sentence is written (and replaced when she changes her mind), the answer is
recorded from the app AND from the chat, a rule is only PROPOSED — after two
same answers that generalise — and a confirmed rule reaches the agent.
"""
import importlib
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient   # noqa: E402

import config                                # noqa: E402

_TMP = tempfile.mkdtemp(prefix="lumi-questions-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "user_store", "user_profile", "questions_store", "user_rules", "feedback_store"):
    mod = importlib.import_module(_m)
    mod._PATH = os.path.join(_TMP, os.path.basename(getattr(mod, "_PATH")))

import app_auth          # noqa: E402
import identity_keys     # noqa: E402
import lumi_agent        # noqa: E402
import main              # noqa: E402
import questions_store   # noqa: E402
import user_memory       # noqa: E402
import user_profile      # noqa: E402
import user_rules        # noqa: E402

client = TestClient(main.app)
UID = "koral-uuid"
AUTH = {"Authorization": "Bearer good-token"}
KICK = "קיקבוקס 20:30-21:30 יגאל אלון 94"


def _signed_in():
    async def fake_verify(authorization):
        if not authorization:
            raise app_auth.AuthError("missing bearer token")
        return {"userId": UID, "email": "k@example.com"}

    async def fake_phone(user_id):
        return None

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


def _clear():
    for path in (questions_store._PATH, user_rules._PATH, user_profile._PATH, user_memory._PATH):
        if os.path.exists(path):
            os.remove(path)
    identity_keys.invalidate()


class Answers(unittest.TestCase):
    def setUp(self):
        _clear()

    def test_bad_answers_are_refused(self):
        for kind, answer in (("nope", {"choice": "every_day"}), ("routine_days", {"choice": "maybe"}),
                             ("routine_days", {"choice": "days", "days": []})):
            with self.assertRaises(ValueError):
                questions_store.record(UID, kind, "x|20:30", answer)

    def test_an_answer_becomes_one_memory_sentence_and_a_new_one_replaces_it(self):
        questions_store.record(UID, "routine_days", "קיקבוקס|20:30", {"choice": "days", "days": [2]})
        questions_store.record(UID, "routine_days", "קיקבוקס|20:30", {"choice": "days", "days": [3]})
        routines = user_memory.get_memory(UID)["routines"]
        about = [r for r in routines if r.startswith("routine 'קיקבוקס' at 20:30 is ")]
        self.assertEqual(len(about), 1, routines)
        self.assertIn("Wed", about[0])
        self.assertEqual(len(questions_store.answers(UID, "routine_days")), 1)

    def test_the_effect_says_what_changes_in_both_languages(self):
        rec = questions_store.record(UID, "routine_days", "a|10:00", {"choice": "days", "days": [1, 3]})
        eff = questions_store.effect(rec)
        self.assertIn("Mon & Wed", eff["en"])
        self.assertIn("ב׳ ו-ד׳", eff["he"])

    def test_an_answer_given_in_the_chat_counts(self):
        user_profile.update_profile(UID, routinesNotes=KICK)
        before = user_profile.get_profile(UID)["routinesNotes"]
        user_profile.update_profile(UID, routinesNotes=f"{KICK} בימי שלישי")
        made = questions_store.record_from_lines(UID, before, user_profile.get_profile(UID)["routinesNotes"])
        self.assertEqual(len(made), 1)
        self.assertEqual(made[0]["subject"], "קיקבוקס|20:30")
        self.assertEqual(made[0]["answer"], {"choice": "days", "days": [2]})
        self.assertEqual(made[0]["channel"], "chat")


class AnswerRoute(unittest.TestCase):
    def setUp(self):
        _clear()

    def _answer(self, line, answer, rewrite=True, subject="קיקבוקס|20:30"):
        with _signed_in():
            return client.post("/app/questions/answer", headers=AUTH, json={
                "kind": "routine_days", "subject": subject, "line": line,
                "answer": answer, "rewrite_told": rewrite})

    def test_requires_a_token(self):
        self.assertEqual(client.post("/app/questions/answer", json={}).status_code, 401)

    def test_the_told_line_gets_its_days_where_it_lives(self):
        user_profile.update_profile(UID, routinesNotes=f"{KICK}\nמקלחת בוקר, קפה")
        r = self._answer(KICK, {"choice": "days", "days": [2]})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["new_line"], f"{KICK} · ימי ג׳")
        self.assertEqual(user_profile.get_profile(UID)["routinesNotes"], f"{KICK} · ימי ג׳\nמקלחת בוקר, קפה")
        self.assertIn("ג׳", body["effect"]["he"])

    def test_a_line_that_is_gone_is_said_not_guessed(self):
        user_profile.update_profile(UID, routinesNotes="מקלחת בוקר")
        body = self._answer(KICK, {"choice": "every_day"}).json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["reason"], "line_changed")
        self.assertEqual(len(questions_store.answers(UID)), 1)   # the answer still counts

    def test_a_box_line_is_recorded_without_touching_the_server_copy(self):
        r = self._answer("יוגה 07:00", {"choice": "days", "days": [0]}, rewrite=False, subject="יוגה|07:00")
        self.assertTrue(r.json()["ok"])
        self.assertEqual(r.json()["applied"], {})

    def test_bad_answer_is_400(self):
        self.assertEqual(self._answer(KICK, {"choice": "sometimes"}).status_code, 400)


class Rules(unittest.TestCase):
    def setUp(self):
        _clear()

    def _every_day(self, subject):
        questions_store.record(UID, "routine_days", subject, {"choice": "every_day"})

    def test_one_answer_is_not_a_rule(self):
        self._every_day("walk|07:00")
        self.assertIsNone(user_rules.proposal_after(UID, "routine_days"))

    def test_two_same_answers_propose_a_rule_and_never_make_one_alone(self):
        self._every_day("walk|07:00")
        self._every_day("vitamins|08:00")
        prop = user_rules.proposal_after(UID, "routine_days")
        self.assertEqual(prop["id"], "routine_days:every_day")
        self.assertIn("כל יום", prop["ask"]["he"])
        self.assertEqual(user_rules.rules(UID), [])

    def test_a_contrary_answer_means_no_rule(self):
        self._every_day("walk|07:00")
        questions_store.record(UID, "routine_days", "kick|20:30", {"choice": "days", "days": [2]})
        self._every_day("vitamins|08:00")
        self.assertIsNone(user_rules.proposal_after(UID, "routine_days"))

    def test_two_tuesdays_are_a_coincidence_not_a_rule(self):
        questions_store.record(UID, "routine_days", "a|10:00", {"choice": "days", "days": [2]})
        questions_store.record(UID, "routine_days", "b|11:00", {"choice": "days", "days": [2]})
        self.assertIsNone(user_rules.proposal_after(UID, "routine_days"))

    def test_the_route_returns_the_proposal_with_the_second_answer(self):
        with _signed_in():
            client.post("/app/questions/answer", headers=AUTH, json={
                "kind": "routine_days", "subject": "walk|07:00", "line": "walk 07:00",
                "answer": {"choice": "every_day"}})
            body = client.post("/app/questions/answer", headers=AUTH, json={
                "kind": "routine_days", "subject": "vitamins|08:00", "line": "vitamins 08:00",
                "answer": {"choice": "every_day"}}).json()
        self.assertEqual(body["proposal"]["id"], "routine_days:every_day")

    def test_yes_makes_the_rule_and_the_agent_hears_it(self):
        with _signed_in():
            r = client.post("/app/rules", headers=AUTH, json={"id": "routine_days:every_day", "yes": True})
            self.assertEqual(r.json()["rule"]["kind"], "routine_days")
            listed = client.get("/app/rules", headers=AUTH).json()["rules"]
        self.assertEqual([x["id"] for x in listed], ["routine_days:every_day"])
        block = user_rules.prompt_block(UID)
        self.assertIn("every day", block)
        prompt = lumi_agent._system_prompt({"id": UID, "language": "he"}, None, {}, [], rules_block=block)
        self.assertTrue(prompt.startswith(lumi_agent._STATIC_RULES))
        self.assertIn("RULES SHE TAUGHT YOU", prompt)

    def test_no_is_quiet_for_a_month(self):
        user_rules.confirm(UID, "routine_days:every_day", False)
        self._every_day("walk|07:00")
        self._every_day("vitamins|08:00")
        self.assertIsNone(user_rules.proposal_after(UID, "routine_days"))

    def test_x_removes_the_rule(self):
        user_rules.confirm(UID, "routine_days:every_day", True)
        with _signed_in():
            body = client.delete("/app/rules?id=routine_days:every_day", headers=AUTH).json()
        self.assertTrue(body["removed"])
        self.assertEqual(user_rules.rules(UID), [])
        self.assertEqual(user_rules.prompt_block(UID), "")

    def test_with_a_rule_the_agent_applies_it_instead_of_asking(self):
        user_rules.confirm(UID, "routine_days:every_day", True)
        tools = {t.name: t for t in lumi_agent._make_tools(UID, "")}
        out = asyncio_run(tools["save_profile"].ainvoke({"routines_notes": "ריצה 06:30"}))
        self.assertNotIn("days_unsaid", out)
        self.assertIn("ריצה 06:30 · כל יום", user_profile.get_profile(UID)["routinesNotes"])

    def test_without_a_rule_the_agent_is_told_to_ask(self):
        tools = {t.name: t for t in lumi_agent._make_tools(UID, "")}
        out = asyncio_run(tools["save_profile"].ainvoke({"routines_notes": "ריצה 06:30"}))
        self.assertEqual(out["days_unsaid"], ["ריצה 06:30"])
        self.assertIn("which days", out["ask"])


def asyncio_run(coro):
    import asyncio
    return asyncio.new_event_loop().run_until_complete(coro)


if __name__ == "__main__":
    unittest.main()


class ChatSaysWhatItSaved(unittest.TestCase):
    """The one chat: a fact the agent saved comes back as a card with Undo."""

    def setUp(self):
        _clear()

    def test_a_routine_told_in_the_chat_is_reported(self):
        import agent_turn
        user_profile.update_profile(UID, routinesNotes="מקלחת בוקר, קפה", transportType="bike")
        before = agent_turn._profile_snapshot(UID)
        user_profile.update_profile(UID, routinesNotes=KICK, homeAddress="Mordei HaGeta'ot 21")
        changes = agent_turn._profile_changes(before, agent_turn._profile_snapshot(UID))
        self.assertIn({"kind": "routine_added", "text": KICK}, changes)
        self.assertIn("homeAddress", [c.get("field") for c in changes])
        self.assertNotIn("transportType", [c.get("field") for c in changes])

    def test_nothing_learned_nothing_reported(self):
        import agent_turn
        snap = agent_turn._profile_snapshot(UID)
        self.assertEqual(agent_turn._profile_changes(snap, agent_turn._profile_snapshot(UID)), [])
        self.assertEqual(agent_turn._profile_changes({}, snap), [])

    def test_undo_removes_the_told_line(self):
        user_profile.update_profile(UID, routinesNotes=f"{KICK}\nמקלחת בוקר")
        with _signed_in():
            body = client.post("/app/profile/routines/remove", headers=AUTH, json={"lines": [KICK]}).json()
            gone = client.post("/app/profile/routines/remove", headers=AUTH, json={"lines": [KICK]}).json()
            bad = client.post("/app/profile/routines/remove", headers=AUTH, json={})
        self.assertEqual(body["removed"], [KICK])
        self.assertEqual(user_profile.get_profile(UID)["routinesNotes"], "מקלחת בוקר")
        self.assertEqual(gone["removed"], [])          # said, not pretended
        self.assertEqual(bad.status_code, 400)

    def test_the_consolidated_list_replaces_every_duplicate(self):
        # 13.10, Koral: twelve lines of one workout → the phone sends the two it keeps.
        user_profile.update_profile(UID, routinesNotes=f"{KICK}\nאימון · ראשון · 20:00 · עיגל אלון 96\nאימון בערב · ראשון · 20:00")
        keep = ["אימון · ראשון, שני, שלישי · 20:00 · עיגול אלון 94, תל אביב", "אימון · שישי · 11:00 · יגאל אלון 94, תל אביב"]
        with _signed_in():
            body = client.post("/app/profile/routines/replace", headers=AUTH, json={"lines": keep}).json()
            empty = client.post("/app/profile/routines/replace", headers=AUTH, json={"lines": []})
        self.assertEqual(body, {"ok": True, "kept": 2})
        self.assertEqual(user_profile.get_profile(UID)["routinesNotes"],
                         "אימון · ראשון, שני, שלישי · 20:00 · יגאל אלון 94, תל אביב\nאימון · שישי · 11:00 · יגאל אלון 94, תל אביב")
        self.assertEqual(empty.status_code, 400)          # clearing everything is never a side effect
