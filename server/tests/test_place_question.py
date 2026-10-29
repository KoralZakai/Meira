"""Meira asks "Where is X?" and records what she answered (questions_store, kind "place", 15.10).

A task whose place the phone could not find: the phone searches the map, asks
which of up to three rows it is, and tells the server what she picked. These pin
the server half: the kind is accepted (it used to be refused as "kind must be
one of ('routine_days',)"), a bad answer is a 400 that names the fix, a pick
becomes one memory sentence and a known place for the WhatsApp path, "Something
else" records the choice and teaches nothing, and the routine kind is untouched.
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

_TMP = tempfile.mkdtemp(prefix="lumi-place-question-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "user_store", "user_profile", "questions_store", "user_rules", "feedback_store",
           "known_places"):
    mod = importlib.import_module(_m)
    mod._PATH = os.path.join(_TMP, os.path.basename(getattr(mod, "_PATH")))

import app_auth          # noqa: E402
import identity_keys     # noqa: E402
import known_places      # noqa: E402
import main              # noqa: E402
import questions_store   # noqa: E402
import user_memory       # noqa: E402
import user_rules        # noqa: E402

client = TestClient(main.app)
UID = "koral-uuid"
AUTH = {"Authorization": "Bearer good-token"}
PICK = {"choice": "pick", "query": "Space Gym, תל אביב", "name": "Space Gym Yigal Alon",
        "address": "Yigal Alon St 76, Tel Aviv-Yafo", "lat": 32.0699, "lng": 34.7943}


def _signed_in(uid=UID):
    async def fake_verify(authorization):
        if not authorization:
            raise app_auth.AuthError("missing bearer token")
        return {"userId": uid, "email": "k@example.com"}

    async def fake_phone(user_id):
        return None

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


def _clear():
    for path in (questions_store._PATH, user_rules._PATH, user_memory._PATH, known_places._PATH):
        if os.path.exists(path):
            os.remove(path)
    identity_keys.invalidate()


def _post(answer, subject="task-1", line="אימון", uid=UID):
    with _signed_in(uid):
        return client.post("/app/questions/answer", headers=AUTH, json={
            "kind": "place", "subject": subject, "line": line, "answer": answer, "rewrite_told": False})


class Recording(unittest.TestCase):
    def setUp(self):
        _clear()

    def test_place_is_a_kind(self):
        self.assertIn("place", questions_store.KINDS)

    def test_a_pick_is_recorded_whole(self):
        rec = questions_store.record(UID, "place", "task-1", PICK, line="אימון")
        self.assertEqual(rec["answer"]["choice"], "pick")
        self.assertEqual((rec["answer"]["lat"], rec["answer"]["lng"]), (32.0699, 34.7943))
        self.assertEqual(len(questions_store.answers(UID, "place")), 1)

    def test_bad_place_answers_are_refused_and_say_why(self):
        bad = (
            ({"choice": "maybe"}, "choice"),
            ({"choice": "pick", "name": "x", "address": "y", "lat": 32, "lng": 34, "query": "q"} | {"name": ""}, "name and address"),
            ({**PICK, "address": ""}, "name and address"),
            ({**PICK, "lat": "north"}, "lat"),
            ({**PICK, "lat": 95}, "lat"),
            ({**PICK, "lng": 200}, "lng"),
            ({**PICK, "lat": 0, "lng": 0}, "0,0"),
        )
        for answer, hint in bad:
            with self.subTest(answer=answer):
                with self.assertRaises(ValueError) as caught:
                    questions_store.record(UID, "place", "task-1", answer)
                self.assertIn(hint, str(caught.exception))

    def test_a_pick_becomes_one_memory_sentence_and_a_newer_pick_replaces_it(self):
        questions_store.record(UID, "place", "task-1", PICK, line="אימון")
        questions_store.record(UID, "place", "task-2", {**PICK, "name": "Space Gym Ramat Gan",
                                                         "address": "Jabotinsky St 12, Ramat Gan"}, line="אימון")
        prefs = [p for p in user_memory.get_memory(UID)["preferences"] if p.startswith("place for 'אימון' is ")]
        self.assertEqual(len(prefs), 1, prefs)
        self.assertIn("Ramat Gan", prefs[0])
        self.assertIn("she picked it when asked", prefs[0])

    def test_something_else_teaches_the_memory_nothing(self):
        questions_store.record(UID, "place", "task-1", {"choice": "edit", "query": "Space Gym"}, line="אימון")
        self.assertEqual(user_memory.get_memory(UID)["preferences"], [])
        self.assertEqual(questions_store.answers(UID, "place")[0]["answer"]["choice"], "edit")

    def test_the_effect_is_said_in_both_languages(self):
        rec = questions_store.record(UID, "place", "task-1", PICK, line="אימון")
        eff = questions_store.effect(rec)
        self.assertIn("Yigal Alon St 76", eff["en"])
        self.assertIn("Yigal Alon St 76", eff["he"])
        self.assertIn("נשמר", eff["he"])
        edit = questions_store.effect(questions_store.record(UID, "place", "task-2", {"choice": "edit"}))
        self.assertIn("task", edit["en"])
        self.assertIn("במשימה", edit["he"])


class Route(unittest.TestCase):
    def setUp(self):
        _clear()

    def test_requires_a_token(self):
        self.assertEqual(client.post("/app/questions/answer", json={"kind": "place"}).status_code, 401)

    def test_a_pick_is_accepted_and_learned_for_whatsapp_too(self):
        r = _post(PICK)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["applied"], {"known_place": "ok"})
        self.assertIn("Yigal Alon St 76", body["effect"]["he"])
        self.assertIsNone(body["new_line"])
        self.assertNotIn("proposal", body)   # a place pick is never a rule
        # Remembered under the number-like key the WhatsApp path asks by, when she has one.
        for key in (UID,):
            self.assertEqual(len(questions_store.answers(key, "place")), 1)

    def test_known_place_is_found_again_by_the_activity(self):
        with patch.object(known_places, "remember", wraps=known_places.remember) as remember:
            _post(PICK, line="אימון")
        called = [c.args[1] for c in remember.call_args_list]
        self.assertIn("אימון", called)
        args = remember.call_args_list[0]
        self.assertEqual(args.args[2], "Yigal Alon St 76, Tel Aviv-Yafo")
        self.assertEqual(args.kwargs.get("name"), "Space Gym Yigal Alon")

    def test_the_picked_place_really_resolves_for_the_activity_afterwards(self):
        # known_places keys a person by the digits of the key it is handed.
        uid = "u-0542900277"
        _post(PICK, line="אימון", uid=uid)
        hit = known_places.resolve(uid, "אימון")
        self.assertIsNotNone(hit)
        self.assertEqual(hit["address"], "Yigal Alon St 76, Tel Aviv-Yafo")
        self.assertEqual((hit["lat"], hit["lng"]), (32.0699, 34.7943))
        self.assertEqual(hit["name"], "Space Gym Yigal Alon")

    def test_a_known_place_that_cannot_be_stored_is_said_not_hidden(self):
        with patch.object(known_places, "remember", side_effect=OSError("disk full")):
            body = _post(PICK).json()
        self.assertTrue(body["ok"])                      # the answer itself was recorded
        self.assertEqual(body["applied"]["known_place"], "failed")
        self.assertEqual(len(questions_store.answers(UID, "place")), 1)

    def test_something_else_is_recorded_and_learns_no_place(self):
        with patch.object(known_places, "remember") as remember:
            body = _post({"choice": "edit", "query": "Space Gym"}).json()
        self.assertTrue(body["ok"])
        remember.assert_not_called()
        self.assertEqual(body["applied"], {})
        self.assertIn("במשימה", body["effect"]["he"])

    def test_bad_answers_are_400_with_the_reason(self):
        r = _post({"choice": "pick", "name": "Space", "address": "Somewhere", "lat": 0, "lng": 0, "query": "q"})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(r.json()["ok"])
        self.assertIn("0,0", r.json()["reason"])
        self.assertEqual(_post({"choice": "sometimes"}).status_code, 400)
        self.assertEqual(questions_store.answers(UID, "place"), [])

    def test_the_routine_kind_still_works(self):
        with _signed_in():
            r = client.post("/app/questions/answer", headers=AUTH, json={
                "kind": "routine_days", "subject": "יוגה|07:00", "line": "יוגה 07:00",
                "answer": {"choice": "days", "days": [0]}, "rewrite_told": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["ok"])

    def test_an_unknown_kind_is_still_refused(self):
        with _signed_in():
            r = client.post("/app/questions/answer", headers=AUTH, json={
                "kind": "weather", "subject": "x", "answer": {"choice": "pick"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("kind must be one of", r.json()["reason"])


if __name__ == "__main__":
    unittest.main()
