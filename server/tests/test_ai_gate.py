"""ai_gate — no debt, and at most N AI requests a person a day.

7.10, Koral: "limit users to 10 LLM calls a day; never go below $0 in Token
Factory; I must not end up owing money." What must hold:
  * the 11th request of the day never reaches the model, and she is told why;
  * one request that makes several model calls counts ONCE;
  * free seats are unlimited in dollars, but still get 10 requests;
  * once our count of the prepaid balance reaches the reserve, NO call goes
    out — not the owner's either — and the refusal is a 402 the SDK does not retry;
  * every Nebius client in the server is built by ai_gate.client().
"""
import asyncio
import json
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

import openai

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import ai_gate  # noqa: E402
import llm_usage  # noqa: E402
import model_router  # noqa: E402
import user_quota  # noqa: E402
from tz import today_il  # noqa: E402

SERVER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIUM = model_router.MODELS["medium"]


class Base(unittest.TestCase):
    env = {}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        env = {"USER_LLM_EXEMPT": "owner", "USER_LLM_FREE_SEATS": "20",
               "USER_AI_DAILY_REQUESTS": "10", "TOKEN_FACTORY_BALANCE_USD": "",
               "TOKEN_FACTORY_BALANCE_DATE": "", "LLM_RESERVE_USD": "10", **self.env}
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

    def tearDown(self):
        user_quota._current.reset(self.tokens[0])
        user_quota._request.reset(self.tokens[1])
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()


class DailyRequests(Base):
    def request(self, person: str, calls: int = 1):
        user_quota.set_person(person, new_request=True)
        return [user_quota.admit() for _ in range(calls)]

    def test_the_eleventh_request_is_refused(self):
        for _ in range(10):
            self.assertEqual(self.request("dana"), [None])
        self.assertEqual(self.request("dana"), ["requests"])
        self.assertEqual(user_quota.requests_today("dana"), 10)

    def test_the_first_meeting_spends_none_of_her_day(self):
        # 8.10: her 15 were used up and the first meeting stopped mid-way.
        for _ in range(10):
            self.request("dana")
        user_quota.set_person("dana", new_request=True)
        user_quota.free_request()
        self.assertEqual([user_quota.admit() for _ in range(3)], [None, None, None])
        self.assertEqual(user_quota.requests_today("dana"), 10)
        self.assertEqual(self.request("dana"), ["requests"])   # the chat is still capped

    def test_several_model_calls_in_one_request_count_once(self):
        self.assertEqual(self.request("dana", calls=6), [None] * 6)
        self.assertEqual(user_quota.requests_today("dana"), 1)

    def test_inner_set_person_for_the_same_person_keeps_the_request(self):
        user_quota.set_person("dana", new_request=True)
        user_quota.admit()
        user_quota.set_person("dana")          # run_turn → handle_whatsapp_message
        user_quota.admit()
        self.assertEqual(user_quota.requests_today("dana"), 1)

    def test_a_free_seat_still_gets_ten(self):
        for _ in range(10):
            self.request("dana")
        self.assertTrue(user_quota._seated("dana"))
        user_quota.set_person("dana", new_request=True)
        self.assertEqual(user_quota.state()["period"], "requests")

    def test_she_is_told_in_her_language(self):
        for _ in range(10):
            self.request("dana")
        user_quota.set_person("dana", new_request=True)
        he = user_quota.blocked_reply("dana", "מה יש לי מחר?")
        self.assertIn("10", he)
        self.assertIn("מחר", he)
        self.assertIn("Back tomorrow", user_quota.blocked_reply("dana", "what's tomorrow?"))

    def test_the_request_that_is_running_is_not_blocked_by_its_own_count(self):
        for _ in range(9):
            self.request("dana")
        self.request("dana")                   # the 10th, still running
        self.assertEqual(user_quota.state()["level"], "ok")

    def test_others_are_untouched_and_the_owner_is_exempt(self):
        for _ in range(11):
            self.request("dana")
        self.assertEqual(self.request("noa"), [None])
        for _ in range(15):
            self.assertEqual(self.request("owner"), [None])

    def test_no_person_no_count(self):
        self.assertIsNone(user_quota.admit())


class Balance(Base):
    env = {"TOKEN_FACTORY_BALANCE_USD": "20", "LLM_RESERVE_USD": "10"}

    def setUp(self):
        super().setUp()
        os.environ["TOKEN_FACTORY_BALANCE_DATE"] = today_il().isoformat()

    def spend(self, usd: float, model: str = MEDIUM):
        llm_usage.record("chat", int(usd / 0.30 * 1_000_000), 0, model)

    def test_open_while_above_the_reserve(self):
        self.spend(5)
        b = ai_gate.balance(fresh=True)
        self.assertFalse(b["closed"])
        self.assertAlmostEqual(b["remaining_usd"], 15, places=2)

    def test_closed_at_the_reserve_for_everyone(self):
        self.spend(10.5)
        self.assertEqual(ai_gate.refusal(), "balance")
        user_quota.set_person("owner", new_request=True)
        self.assertEqual(user_quota.state()["period"], "balance")
        self.assertIn("מושהה", user_quota.blocked_reply("owner", "שלום"))

    def test_spend_before_the_balance_date_does_not_count(self):
        data = {"2020-01-01": {"chat": {"in": 10**9, "out": 0, "calls": 1}}}
        llm_usage._save(data)
        self.assertFalse(ai_gate.balance(fresh=True)["closed"])

    def test_an_unknown_model_is_priced_at_the_dearest(self):
        llm_usage.record("chat", 3_000_000, 0, "someone/new-model")   # $3 at $1/M
        self.assertAlmostEqual(ai_gate.balance(fresh=True)["spent_usd"], 3.0, places=2)

    def test_not_configured_means_no_balance_stop(self):
        os.environ["TOKEN_FACTORY_BALANCE_USD"] = ""
        self.assertFalse(ai_gate.balance(fresh=True)["closed"])

    def test_a_refused_call_never_leaves_and_is_not_retried(self):
        self.spend(11)
        sent = []

        def inner(request):
            sent.append(request)
            return ai_gate._http.Response(200, json={})

        client = openai.AsyncOpenAI(
            api_key="k", base_url="https://example.invalid/v1",
            http_client=ai_gate.http_client(ai_gate._http.MockTransport(inner)))
        with self.assertRaises(openai.APIStatusError) as ctx:
            asyncio.run(client.chat.completions.create(model=MEDIUM, messages=[]))
        self.assertEqual(ctx.exception.status_code, 402)
        self.assertEqual(sent, [])

    def test_an_allowed_call_comes_back_with_its_answer(self):
        # 8.10: only the refusal was ever tested, through a plain-httpx client.
        # The production client is the SDK's httpx2 one, which rejected the
        # guard's every answer — all model calls failed, every one of them.
        def inner(request):
            return ai_gate._http.Response(200, json={
                "id": "x", "object": "chat.completion", "created": 0, "model": MEDIUM,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "חוף עליה"}}]})

        client = openai.AsyncOpenAI(
            api_key="k", base_url="https://example.invalid/v1",
            http_client=ai_gate.http_client(ai_gate._http.MockTransport(inner)))
        out = asyncio.run(client.chat.completions.create(model=MEDIUM, messages=[]))
        self.assertEqual(out.choices[0].message.content, "חוף עליה")


class Thinking(unittest.TestCase):
    """19.10: Nemotron 3 thinks before every answer unless told not to — seconds
    per call nobody read, and replies cut off at max_tokens."""

    def setUp(self):
        os.environ.pop("LLM_THINKING", None)
        os.environ["TOKEN_FACTORY_BALANCE_USD"] = ""

    def _sent_body(self, **kw):
        sent = []

        def inner(request):
            sent.append(json.loads(request.read()))
            return ai_gate._http.Response(200, json={
                "id": "x", "object": "chat.completion", "created": 0, "model": MEDIUM,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "ok"}}]})

        client = openai.AsyncOpenAI(
            api_key="k", base_url="https://example.invalid/v1",
            http_client=ai_gate.http_client(ai_gate._http.MockTransport(inner)))
        asyncio.run(client.chat.completions.create(model=MEDIUM, messages=[], **kw))
        return sent[0]

    def test_every_chat_call_goes_out_with_thinking_off(self):
        body = self._sent_body()
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(body["model"], MEDIUM)   # the rest of the request intact

    def test_a_caller_that_chose_keeps_its_choice(self):
        body = self._sent_body(extra_body={"chat_template_kwargs": {"enable_thinking": True}})
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": True})

    def test_the_switch_brings_thinking_back(self):
        os.environ["LLM_THINKING"] = "on"
        try:
            self.assertNotIn("chat_template_kwargs", self._sent_body())
        finally:
            os.environ.pop("LLM_THINKING", None)

    def test_the_client_has_a_bounded_wait(self):
        c = ai_gate.client(api_key="k", base_url="https://example.invalid/v1")
        self.assertLessEqual(float(c.timeout), 30.0)
        self.assertLessEqual(c.max_retries, 1)


class Prices(unittest.TestCase):
    def test_nano_is_priced_whatever_the_case(self):
        self.assertEqual(llm_usage.price_of("nvidia/Nemotron-3-Nano-30B-A3B"), (0.06, 0.24))


class EveryClientGoesThroughTheGate(unittest.TestCase):
    def test_no_other_asyncopenai_construction(self):
        offenders = []
        for name in os.listdir(SERVER):
            if not name.endswith(".py") or name == "ai_gate.py":
                continue
            with open(os.path.join(SERVER, name), encoding="utf-8") as f:
                if re.search(r"\bAsyncOpenAI\(|\bOpenAI\(", f.read()):
                    offenders.append(name)
        self.assertEqual(offenders, [], "build Nebius clients with ai_gate.client()")


if __name__ == "__main__":
    unittest.main()
