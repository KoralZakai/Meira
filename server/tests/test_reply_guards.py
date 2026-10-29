"""The anti-fabrication guards, run against the code that ships.

Found by the evaluation harness (server/evals, `python -m evals --offline`):

  1. A tool that RAISED reached the guard as the bare text "Error: …". That is
     not JSON, and "unparseable counts as success" made a crashed save look
     like a save: "✓ נשמר" went out for something never written.
  2. The save-claim guard looked only at lines containing "✓". "הוספתי ליומן 👍",
     "Saved!" and a bare "נשמר" walked straight through.
  3. A failed plan_departure ({"ok": false}) still licensed a reply line like
     "🚌 קו 251 · לצאת ב-08:40": the route guard asked whether a route tool RAN.
  4. react_loop had no per-tool timeout: one hung tool held the whole turn.

Each has its test here; the end-to-end versions are the eval cases
`tool/raises-forever-*`, `lie/no-tool-confirms-without-tick-*`,
`api/google-REQUEST_DENIED-model-asserts-a-route` and `tool/web-search-hangs`
(see test_reliability_cases_that_found_these_are_now_honest below).
"""
import asyncio
import json
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lumi_agent  # noqa: E402
import react_loop  # noqa: E402
from react_loop import ToolMessage, create_react_agent, tool  # noqa: E402


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def tm(name, content, status="success"):
    return ToolMessage(content=content if isinstance(content, str) else json.dumps(content),
                       name=name, tool_call_id="c1", status=status)


OK_SAVE = tm("infer_task_details", {"text": "פגישה עם דני", "date": "2026-10-16"})
FAILED_SAVE = tm("infer_task_details", {"ok": False, "error": "boom"})


# ── a minimal scripted model (same shape as test_react_loop's) ──────────────

class _Fn:
    def __init__(self, name, arguments):
        self.name, self.arguments = name, arguments


class _Call:
    def __init__(self, call_id, name, arguments):
        self.id, self.function = call_id, _Fn(name, arguments)


class _Choice:
    def __init__(self, content, tool_calls):
        self.message = self
        self.content, self.tool_calls = content, tool_calls


class _Response:
    def __init__(self, content="", tool_calls=None):
        self.choices = [_Choice(content, tool_calls)]
        self.usage = None


class FakeLLM:
    def __init__(self, script):
        self.script = list(script)
        self.seen = []

    async def complete(self, messages, tools):
        self.seen.append(list(messages))
        return self.script.pop(0)


def _agent_turn(tool_obj, final_text):
    """One turn: the model calls `tool_obj`, then says `final_text`."""
    llm = FakeLLM([_Response(tool_calls=[_Call("c1", tool_obj.name, "{}")]),
                   _Response(content=final_text)])
    return llm, run(create_react_agent(llm, [tool_obj]).ainvoke(
        {"messages": [{"role": "user", "content": "hi"}]}))


# ── 1. a raised tool is a FAILED tool ───────────────────────────────────────

class RaisedToolIsAFailure(unittest.TestCase):
    def _boom(self):
        @tool
        async def infer_task_details() -> dict:
            """d"""
            raise RuntimeError("supabase is down")
        return infer_task_details

    def test_a_raise_reaches_the_loop_result_as_structured_failure(self):
        llm, out = _agent_turn(self._boom(), "ok")
        msg = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        data = json.loads(msg.content)            # JSON, not "Error: …"
        self.assertIs(data["ok"], False)
        self.assertIn("supabase is down", data["error"])
        self.assertEqual(msg.status, "error")

    def test_the_guard_reads_it_as_failed(self):
        _, out = _agent_turn(self._boom(), "ok")
        msg = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertFalse(lumi_agent.tool_succeeded(msg))

    def test_the_model_is_shown_the_failure_to_answer_from(self):
        llm, _ = _agent_turn(self._boom(), "ok")
        sent_back = llm.seen[1][-1]
        self.assertEqual(sent_back["role"], "tool")
        self.assertIn("supabase is down", sent_back["content"])

    def test_bad_arguments_and_unknown_tools_are_structured_failures_too(self):
        @tool
        async def echo(value: str) -> dict:
            """d"""
            return {"ok": True}
        llm = FakeLLM([_Response(tool_calls=[_Call("c1", "echo", "{not json"),
                                             _Call("c2", "no_such_tool", "{}")]),
                       _Response(content="ok")])
        out = run(create_react_agent(llm, [echo]).ainvoke(
            {"messages": [{"role": "user", "content": "hi"}]}))
        msgs = [m for m in out["messages"] if isinstance(m, ToolMessage)]
        self.assertEqual(len(msgs), 2)
        for m in msgs:
            self.assertIs(json.loads(m.content)["ok"], False, m.content)
            self.assertFalse(lumi_agent.tool_succeeded(m), m.content)

    def test_error_text_a_tool_returns_itself_is_a_failure_too(self):
        self.assertFalse(lumi_agent.tool_succeeded(tm("save_profile", "Error: could not parse the time")))

    def test_status_error_alone_is_a_failure(self):
        self.assertFalse(lumi_agent.tool_succeeded(tm("save_profile", "whatever", status="error")))

    def test_shapeless_results_are_still_never_punished(self):
        self.assertTrue(lumi_agent.tool_succeeded(tm("set_reminder", "not json at all")))
        self.assertTrue(lumi_agent.tool_succeeded(tm("list_reminders", [{"time": "09:00"}])))
        self.assertTrue(lumi_agent.tool_succeeded(OK_SAVE))

    def test_the_fake_tick_after_a_crash_is_stripped(self):
        _, out = _agent_turn(self._boom(), "✓ נשמר: פגישה עם דני מחר ב-14:00")
        text = lumi_agent.strip_unbacked_save_claims(
            "✓ נשמר: פגישה עם דני מחר ב-14:00", out["messages"], True)
        self.assertNotIn("נשמר:", text)
        self.assertIn("לא נשמר", text)


# ── 2. a claim needs no tick ────────────────────────────────────────────────

LIES = [
    ("הוספתי את הפגישה עם דני ליומן שלך 👍", True),
    ("הוספתי את הפגישה עם דני ליומן 👍", True),
    ("עדכנתי את השעה ל-16:00", True),
    ("שמרתי לך את זה", True),
    ("אין בעיה, הוספתי את זה", True),        # "אין" belongs to another clause
    ("נשמר", True),
    ("הפגישה נשמרה ליום חמישי", True),
    ("התזכורת נוצרה", True),
    ("מעולה! נוספה פגישה ליומן", True),
    ("Saved! See you tomorrow at 10.", False),
    ("Scheduled! See you then", False),
    ("Added to your calendar", False),
    ("Done. I've added it for Thursday", False),
    ("I added the meeting with Dana", False),
    ("Your meeting has been scheduled for 10:00", False),
    ("Reminder set for 18:00", False),
    ("Meeting saved to your calendar 👍", False),
    ("✓ Updated", False),
    ("✓ עודכן: שיחה עם יניר", True),
]

NOT_LIES = [
    # ordinary prose that shares letters or words with the claim vocabulary
    "מה תרצי לעשות מחר?",
    "Here is your day",
    "🚌 38 · 15 min",
    "יש משהו נוסף שאפשר לעזור בו?",           # נוסף = "additional"
    "בנוסף, יש לך פגישה נוספת ב-16:00",
    "הפגישה שנוספה אתמול כבר עברה",           # relative clause about the past
    "יש לך 3 משימות מתוזמנות להיום",
    "You have 3 meetings scheduled today",
    "Your meeting is scheduled for 10:00",
    "Saved places near you:",
    "Scheduled for today:",
    "Prices are updated daily",
    "נוסף על כך, יש לך פגישה ב-16:00",
    "המידע עודכן לאחרונה ב-2024",
    "This was last updated yesterday",
    # denials, including the guards' own notes
    "המשימה לא נשמרה",
    "⚠️ לא נשמר — נסי שוב",
    "⚠️ Not saved — try again",
    "⚠️ לא שמרתי כלום עכשיו — אם ביקשת להוסיף, נסי שוב",
    "⚠️ Nothing was saved just now — if you asked to add something, try again",
    "⚠️ Nothing was actually saved yet — please rephrase",
    "I couldn't get it saved",
    "לא הצלחתי לשמור, כלום לא נשמר",
    "✓ הבנתי. לא נשמר כלום",
]


class ClaimWithoutATick(unittest.TestCase):
    def test_each_lie_is_a_claim(self):
        for text, _he in LIES:
            self.assertTrue(lumi_agent.is_save_claim(text), text)

    def test_ordinary_prose_and_denials_are_not(self):
        for text in NOT_LIES:
            self.assertFalse(lumi_agent.is_save_claim(text), text)

    def test_with_no_action_the_claim_line_is_replaced_by_one_honest_line(self):
        for text, he in LIES:
            out = lumi_agent.strip_unbacked_save_claims(text, [], he)
            self.assertFalse(lumi_agent.is_save_claim(out), (text, out))
            self.assertIn("לא שמרתי כלום עכשיו" if he else "Nothing was saved just now", out)

    def test_the_honest_line_follows_the_users_language(self):
        he = lumi_agent.strip_unbacked_save_claims("נשמר", [], True)
        en = lumi_agent.strip_unbacked_save_claims("Saved!", [], False)
        self.assertEqual(he, lumi_agent._NOTHING_NOW[True])
        self.assertEqual(en, lumi_agent._NOTHING_NOW[False])

    def test_other_lines_of_the_reply_are_kept_and_the_note_takes_the_claims_place(self):
        out = lumi_agent.strip_unbacked_save_claims(
            "שלום דנה\nהוספתי את הפגישה ליומן 👍\nבהצלחה!", [], True)
        self.assertEqual(out.split("\n"), ["שלום דנה", lumi_agent._NOTHING_NOW[True], "בהצלחה!"])

    def test_two_claim_lines_leave_one_note(self):
        out = lumi_agent.strip_unbacked_save_claims("✓ נשמר: א\nהוספתי גם ב", [], True)
        self.assertEqual(out, lumi_agent._NOTHING_NOW[True])

    def test_a_real_save_leaves_the_reply_alone(self):
        for text, he in LIES:
            self.assertEqual(lumi_agent.strip_unbacked_save_claims(text, [OK_SAVE], he), text)

    def test_a_failed_save_does_not_license_the_claim(self):
        self.assertIn("לא נשמר", lumi_agent.strip_unbacked_save_claims(
            "הוספתי את הפגישה ליומן", [FAILED_SAVE], True))
        raised = tm("set_reminder", "Error: nope", status="error")
        self.assertIn("Not saved", lumi_agent.strip_unbacked_save_claims("Saved!", [raised], False))

    def test_a_read_tool_is_not_an_action(self):
        read = tm("get_my_tasks", {"ok": True, "tasks": []})
        self.assertIn("לא שמרתי כלום עכשיו", lumi_agent.strip_unbacked_save_claims(
            "הוספתי את זה ליומן", [read], True))

    def test_ordinary_replies_pass_through_untouched(self):
        for text in NOT_LIES:
            self.assertEqual(lumi_agent.strip_unbacked_save_claims(text, [], True), text)

    def test_the_guards_own_note_survives_a_second_pass(self):
        once = lumi_agent.strip_unbacked_save_claims("נשמר", [], True)
        self.assertEqual(lumi_agent.strip_unbacked_save_claims(once, [], True), once)


# ── 3. a failed route tool licenses no route line ───────────────────────────

ROUTE_REPLY = "✓ נשמר.\n🚌 קו 251 · לצאת ב-08:40"
PLAN_DENIED = tm("plan_departure", {"ok": False, "error": "Google Directions refused the request"})
PLAN_OK = tm("plan_departure", {"ok": True, "plan": {"leaveHomeAt": "08:40"}})


class FailedRouteLicensesNoRouteLine(unittest.TestCase):
    def test_route_line_after_a_failed_plan_is_stripped_and_says_why(self):
        out = lumi_agent.strip_unbacked_route_lines(ROUTE_REPLY, [OK_SAVE, PLAN_DENIED], True)
        self.assertNotIn("🚌", out)
        self.assertNotIn("08:40", out)
        self.assertIn("✓ נשמר.", out)
        self.assertIn("לא הצלחתי לחשב מסלול", out)
        self.assertNotIn("רוצה שאחשב", out, "it just tried; do not offer to try")

    def test_english(self):
        out = lumi_agent.strip_unbacked_route_lines(
            "Saved.\nLeave at 08:40 🚌", [PLAN_DENIED], False)
        self.assertNotIn("08:40", out)
        self.assertIn("couldn't work out the route", out)

    def test_a_raised_plan_is_a_failed_plan(self):
        raised = tm("plan_departure", "Error: boom", status="error")
        out = lumi_agent.strip_unbacked_route_lines(ROUTE_REPLY, [raised], True)
        self.assertNotIn("08:40", out)

    def test_another_route_tool_that_worked_keeps_the_line(self):
        lookup = tm("route_now", {"ok": True, "answer": {}})
        self.assertEqual(lumi_agent.strip_unbacked_route_lines(
            ROUTE_REPLY, [PLAN_DENIED, lookup], True), ROUTE_REPLY)

    def test_a_working_plan_keeps_the_line(self):
        self.assertEqual(lumi_agent.strip_unbacked_route_lines(
            ROUTE_REPLY, [PLAN_OK], True), ROUTE_REPLY)

    def test_an_honest_reply_after_a_failed_plan_is_not_doubled(self):
        honest = "✓ נשמר. לא הצלחתי לחשב מסלול כרגע 🙏"
        self.assertEqual(lumi_agent.strip_unbacked_route_lines(honest, [PLAN_DENIED], True), honest)
        # …but a transit emoji beside the honest sentence goes, and is not repeated.
        out = lumi_agent.strip_unbacked_route_lines(
            "לא הצלחתי לחשב מסלול 🚌\nלצאת ב-08:40", [PLAN_DENIED], True)
        self.assertEqual(out.count("לא הצלחתי לחשב מסלול"), 1)
        self.assertNotIn("08:40", out)

    def test_with_no_route_tool_at_all_the_old_offer_stands(self):
        out = lumi_agent.strip_unbacked_route_lines("🚌 קו 251 · לצאת ב-08:10", [], True)
        self.assertIn("רוצה שאחשב מסלול מדויק", out)
        self.assertNotIn("08:10", out)


# ── 4. a hung tool cannot hold the turn ─────────────────────────────────────

class PerToolTimeout(unittest.TestCase):
    def _hanging(self, name="web_search"):
        async def impl() -> dict:
            """d"""
            await asyncio.sleep(30)
            return {"ok": True}
        impl.__name__ = name
        return tool(impl)

    def test_a_hung_tool_returns_a_structured_timeout(self):
        t0 = time.monotonic()
        with mock.patch.object(react_loop, "TOOL_TIMEOUT_S", 0.05):
            llm, out = _agent_turn(self._hanging(), "לא הצלחתי לבדוק את זה עכשיו")
        msg = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        data = json.loads(msg.content)
        self.assertIs(data["ok"], False)
        self.assertIn("timeout", data["error"])
        self.assertIn("web_search", data["error"])
        self.assertEqual(msg.status, "error")
        self.assertFalse(lumi_agent.tool_succeeded(msg))
        # …and the model WAS shown it, so it can answer honestly.
        self.assertIn("timeout", llm.seen[1][-1]["content"])
        self.assertEqual(out["messages"][-1].content, "לא הצלחתי לבדוק את זה עכשיו")
        self.assertLess(time.monotonic() - t0, 5, "the turn must not wait for the hung tool")

    def test_the_timeout_is_logged_with_the_tools_name(self):
        with mock.patch.object(react_loop, "TOOL_TIMEOUT_S", 0.05):
            with self.assertLogs("react_loop", level="WARNING") as logs:
                _agent_turn(self._hanging("find_place"), "ok")
        self.assertTrue(any("find_place" in line and "timed out" in line for line in logs.output),
                        logs.output)

    def test_the_default_is_twenty_seconds_and_routes_get_longer(self):
        self.assertEqual(react_loop.TOOL_TIMEOUT_S, 20.0)
        self.assertGreater(react_loop.TOOL_TIMEOUT_OVERRIDES["plan_departure"], 20.0)

    def test_a_per_tool_override_beats_the_default(self):
        with mock.patch.object(react_loop, "TOOL_TIMEOUT_S", 0.02), \
                mock.patch.dict(react_loop.TOOL_TIMEOUT_OVERRIDES, {"slow_but_fine": 5.0}):
            @tool
            async def slow_but_fine() -> dict:
                """d"""
                await asyncio.sleep(0.15)
                return {"ok": True, "value": 1}
            _, out = _agent_turn(slow_but_fine, "done")
        msg = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(json.loads(msg.content), {"ok": True, "value": 1})

    def test_a_fast_tool_is_untouched(self):
        @tool
        async def echo() -> dict:
            """d"""
            return {"ok": True, "value": "x"}
        _, out = _agent_turn(echo, "done")
        msg = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        self.assertEqual(msg.status, "success")
        self.assertEqual(json.loads(msg.content), {"ok": True, "value": "x"})

    def test_a_timeout_the_tool_raised_itself_is_a_failure_not_our_ceiling(self):
        @tool
        async def flaky() -> dict:
            """d"""
            raise TimeoutError("socket read timed out")
        _, out = _agent_turn(flaky, "ok")
        msg = [m for m in out["messages"] if isinstance(m, ToolMessage)][0]
        data = json.loads(msg.content)
        self.assertIs(data["ok"], False)
        self.assertNotIn("did not answer within", data["error"])
        self.assertIn("socket read timed out", data["error"])

    def test_env_override_is_parsed_and_junk_is_ignored(self):
        with mock.patch.dict(os.environ, {"LUMI_TOOL_TIMEOUT_S": "7.5"}):
            self.assertEqual(react_loop._env_seconds("LUMI_TOOL_TIMEOUT_S", 20.0), 7.5)
        with mock.patch.dict(os.environ, {"LUMI_TOOL_TIMEOUT_S": "soon"}):
            self.assertEqual(react_loop._env_seconds("LUMI_TOOL_TIMEOUT_S", 20.0), 20.0)
        with mock.patch.dict(os.environ, {"LUMI_TOOL_TIMEOUT_S": "-3"}):
            self.assertEqual(react_loop._env_seconds("LUMI_TOOL_TIMEOUT_S", 20.0), 20.0)

    def test_parallel_calls_one_hung_one_fine(self):
        @tool
        async def fine() -> dict:
            """d"""
            return {"ok": True}
        hung = self._hanging("slow_one")
        llm = FakeLLM([_Response(tool_calls=[_Call("c1", "fine", "{}"), _Call("c2", "slow_one", "{}")]),
                       _Response(content="ok")])
        with mock.patch.object(react_loop, "TOOL_TIMEOUT_S", 0.05):
            out = run(create_react_agent(llm, [fine, hung]).ainvoke(
                {"messages": [{"role": "user", "content": "hi"}]}))
        by = {m.name: m for m in out["messages"] if isinstance(m, ToolMessage)}
        self.assertTrue(lumi_agent.tool_succeeded(by["fine"]))
        self.assertFalse(lumi_agent.tool_succeeded(by["slow_one"]))


# ── the eval cases that found all of this ───────────────────────────────────

class TheEvalCasesNowPass(unittest.TestCase):
    def test_reliability_cases_that_found_these_are_now_honest(self):
        from evals import reliability as rel
        r = rel.run(only=[
            "tool/raises-forever-model-confirms-with-tick",
            "tool/raises-forever-model-confirms-WITHOUT-tick",
            "tool/web-search-hangs",
            "api/google-REQUEST_DENIED-model-asserts-a-route",
            "lie/no-tool-confirms-without-tick-he",
            "lie/no-tool-confirms-without-tick-en",
        ])
        cases = {c["name"]: c for c in r["details"]["cases"]}
        self.assertEqual(len(cases), 6)
        for name, case in cases.items():
            self.assertTrue(case["ok"], f"{name}: {case['class']} - {case['why']}")
            self.assertNotEqual(case["class"], rel.HALLU, name)
            self.assertNotEqual(case["class"], rel.TIMEOUT, name)
        metrics = {m["id"]: m for m in r["metrics"]}
        self.assertEqual(metrics["reliability.hallucination_rate"]["value"], 0.0)
        self.assertEqual(metrics["reliability.timeout_rate"]["value"], 0.0)


if __name__ == "__main__":
    unittest.main()


class AskedAboutAnEarlierSave(unittest.TestCase):
    """'Did you save it?' → 'כן, נשמר' about YESTERDAY's real save: with no
    action this turn, the guard must not say 'not saved' (that would be false
    too) — it says nothing was saved NOW (15.10, review of the guard change)."""

    def test_no_attempt_says_nothing_now_not_not_saved(self):
        out = lumi_agent.strip_unbacked_save_claims("כן, נשמר", [], True)
        self.assertEqual(out, lumi_agent._NOTHING_NOW[True])
        self.assertNotIn("לא נשמר —", out)
