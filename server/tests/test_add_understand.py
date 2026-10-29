"""add_understand — Meira's conclusions while she types, and nothing she was not given.

Koral, 17.10: the Add screen thinks one step ahead ("dad's birthday party at
20:00" → a greeting drafted, a button to send it on WhatsApp, a gift reminder).
What must hold, with the model mocked at the TRANSPORT so the real ai_gate
runs (the allowance really counts, a refusal really is a 402):

  * a kind outside the whitelist never reaches the app, and the model never
    chooses what a button does;
  * today's allowance used up → {ok: false, reason: "ai_limit"} and NO model
    call; the gate's own refusal reads the same;
  * the model's JSON is garbage → "bad_output"; the model is down →
    "model_unavailable". Three different fixes, three different reasons;
  * the model cannot hand her a phone number, a link, an address, or a figure
    that was not in what she typed — and the contact's number never leaves the
    phone in the first place;
  * an interview and a sentence with no occasion cost no model call at all;
  * one add flow = one request against her day, however many times it asks.
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import openai

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import add_understand as au  # noqa: E402
import ai_gate  # noqa: E402
import llm_usage  # noqa: E402
import model_router  # noqa: E402
import user_quota  # noqa: E402

MEDIUM = model_router.MODELS["medium"]


def run(coro):
    return asyncio.run(coro)


BIRTHDAY = {
    "text": "dad's birthday party at 20:00",
    "lang": "en",
    "parsed": {"category": "leisure", "time": "20:00", "occasion": "birthday",
               "person": {"label": "Dad", "relation": "dad", "hasPhone": True}},
    "context": {"now": "2026-10-17 14:00 (Saturday)", "tomorrow": []},
}

GOOD_ANSWER = {
    "greeting": {"text_he": "יום הולדת שמח אבא! אוהבים אותך 🎂", "text_en": "Happy birthday Dad! Love you 🎂"},
    "conclusions": [
        {"kind": "reminder", "text_he": "🎁 לקנות מתנה", "text_en": "🎁 Buy a gift", "when": "day_before"},
    ],
}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        env = {"USER_LLM_EXEMPT": "owner", "USER_LLM_FREE_SEATS": "20", "USER_AI_DAILY_REQUESTS": "3",
               "TOKEN_FACTORY_BALANCE_USD": "", "TOKEN_FACTORY_BALANCE_DATE": "", "LLM_RESERVE_USD": "10"}
        self.patches = [
            mock.patch.object(user_quota, "_PATH", os.path.join(self.tmp.name, "people.json")),
            mock.patch.object(llm_usage, "_PATH", os.path.join(self.tmp.name, "usage.json")),
            mock.patch("database_service.shadow_write"),
            mock.patch("database_service.record_usage", new=mock.MagicMock()),
            mock.patch("identity_keys.canonical", side_effect=lambda k: str(k)),
            mock.patch.dict(os.environ, env),
            mock.patch.object(ai_gate, "_cache", (0.0, None)),
        ]
        for p in self.patches:
            p.start()
        self.tokens = (user_quota._current.set(None), user_quota._request.set(None))
        self.sent: list[dict] = []
        self.answer: object = GOOD_ANSWER
        self.status = 200

    def tearDown(self):
        user_quota._current.reset(self.tokens[0])
        user_quota._request.reset(self.tokens[1])
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def client(self):
        """A real SDK client behind the real gate; only the wire is faked."""
        def inner(request):
            self.sent.append(json.loads(request.content or b"{}"))
            if self.status != 200:
                return ai_gate._http.Response(self.status, json={"error": {"message": "boom"}})
            content = self.answer if isinstance(self.answer, str) else json.dumps(self.answer, ensure_ascii=False)
            return ai_gate._http.Response(200, json={
                "id": "x", "object": "chat.completion", "created": 0, "model": MEDIUM,
                "usage": {"prompt_tokens": 600, "completion_tokens": 120, "total_tokens": 720},
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": content}}]})
        return openai.AsyncOpenAI(api_key="k", base_url="https://example.invalid/v1", max_retries=0,
                                  http_client=ai_gate.http_client(ai_gate._http.MockTransport(inner)))

    def ask(self, body: dict, person: str = "dana", new_request: bool = True) -> dict:
        user_quota.set_person(person, new_request=new_request)
        with mock.patch.object(au.ai_gate, "client", self.client):
            return run(au.understand(body))


class Conclusions(Base):
    def test_a_birthday_gets_a_greeting_a_whatsapp_button_and_a_gift_reminder(self):
        out = self.ask(BIRTHDAY)
        self.assertTrue(out["ok"])
        self.assertTrue(out["model_used"])
        self.assertEqual([c["kind"] for c in out["conclusions"]], ["greeting", "whatsapp_send", "reminder"])
        self.assertEqual(out["greeting"]["to"], "Dad")
        self.assertIn("אבא", out["greeting"]["text_he"])
        self.assertIn("Dad", out["greeting"]["text_en"])
        reminder = out["conclusions"][2]
        self.assertEqual(reminder["action"], {"type": "add_reminder", "when": "day_before"})

    def test_the_greeting_is_addressed_to_the_apps_person_not_the_models(self):
        self.answer = {**GOOD_ANSWER, "greeting": {**GOOD_ANSWER["greeting"], "to": "Somebody Else"}}
        self.assertEqual(self.ask(BIRTHDAY)["greeting"]["to"], "Dad")

    def test_whatsapp_asks_for_a_contact_when_the_phone_has_no_number(self):
        body = json.loads(json.dumps(BIRTHDAY))
        body["parsed"]["person"]["hasPhone"] = False
        wa = [c for c in self.ask(body)["conclusions"] if c["kind"] == "whatsapp_send"][0]
        self.assertEqual(wa["action"], {"type": "open_whatsapp", "needs_contact": True})
        ok = [c for c in self.ask(BIRTHDAY, new_request=False)["conclusions"] if c["kind"] == "whatsapp_send"][0]
        self.assertEqual(ok["action"], {"type": "open_whatsapp", "needs_contact": False})

    def test_no_greeting_without_a_person(self):
        body = json.loads(json.dumps(BIRTHDAY))
        del body["parsed"]["person"]
        out = self.ask(body)
        self.assertNotIn("greeting", out)
        self.assertEqual([c["kind"] for c in out["conclusions"]], ["reminder"])


class Whitelist(Base):
    def test_a_kind_outside_the_list_never_reaches_the_app(self):
        self.answer = {"conclusions": [
            {"kind": "wire_money", "text_he": "העבר כסף", "text_en": "Wire money", "when": "morning_of"},
            {"kind": "interview", "text_he": "ראיון", "text_en": "Interview", "when": "morning_of"},
            {"kind": "greeting", "text_he": "ברכה", "text_en": "Greeting"},
            {"kind": "reminder", "text_he": "לקנות מתנה", "text_en": "Buy a gift", "when": "day_before"},
        ]}
        out = self.ask(BIRTHDAY)
        kinds = [c["kind"] for c in out["conclusions"]]
        self.assertEqual(kinds, ["reminder"])
        self.assertTrue(set(kinds) <= set(au.KINDS))

    def test_the_model_never_chooses_what_a_button_does(self):
        self.answer = {"conclusions": [
            {"kind": "reminder", "text_he": "לקנות מתנה", "text_en": "Buy a gift", "when": "day_before",
             "action": {"type": "open_whatsapp", "url": "https://evil.example"}}]}
        c = self.ask(BIRTHDAY)["conclusions"][0]
        self.assertEqual(c["action"], {"type": "add_reminder", "when": "day_before"})
        self.assertIn(c["action"]["type"], au.ACTION_TYPES)

    def test_a_reminder_with_a_clock_time_instead_of_a_when_is_dropped(self):
        self.answer = {"conclusions": [
            {"kind": "reminder", "text_he": "לקנות מתנה", "text_en": "Buy a gift", "when": "17:30"}]}
        self.assertEqual(self.ask(BIRTHDAY)["conclusions"], [])

    def test_at_most_four_and_one_greeting(self):
        self.answer = {**GOOD_ANSWER, "conclusions": [
            {"kind": "reminder", "text_he": f"תזכורת {i}", "text_en": f"Reminder {i}", "when": "morning_of"}
            for i in range(9)]}
        out = self.ask(BIRTHDAY)
        self.assertLessEqual(len(out["conclusions"]), au.MAX_CONCLUSIONS)
        self.assertEqual([c["kind"] for c in out["conclusions"]].count("greeting"), 1)


class NoInventedFacts(Base):
    def test_a_phone_number_from_the_model_is_dropped(self):
        self.answer = {"greeting": {"text_he": "התקשר 050-123-4567", "text_en": "Call 050-123-4567"},
                       "conclusions": [{"kind": "reminder", "text_he": "להתקשר 0501234567",
                                        "text_en": "Call 0501234567", "when": "morning_of"}]}
        out = self.ask(BIRTHDAY)
        self.assertEqual(out["conclusions"], [])
        self.assertNotIn("greeting", out)

    def test_an_address_a_link_and_an_email_are_dropped(self):
        for i, evil in enumerate(("Meet at 12 Herzl Street", "Book at www.table.example",
                                  "Mail dana@example.com", "https://maps.example/x",
                                  "פגישה ברחוב הרצל 12")):
            with self.subTest(evil=evil):
                self.answer = {"conclusions": [{"kind": "reminder", "text_he": evil, "text_en": evil,
                                                "when": "morning_of"}]}
                # A person each: the allowance here is 3 requests a day.
                self.assertEqual(self.ask(BIRTHDAY, person=f"evil{i}")["conclusions"], [])

    def test_a_figure_that_was_not_in_the_input_is_dropped(self):
        self.answer = {"conclusions": [
            {"kind": "reminder", "text_he": "לקנות מתנה עד 150", "text_en": "Buy a gift under 150", "when": "day_before"},
            {"kind": "reminder", "text_he": "להגיע ב-20:00", "text_en": "Be there at 20:00", "when": "one_hour_before"}]}
        out = self.ask(BIRTHDAY)
        self.assertEqual([c["text_en"] for c in out["conclusions"]], ["Be there at 20:00"])

    def test_an_age_in_the_greeting_is_dropped_with_the_greeting(self):
        self.answer = {**GOOD_ANSWER, "greeting": {"text_he": "מזל טוב ל-70!", "text_en": "Happy 70th!"}}
        out = self.ask(BIRTHDAY)
        self.assertNotIn("greeting", out)
        self.assertNotIn("greeting", [c["kind"] for c in out["conclusions"]])

    def test_the_contacts_number_never_reaches_the_model(self):
        body = json.loads(json.dumps(BIRTHDAY))
        body["parsed"]["person"]["phone"] = "0501112222"
        body["parsed"]["person"]["address"] = "5 Secret St"
        body["context"]["here_label"] = "Cafe X"
        self.ask(body)
        wire = json.dumps(self.sent, ensure_ascii=False)
        self.assertNotIn("0501112222", wire)
        self.assertNotIn("Secret", wire)

    def test_the_input_is_trimmed_before_it_goes_up(self):
        body = json.loads(json.dumps(BIRTHDAY))
        body["text"] = "dad's birthday " + "x" * 2000
        body["context"]["tomorrow"] = [{"text": f"task {i}", "time": "09:00", "place": ""} for i in range(30)]
        self.ask(body)
        user_msg = self.sent[0]["messages"][1]["content"]
        self.assertLess(len(user_msg), 1500)
        self.assertLessEqual(user_msg.count("\n- "), 8)


class EveryFailureHasAName(Base):
    def test_the_days_requests_used_up_is_ai_limit_and_no_call_is_made(self):
        for _ in range(3):
            self.assertTrue(self.ask(BIRTHDAY)["ok"])
        self.sent.clear()
        out = self.ask(BIRTHDAY)
        self.assertEqual(out["ok"], False)
        self.assertEqual(out["reason"], "ai_limit")
        self.assertEqual(self.sent, [], "a refused request must not reach the model")

    def test_the_gates_own_402_reads_as_ai_limit_not_as_a_dead_model(self):
        # State says "ok", the transport refuses (a balance stop mid-flight).
        with mock.patch.object(au.ai_gate, "refusal", return_value="balance"), \
             mock.patch.object(ai_gate, "refusal", return_value="balance"):
            out = self.ask(BIRTHDAY, person="noa")
        self.assertEqual(out, {"ok": False, "reason": "ai_limit"})

    def test_garbage_is_bad_output(self):
        for garbage in ("this is not json", "[1, 2, 3]", ""):
            with self.subTest(garbage=garbage):
                self.answer = garbage
                out = self.ask(BIRTHDAY, person=f"g{len(garbage)}")
                self.assertEqual(out, {"ok": False, "reason": "bad_output"})

    def test_a_dead_model_is_model_unavailable(self):
        self.status = 503
        self.assertEqual(self.ask(BIRTHDAY), {"ok": False, "reason": "model_unavailable"})

    def test_nothing_to_think_about_yet(self):
        self.assertEqual(self.ask({"text": "ab", "parsed": {}}), {"ok": False, "reason": "too_short"})

    def test_a_valid_answer_with_nothing_useful_is_ok_and_empty_not_an_error(self):
        self.answer = {"conclusions": []}
        out = self.ask(BIRTHDAY)
        self.assertEqual((out["ok"], out["conclusions"]), (True, []))


class CodeOnly(Base):
    def test_an_interview_is_answered_without_the_model(self):
        out = self.ask({"text": "interview Sunday 13:30 at Rafael David Institute, algorithm engineer",
                        "lang": "en", "parsed": {"category": "interview", "time": "13:30",
                                                 "place": "Rafael David Institute"}})
        self.assertTrue(out["ok"])
        self.assertFalse(out["model_used"])
        self.assertEqual(self.sent, [])
        self.assertEqual([c["kind"] for c in out["conclusions"]], ["interview", "prep"])
        self.assertIn("Prep brief", out["conclusions"][0]["text_en"])
        self.assertIn("הכנה", out["conclusions"][0]["text_he"])
        self.assertEqual(user_quota.requests_today("dana"), 0, "no model call, no request spent")

    def test_an_interview_with_a_person_is_still_code_only(self):
        out = self.ask({"text": "interview with Dana at Rafael", "lang": "en", "parsed": {
            "category": "interview", "person": {"label": "Dana", "hasPhone": False}}})
        self.assertFalse(out["model_used"])
        self.assertEqual(self.sent, [])

    def test_no_occasion_no_model(self):
        for parsed in ({"category": "meeting", "person": {"label": "Dana", "hasPhone": True}},
                       {"category": "call", "person": {"label": "Mom", "relation": "mom", "hasPhone": True}},
                       {"category": "gym", "time": "19:00"}):
            with self.subTest(parsed=parsed):
                out = self.ask({"text": "something at seven", "lang": "en", "parsed": parsed})
                self.assertEqual((out["ok"], out["model_used"], out["conclusions"]), (True, False, []))
        self.assertEqual(self.sent, [])

    def test_the_interview_chips_are_in_both_languages(self):
        for c in au._interview():
            self.assertTrue(c["text_he"] and c["text_en"])
            self.assertEqual(c["action"], {"type": "none"})


class Cost(Base):
    def test_one_add_flow_is_one_request_however_many_times_it_asks(self):
        # Two asks in one flow share a request when the caller keeps it; the
        # app's two calls are two HTTP requests, so each is its own — which is
        # exactly why the app asks at most twice.
        self.ask(BIRTHDAY)
        self.assertEqual(user_quota.requests_today("dana"), 1)
        self.ask(BIRTHDAY, new_request=False)
        self.assertEqual(user_quota.requests_today("dana"), 1)

    def test_the_call_is_priced_and_recorded_under_its_own_name(self):
        self.ask(BIRTHDAY)
        day = llm_usage._load()
        today = next(iter(day))
        self.assertEqual(day[today][au.SOURCE]["calls"], 1)
        self.assertGreater(user_quota.spent("dana")[0], 0)

    def test_it_runs_on_the_medium_tier(self):
        self.ask(BIRTHDAY)
        self.assertEqual(self.sent[0]["model"], MEDIUM)


class TheDoor(unittest.TestCase):
    """POST /app/add/understand over the real app: signed in, and not otherwise."""

    def test_route_is_registered_behind_the_same_caller_check(self):
        import tempfile as _t
        import config
        config.DATA_DIR = _t.mkdtemp(prefix="lumi-addu-")
        from fastapi.routing import APIRoute
        import main
        paths = {}
        def flat(routes):
            for r in routes:
                inner = getattr(r, "original_router", None)
                if inner is not None:
                    yield from flat(inner.routes)
                else:
                    yield r
        for r in flat(main.app.routes):
            if isinstance(r, APIRoute):
                paths[r.path] = r
        route = paths["/app/add/understand"]
        deps = [d.call.__name__ for d in route.dependant.dependencies]
        self.assertIn("require_caller", deps)

    def test_a_stranger_is_refused_and_a_signed_in_caller_is_answered(self):
        import tempfile as _t
        import config
        config.DATA_DIR = _t.mkdtemp(prefix="lumi-addu2-")
        from fastapi.testclient import TestClient
        import main
        import app_auth
        client = TestClient(main.app, raise_server_exceptions=False)
        self.assertEqual(client.post("/app/add/understand", json={}).status_code, 401)

        async def fake_verify(authorization):
            if not authorization:
                raise app_auth.AuthError("missing bearer token")
            return {"userId": "alice-uuid", "email": "a@example.com"}

        async def fake_phone(user_id):
            return "972500000001"

        with mock.patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone):
            r = client.post("/app/add/understand", headers={"Authorization": "Bearer t"},
                            json={"text": "interview Sunday 13:30 at Rafael", "lang": "en",
                                  "parsed": {"category": "interview"}})
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.json()["ok"])
            self.assertFalse(r.json()["model_used"])
            r2 = client.post("/app/add/understand", headers={"Authorization": "Bearer t"}, json=[1, 2])
            self.assertEqual(r2.status_code, 400)

    def test_errands_rules_only_spends_no_model_call_and_no_prices(self):
        """The suggestion row looks at her open errands every time the Add screen
        opens; that must not cost a request of her day (or a web search per place)."""
        import tempfile as _t
        import config
        config.DATA_DIR = _t.mkdtemp(prefix="lumi-addu3-")
        from fastapi.testclient import TestClient
        import main
        import app_auth
        import errands_along
        client = TestClient(main.app, raise_server_exceptions=False)

        async def fake_verify(authorization):
            return {"userId": "alice-uuid", "email": "a@example.com"}

        async def fake_phone(user_id):
            return "972500000001"

        trips = [{"polyline": "x", "leave": "17:30", "arrive": "17:50", "date": "2026-10-17"}]
        with mock.patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone), \
             mock.patch.object(errands_along, "_model_understand",
                               mock.AsyncMock(side_effect=AssertionError("no model call"))), \
             mock.patch.object(errands_along, "along", mock.AsyncMock(return_value={"ok": False, "reason": "x"})) as along:
            for text, errand in (("לתקן את מכונת הקפה", True), ("write the report", False)):
                along.reset_mock()
                r = client.post("/app/errands/along", headers={"Authorization": "Bearer t"},
                                json={"task": {"text": text}, "trips": trips, "rules_only": True})
                self.assertEqual(r.status_code, 200, r.text)
                kwargs = along.call_args.kwargs
                self.assertEqual(kwargs["plan"]["errand"], errand, text)
                self.assertIs(kwargs["prices"], False)


if __name__ == "__main__":
    unittest.main()
