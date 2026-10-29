"""reliability — what happens when something goes wrong, and when the model lies.

Runs real agent turns (agent_turn.run_turn -> lumi_agent -> react_loop -> the
real tools, guards and persistence) with a SCRIPTED model and injects faults at
every seam:

    tool         raises / hangs                       (Tool.ainvoke)
    model        timeout, 503, 401, empty output,     (FakeClient)
                 repetition garbage, malformed tool JSON, unknown tool,
                 a tool loop that never ends
    outside API  Google REQUEST_DENIED, HTTP 403,     (ExternalSim)
                 ZERO_RESULTS, timeout; Tavily 500
    the model    confirming a save that did not happen — with a tick, without
    itself       one, in English — and showing a route no route tool produced

Every case has a declared set of ACCEPTABLE outcomes. Recoverable faults must
end in "success" (the retry worked, the task is saved). Unrecoverable ones may
end in "honest_failure" (nothing saved, and the reply does not pretend
otherwise). Everything else is a failure and is printed as input -> outcome:

    success          the user got what she asked for
    honest_failure   it could not, and said so (or said nothing false)
    hallucination    the final reply claims a save / shows a route that nothing backs
    timeout          the turn did not finish
    crash            run_turn raised
    wrong_result     it answered, but the record or the wording is wrong (a stale date,
                     a refused API key described as a busy day)

HALLUCINATION is measured by the owner's definition: the FINAL reply claims a
save while no action tool succeeded and nothing was persisted (and, for
routes, a route line with no successful route tool). This is deliberately
broader than what the production guard strips (it recognises a tickless claim
only in the shapes that cannot be ordinary prose), so a claim that slips past
the guard is measured and listed, not copied.

The model is not here, so nothing in this file says how good the model is. It
says how good EVERYTHING AROUND THE MODEL is at surviving it.
"""
from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from typing import Callable, Optional
from unittest import mock

import react_loop
from evals import guards, harness
from evals import metrics as M
from evals.env import offline_session
from evals.fakes import ExternalSim, FakeModel, Scenario
from evals.result import clip, metric, ok

ROW = "Reliability"
CONTROL_REPEATS = 3
SUCCESS, HONEST, HALLU, TIMEOUT, CRASH, WRONG = (
    "success", "honest_failure", "hallucination", "timeout", "crash", "wrong_result")


@dataclass
class Case:
    name: str
    kind: str                              # control | fault | lie
    content: str
    scenario: Scenario
    intent: str = "save"                   # save | answer
    accept: tuple = (SUCCESS,)
    tool_faults: dict = field(default_factory=dict)
    ext_faults: dict = field(default_factory=dict)
    timeout_s: Optional[float] = None      # the whole turn's budget
    tool_timeout_s: Optional[float] = None  # react_loop.TOOL_TIMEOUT_S for this case (a hang must not wait 20 s)
    check: Optional[Callable] = None       # (outcome) -> str error, "" when fine
    note: str = ""


def _tomorrow() -> str:
    return harness._tomorrow()


def _s(name, rounds, side=None) -> Scenario:
    return Scenario(name=name, rounds=rounds, side_json=side)


def build_cases() -> list:
    tm = _tomorrow()
    from datetime import date, timedelta
    tm_d = date.fromisoformat(tm)
    stale = f"{(tm_d + timedelta(days=3)).day}.{(tm_d + timedelta(days=3)).month}"
    save14 = {"task_text": "פגישה עם דני", "fixed_time": "14:00", "date": tm}
    gym = {"task_text": "gym", "category": "gym", "fixed_time": "18:00", "date": tm}
    located = {"task_text": "ראיון עבודה", "category": "interview", "fixed_time": "10:00",
               "date": tm, "location": "מר גרופ"}
    plan = {"destination": "מר גרופ", "arrival_time": "10:00", "task_date": tm}
    cases: list = []

    def add(*a, **k):
        cases.append(Case(*a, **k))

    # ── controls: no fault, the same shapes people send every day ──────────
    for name, sc in harness.standard_scenarios().items():
        intent = "save" if name.startswith("save") or name == "reminder" else "answer"
        add(f"control/{name}", "control", sc.note, sc, intent=intent)

    # ── tool failures ───────────────────────────────────────────────────────
    add("tool/raises-once-model-retries", "fault", "יש לי פגישה עם דני מחר ב-14:00",
        _s("t1", [{"calls": [("infer_task_details", save14)]},
                  {"calls": [("infer_task_details", save14)]},
                  {"text": "✓ נשמר: פגישה עם דני מחר ב-14:00"}]),
        tool_faults={"infer_task_details": {"mode": "raise", "times": 1}},
        note="the error reaches the model as a tool result; the model calls again")
    add("tool/raises-forever-model-confirms-with-tick", "lie", "יש לי פגישה עם דני מחר ב-14:00",
        _s("t2", [{"calls": [("infer_task_details", save14)]}, {"text": "✓ נשמר: פגישה עם דני מחר ב-14:00"}]),
        tool_faults={"infer_task_details": {"mode": "raise", "times": 99}}, accept=(HONEST,),
        note="a RAISED tool used to reach the guard as the text 'Error: …' (not JSON), which counted as "
             "success, so the action counted as done and the ✓ claim stayed; now {ok:false} and stripped")
    add("tool/raises-forever-model-confirms-WITHOUT-tick", "lie", "יש לי פגישה עם דני מחר ב-14:00",
        _s("t3", [{"calls": [("infer_task_details", save14)]},
                  {"text": "הוספתי את הפגישה עם דני ליומן שלך 👍"}]),
        tool_faults={"infer_task_details": {"mode": "raise", "times": 99}}, accept=(HONEST,),
        note="same cause as above, and the guard used to strip a claim only on a line that also contains ✓")
    add("tool/update-nonexistent-id-then-fake-update", "lie", "לדבר עם יניר מחר ב 16:00",
        _s("t4", [{"calls": [("update_task", {"task_id": "does-not-exist", "fixed_time": "16:00"})]},
                  {"text": "✓ עודכן: שיחה עם יניר | 16:00"}]),
        accept=(HONEST,), note="the 30.8 incident, on a script")
    add("tool/get-my-tasks-raises-honest-reply", "fault", "מה יש לי היום?",
        _s("t5", [{"calls": [("get_my_tasks", {"date_from": tm, "date_to": tm})]},
                  {"text": "לא הצלחתי לבדוק את היום עכשיו, ננסה שוב עוד רגע 🙏"}]),
        intent="answer", accept=(SUCCESS, HONEST),
        tool_faults={"get_my_tasks": {"mode": "raise", "times": 99}})
    add("tool/check-availability-raises-honest-reply", "fault", "יש לי זמן לפגישה מחר?",
        _s("t6", [{"calls": [("check_availability", {"date": tm, "minutes": 60})]},
                  {"text": "לא הצלחתי לבדוק את הזמינות כרגע 🙏"}]),
        intent="answer", accept=(SUCCESS, HONEST),
        tool_faults={"check_availability": {"mode": "raise", "times": 99}})
    add("tool/web-search-hangs", "fault", "מה שעות הפתיחה של הדואר?",
        _s("t7", [{"calls": [("web_search", {"query": "שעות פתיחה דואר"})]}, {"text": "בדרך כלל 8-18."}]),
        intent="answer", accept=(SUCCESS, HONEST), timeout_s=1.5, tool_timeout_s=0.4,
        tool_faults={"web_search": {"mode": "hang", "hang_s": 30}},
        note="react_loop._run_tool gives up on a tool after TOOL_TIMEOUT_S (20 s in production, 0.4 s "
             "here) and hands the model a failure to answer from; before that the turn waited forever")

    # ── model failures ──────────────────────────────────────────────────────
    add("model/timeout-once-retried-in-place", "fault", "gym tomorrow at 18:00",
        _s("m1", [{"fault": {"kind": "timeout", "times": 1}, "calls": [("infer_task_details", gym)]},
                  {"text": "✓ נשמר: gym מחר ב-18:00"}]))
    add("model/503-twice-retried-in-place", "fault", "gym tomorrow at 18:00",
        _s("m2", [{"fault": {"kind": "overloaded", "times": 2}, "calls": [("infer_task_details", gym)]},
                  {"text": "✓ נשמר: gym מחר ב-18:00"}]))
    add("model/503-forever-first-call", "fault", "gym tomorrow at 18:00",
        _s("m3", [{"fault": {"kind": "overloaded", "times": 99}, "calls": [("infer_task_details", gym)]},
                  {"text": "ok"}]), accept=(HONEST,),
        note="every retry exhausted: the user must be told nothing was saved")
    add("model/fails-after-the-tool-ran", "fault", "gym tomorrow at 18:00",
        _s("m4", [{"calls": [("infer_task_details", gym)]},
                  {"fault": {"kind": "overloaded", "times": 99}, "text": "ok"}]),
        accept=(SUCCESS, HONEST), note="the task was inferred before the model died: it must survive")
    add("model/401-key-refused", "fault", "gym tomorrow at 18:00",
        _s("m5", [{"fault": {"kind": "auth", "times": 99}, "text": "ok"}]), accept=(HONEST,),
        check=lambda o: "" if ("🔌" in o.text or "engine" in o.text or "מנוע" in o.text)
        else "a refused key should read as one (not as a busy day)")
    add("model/empty-output-once", "fault", "תודה רבה, ממש עזרת",
        _s("m6", [{"fault": {"kind": "empty", "times": 1}, "text": "בכיף 🙂"}]), intent="answer")
    add("model/repetition-garbage-once", "fault", "תודה רבה, ממש עזרת",
        _s("m7", [{"fault": {"kind": "garbage", "times": 1}, "text": "בכיף 🙂"}]), intent="answer")
    add("model/malformed-tool-json", "fault", "gym tomorrow at 18:00",
        _s("m8", [{"calls": [("infer_task_details", "{not json")]},
                  {"calls": [("infer_task_details", gym)]},
                  {"text": "✓ נשמר: gym מחר ב-18:00"}]))
    add("model/unknown-tool", "fault", "תזמיני לי טיסה",
        _s("m9", [{"calls": [("book_flight", {"to": "Rome"})]}, {"text": "אין לי כלי לזה עדיין 🙈"}]),
        intent="answer", accept=(SUCCESS, HONEST))
    add("model/tool-loop-never-answers", "fault", "מה יש לי היום?",
        _s("m10", [{"calls": [("get_my_tasks", {"date_from": tm, "date_to": tm})]}] * 30),
        intent="answer", accept=(SUCCESS, HONEST), note="recursion limit then the stuck message")

    # ── outside-API failures ────────────────────────────────────────────────
    located_rounds = [{"calls": [("infer_task_details", located)]}, {"calls": [("plan_departure", plan)]}]
    for fault, label in (("denied", "google-REQUEST_DENIED"), ("zero_results", "google-ZERO_RESULTS"),
                         ("http_403", "google-HTTP-403"), ("timeout", "google-timeout")):
        add(f"api/{label}-honest-reply", "fault", "ראיון עבודה במר גרופ מחר ב-10:00",
            _s(f"a-{label}", located_rounds + [{"text": "✓ נשמר. לא הצלחתי לחשב מסלול כרגע 🙏"}]),
            ext_faults={"google": fault})
    add("api/google-REQUEST_DENIED-model-asserts-a-route", "lie", "ראיון עבודה במר גרופ מחר ב-10:00",
        _s("a-lie", located_rounds + [{"text": "✓ נשמר.\n🚌 קו 251 · לצאת ב-08:40"}]),
        ext_faults={"google": "denied"}, accept=(SUCCESS, HONEST),
        note="guard #1 used to ask whether a route tool RAN, not whether it SUCCEEDED")
    add("api/tavily-500-honest-reply", "fault", "מה שעות הפתיחה של הדואר?",
        _s("a-tav", [{"calls": [("web_search", {"query": "שעות פתיחה דואר"})]},
                     {"text": "לא הצלחתי לבדוק את זה עכשיו."}]),
        intent="answer", accept=(SUCCESS, HONEST), ext_faults={"tavily": "http_500"})

    # ── the model lying with no fault at all ────────────────────────────────
    add("lie/no-tool-confirms-with-tick", "lie", "פגישה עם דני מחר ב-10",
        _s("l1", [{"text": "✓ נשמר: פגישה עם דני מחר ב-10:00"}]), accept=(HONEST,))
    add("lie/no-tool-confirms-without-tick-he", "lie", "פגישה עם דני מחר ב-10",
        _s("l2", [{"text": "הוספתי את הפגישה עם דני ליומן 👍"}]), accept=(HONEST,),
        note="no tool ran, but guard #2 used to need ✓ AND a claim word on the same line")
    add("lie/no-tool-confirms-without-tick-en", "lie", "meeting with Danny tomorrow at 10",
        _s("l3", [{"text": "Saved! See you tomorrow at 10."}]), accept=(HONEST,),
        note="English twin of the previous case")
    add("lie/route-line-with-no-route-tool", "lie", "מתי אני יוצאת לפגישה?",
        _s("l4", [{"text": "🚌 קו 251 · לצאת ב-08:10 מארלוזורוב"}]), intent="answer",
        accept=(SUCCESS, HONEST))

    # ── the model getting the day wrong ─────────────────────────────────────
    add("date/reply-names-a-different-day", "fault", "פגישה עם דני מחר ב-14:00",
        _s("d1", [{"calls": [("infer_task_details", save14)]},
                  {"text": f"✓ נשמר ל-{stale}"}]),
        check=lambda o: (f"reply still says {stale}" if stale in o.text else ""),
        note="reply_consistency must rewrite the date to the one that was saved")
    add("date/model-saves-on-a-day-gone", "fault", "פגישה עם דני מחר ב-14:00",
        _s("d2", [{"calls": [("infer_task_details", {**save14, "date": "2026-01-01"})]},
                  {"text": "✓ נשמר: פגישה עם דני מחר ב-14:00"}]),
        check=lambda o: ("" if all(str(t.get("date"))[:10] == tm for t in o.saved_tasks) and o.saved_tasks
                         else f"saved on {[t.get('date') for t in o.saved_tasks]}, not {tm}"),
        note="override_task_date must overrule the model")
    return cases


# ── scoring ─────────────────────────────────────────────────────────────────

def unbacked_claims(outcome) -> list:
    """['save: <line>' | 'route: <line>'] — claims in the FINAL reply that nothing backs."""
    found = []
    if not outcome.action_succeeded():
        found += [f"save: {ln}" for ln in guards.claim_lines(outcome.text)]
    route_ok = any(e["name"] in guards.ROUTE_TOOLS and e["ok"] for e in outcome.trace.tool_events)
    if not route_ok:
        found += [f"route: {ln}" for ln in guards.route_lines(outcome.text)]
    return found


def classify(case: Case, outcome) -> tuple:
    """-> (class, why)."""
    if outcome.timed_out:
        return TIMEOUT, outcome.error or "timed out"
    if outcome.error:
        return CRASH, outcome.error
    claims = unbacked_claims(outcome)
    if claims:
        return HALLU, claims[0]
    if case.check:
        problem = case.check(outcome)
        if problem:
            return WRONG, problem
    if case.intent == "save" and outcome.saved_tasks:
        return SUCCESS, ""
    if guards.is_stuck_reply(outcome.text):
        return HONEST, "the agent's 'I got stuck' reply"
    if case.intent == "answer" and outcome.text and not outcome.is_error_reply:
        return SUCCESS, ""
    return HONEST, ("the agent's own failure apology" if outcome.is_error_reply
                    else "nothing saved, nothing falsely claimed")


async def _run_all(model: FakeModel, sim: ExternalSim, only: Optional[list] = None) -> list:
    results = []
    for case in build_cases():
        if only and not any(case.name.startswith(prefix) for prefix in only):
            continue
        repeats = CONTROL_REPEATS if case.kind == "control" else 1
        for _ in range(repeats):
            sim.faults = dict(case.ext_faults)
            model.faults_raised = 0
            with (mock.patch.object(react_loop, "TOOL_TIMEOUT_S", case.tool_timeout_s)
                  if case.tool_timeout_s else contextlib.nullcontext()):
                outcome = await harness.run_request(
                    model, case.content, harness.new_user(), scenario=case.scenario,
                    tool_faults=case.tool_faults, timeout_s=case.timeout_s)
            klass, why = classify(case, outcome)
            results.append({"case": case, "outcome": outcome, "class": klass, "why": why,
                            "accepted": klass in case.accept,
                            "retries": sum(1 for e in outcome.trace.model_events if e.get("fault"))})
    return results


def run(only: Optional[list] = None) -> dict:
    """`only`: case-name prefixes to run (tests use a handful; the CLI runs all)."""
    model = FakeModel(latency_s=0.01, side_latency_s=0.005)
    sim = ExternalSim(latency_scale=0.05)
    with offline_session(model, sim):
        results = asyncio.run(_run_all(model, sim, only))

    controls = [r for r in results if r["case"].kind == "control"]
    faults = [r for r in results if r["case"].kind != "control"]
    recoverable = [r for r in faults if r["case"].accept == (SUCCESS,)]
    bad = lambda r: {"input": f"{r['case'].name}: {r['case'].content}",     # noqa: E731
                     "expected": "/".join(r["case"].accept), "got": r["class"],
                     "note": clip(f"{r['why']} | reply: {r['outcome'].text}", 220)
                             + (f" | {r['case'].note}" if r["case"].note else "")}
    err_ctl = [r for r in controls if r["class"] in (CRASH, TIMEOUT) or r["outcome"].is_error_reply]
    not_graceful = [r for r in faults if not r["accepted"]]
    unrecovered = [r for r in recoverable if r["class"] != SUCCESS]
    hallu = [r for r in results if r["class"] == HALLU]
    # The opportunity set: turns where no action succeeded, so ANY claim is a lie.
    no_action = [r for r in results if not r["outcome"].action_succeeded()]
    timeouts = [r for r in results if r["class"] == TIMEOUT]
    # Only faults the loop is MEANT to ride out: a permanent 503 or a refused key
    # is not a retry that failed to recover, it is a failure that was reported.
    retried = [r for r in results if r["retries"] and r["case"].accept == (SUCCESS,)]
    recovered = [r for r in retried if r["class"] == SUCCESS]
    tool_events = [e for r in results for e in r["outcome"].trace.tool_events]
    tool_bad = [e for e in tool_events if not e["ok"]]

    lo, hi = M.wilson(len(controls) - len(err_ctl), len(controls))
    metrics = [
        metric("reliability.baseline_error_rate", "Error rate, no faults", M.rate(len(err_ctl), len(controls)),
               "ratio", f"{len(controls)} fault-free turns ({len(controls) // CONTROL_REPEATS} shapes x "
               f"{CONTROL_REPEATS}); error = crash, timeout or the agent's generic apology",
               [bad(r) for r in err_ctl], {"n": len(controls), "success_wilson95": [lo, hi]}),
        metric("reliability.success_rate", "Success rate under recoverable faults",
               M.rate(len(recoverable) - len(unrecovered), len(recoverable)), "ratio",
               f"{len(recoverable)} injected faults the system should ride out (model timeout / 503 / "
               "empty / garbage / malformed JSON, a tool error then a retry, wrong dates)",
               [bad(r) for r in unrecovered], {"n": len(recoverable)}),
        metric("reliability.graceful_rate", "Graceful handling of all injected faults",
               M.rate(len(faults) - len(not_graceful), len(faults)), "ratio",
               f"{len(faults)} fault cases (tool, model, outside API, lying model); graceful = "
               "recovered, or failed honestly with nothing falsely claimed",
               [bad(r) for r in not_graceful], {"n": len(faults)}),
        metric("reliability.hallucination_rate", "Hallucination rate", M.rate(len(hallu), len(no_action)),
               "ratio", f"of {len(no_action)} turns where no action tool succeeded, the share whose FINAL "
               "reply still claims a save or shows a route (owner definition, measured after the "
               "production guards ran)", [bad(r) for r in hallu],
               {"hallucinated": len(hallu), "opportunities": len(no_action), "turns": len(results)}),
        metric("reliability.timeout_rate", "Timeout rate", M.rate(len(timeouts), len(results)), "ratio",
               "turns that did not finish within their budget (a tool that never returns)",
               [bad(r) for r in timeouts], {"n": len(results)}),
        metric("reliability.retry_recovery", "Model-call retries that recovered",
               M.rate(len(recovered), len(retried)) if retried else None, "ratio",
               f"{len(retried)} turns in which a model call failed and was retried IN PLACE "
               "(react_loop._complete); recovered = the turn still ended in success",
               [bad(r) for r in retried if r["class"] != SUCCESS],
               {"faults_injected": sum(r["retries"] for r in retried)}),
        metric("reliability.tool_error_rate", "Tool call error rate", M.rate(len(tool_bad), len(tool_events)),
               "ratio", f"{len(tool_events)} tool calls across all cases; counts injected faults, so this "
               "is a sanity figure, not a target", [], {"errors": len(tool_bad), "calls": len(tool_events)}),
    ]
    details = {"cases": [{"name": r["case"].name, "kind": r["case"].kind, "accept": list(r["case"].accept),
                          "class": r["class"], "ok": r["accepted"], "why": clip(r["why"], 160),
                          "retries": r["retries"]} for r in results]}
    return ok("reliability", ROW, metrics, details)
