"""The evaluation harness itself works — its arithmetic, its fakes, its verdicts.

An evaluation matrix that is wrong is worse than none: it ends the
investigation (the silent-state rule's third clause — "a check that cannot fail
is not a check"). So this pins, on inputs whose answer is known by hand:

  * the metric maths: accuracy, precision / recall / F1 (macro and micro),
    percentiles, Recall@K, MRR, the Wilson interval
  * the status rules: green / yellow / red / info / not run, and that only RED
    fails the build, a crashed suite is RED, and a suite that cannot run says WHY
  * the guards mirror: every fragment of the claim regex the evals use is
    literally present in lumi_agent.py, so widening the real guard without the
    mirror fails here instead of quietly weakening the hallucination metric
  * the fakes: scripted rounds, faults raised the right number of times, the
    network blocked and counted, the dollar cap actually refusing the next call
  * the datasets: well formed, labels valid, ids unique
  * a SMALL end-to-end run of each cheap suite through the real turn code

It does not assert how good Meira is — that is what the thresholds are for. The
one place it looks at a real finding (the guard letting a claim without a tick
through) is a classification test on a synthetic Outcome, not on the live code,
so fixing the guard later does not break it.
"""
import asyncio
import json
import math
import os
import re
import sys
from types import SimpleNamespace
from unittest import mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from evals import guards, live, metrics as M, report  # noqa: E402
from evals import result as R                          # noqa: E402
from evals.fakes import ExternalSim, FakeModel, Scenario, est_tokens  # noqa: E402
from evals.trace import Trace                          # noqa: E402

SERVER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── metric maths ────────────────────────────────────────────────────────────

def test_accuracy_counts_matches_and_rejects_ragged_input():
    assert M.accuracy(["a", "b", "c", "d"], ["a", "b", "x", "d"]) == 0.75
    assert M.accuracy([], []) == 0.0
    with pytest.raises(ValueError):
        M.accuracy(["a"], ["a", "b"])


def test_precision_recall_f1_on_a_confusion_worked_by_hand():
    #   truth: A A A B B C        predicted: A A B B B A
    #   A: tp2 fp1 fn1 -> P 2/3 R 2/3 F1 2/3
    #   B: tp2 fp1 fn0 -> P 2/3 R 1   F1 .8
    #   C: tp0 fp0 fn1 -> P 0   R 0   F1 0   (never predicted: 0, not NaN)
    truth, pred = list("AAABBC"), list("AABBBA")
    out = M.prf(truth, pred)
    a, b, c = out["labels"]["A"], out["labels"]["B"], out["labels"]["C"]
    assert (a["tp"], a["fp"], a["fn"]) == (2, 1, 1)
    assert a["precision"] == pytest.approx(2 / 3) and a["recall"] == pytest.approx(2 / 3)
    assert a["f1"] == pytest.approx(2 / 3)
    assert b["precision"] == pytest.approx(2 / 3) and b["recall"] == 1.0
    assert b["f1"] == pytest.approx(0.8)
    assert (c["precision"], c["recall"], c["f1"], c["support"]) == (0.0, 0.0, 0.0, 1)
    assert out["macro"]["f1"] == pytest.approx((2 / 3 + 0.8 + 0.0) / 3)
    assert out["macro"]["precision"] == pytest.approx((2 / 3 + 2 / 3 + 0) / 3)
    # single-label classification: micro-F1 == accuracy
    assert out["micro"]["f1"] == pytest.approx(out["accuracy"]) == pytest.approx(4 / 6)


def test_a_label_only_in_the_predictions_still_counts_in_the_macro_average():
    out = M.prf(["a", "a"], ["a", "z"])
    assert set(out["labels"]) == {"a", "z"}
    assert out["labels"]["z"]["support"] == 0 and out["labels"]["z"]["precision"] == 0.0


def test_set_prf_for_the_clash_shaped_question():
    out = M.set_prf({"x", "y", "z"}, {"y", "z", "w"})
    assert (out["tp"], out["fp"], out["fn"]) == (2, 1, 1)
    assert out["precision"] == pytest.approx(2 / 3) and out["recall"] == pytest.approx(2 / 3)
    assert M.set_prf(set(), set())["f1"] == 0.0


def test_percentiles_interpolate_like_numpy():
    assert M.percentile([1, 2, 3, 4], 50) == 2.5
    assert M.percentile([1, 2, 3, 4], 0) == 1 and M.percentile([1, 2, 3, 4], 100) == 4
    assert M.percentile(list(range(1, 101)), 95) == pytest.approx(95.05)
    assert M.percentile(list(range(1, 101)), 99) == pytest.approx(99.01)
    assert M.percentile([7], 99) == 7.0
    assert math.isnan(M.percentile([], 50)), "no samples is NaN, never a 0 ms latency"
    with pytest.raises(ValueError):
        M.percentile([1], 101)


def test_latency_summary_is_in_milliseconds():
    s = M.latency_summary([0.1, 0.2, 0.3])
    assert s["n"] == 3 and s["p50_ms"] == pytest.approx(200) and s["max_ms"] == pytest.approx(300)
    assert M.latency_summary([])["p95_ms"] is None


def test_recall_at_k_and_reciprocal_rank():
    ranked = ["d", "b", "a", "c"]
    assert M.recall_at_k(ranked, {"a", "b"}, 1) == 0.0
    assert M.recall_at_k(ranked, {"a", "b"}, 2) == 0.5
    assert M.recall_at_k(ranked, {"a", "b"}, 3) == 1.0
    assert M.recall_at_k(ranked, set(), 3) == 0.0
    assert M.reciprocal_rank(ranked, {"a"}) == pytest.approx(1 / 3)
    assert M.reciprocal_rank(ranked, {"b", "a"}) == pytest.approx(1 / 2)   # FIRST relevant counts
    assert M.reciprocal_rank(ranked, {"zzz"}) == 0.0


def test_mrr_and_mean_recall_over_queries():
    rankings = [["a", "x"], ["x", "b"], ["x", "y"]]
    relevants = [{"a"}, {"b"}, {"c"}]
    assert M.mrr(rankings, relevants) == pytest.approx((1 + 0.5 + 0) / 3)
    assert M.mean_recall_at_k(rankings, relevants, 1) == pytest.approx(1 / 3)
    assert M.mean_recall_at_k(rankings, relevants, 2) == pytest.approx(2 / 3)


def test_wilson_interval_is_wide_for_small_samples():
    lo, hi = M.wilson(7, 7)
    assert hi == 1.0 and lo < 0.7, "7 of 7 is not 100%"
    lo2, hi2 = M.wilson(700, 700)
    assert lo2 > 0.99
    assert M.wilson(0, 0) == (0.0, 1.0)
    assert M.rate(1, 0) == 0.0


# ── statuses and the report ─────────────────────────────────────────────────

RULE_UP = {"op": ">=", "target": 0.95, "fail": 0.90}
RULE_DOWN = {"op": "<=", "target": 0.02, "fail": 0.05}


def test_status_rules_both_directions():
    assert report.judge(0.97, RULE_UP) == report.GREEN
    assert report.judge(0.95, RULE_UP) == report.GREEN, "meeting the target exactly is green"
    assert report.judge(0.92, RULE_UP) == report.YELLOW
    assert report.judge(0.90, RULE_UP) == report.YELLOW, "the fail line itself is not past it"
    assert report.judge(0.89, RULE_UP) == report.RED
    assert report.judge(0.01, RULE_DOWN) == report.GREEN
    assert report.judge(0.03, RULE_DOWN) == report.YELLOW
    assert report.judge(0.06, RULE_DOWN) == report.RED
    assert report.judge(0.5, None) == report.INFO
    assert report.judge(None, RULE_UP) == report.NOT_RUN
    assert report.judge(float("nan"), RULE_UP) == report.NOT_RUN


def test_shipped_thresholds_are_well_formed():
    rules = report.load_thresholds()
    assert rules, "thresholds.json is empty"
    for mid, rule in rules.items():
        assert rule["op"] in (">=", "<="), mid
        if rule["op"] == ">=":
            assert rule["fail"] <= rule["target"], f"{mid}: fail must not be stricter than the target"
        else:
            assert rule["fail"] >= rule["target"], f"{mid}: fail must not be stricter than the target"


def _suite(name, row, **values):
    ms = [R.metric(mid, mid, v, "ratio", "how", [{"input": "x", "expected": "y", "got": "z"}] if v and v < 0.5 else [])
          for mid, v in values.items()]
    return R.ok(name, row, ms)


def test_a_red_metric_fails_the_build_and_a_yellow_one_does_not():
    th = {"accuracy.date": RULE_UP, "accuracy.intent": RULE_UP}
    red = report.build([_suite("accuracy", "Accuracy", **{"accuracy.date": 0.5, "accuracy.intent": 0.99})],
                       "offline", th)
    assert red["overall"] == "red" and red["exit_code"] == 1
    yellow = report.build([_suite("accuracy", "Accuracy", **{"accuracy.date": 0.92, "accuracy.intent": 0.99})],
                          "offline", th)
    assert yellow["overall"] == "yellow" and yellow["exit_code"] == 0
    green = report.build([_suite("accuracy", "Accuracy", **{"accuracy.date": 0.99, "accuracy.intent": 0.99})],
                         "offline", th)
    assert green["overall"] == "green" and green["exit_code"] == 0


def test_a_crashed_suite_is_red_never_skipped():
    try:
        raise RuntimeError("boom")
    except RuntimeError as exc:
        crashed = R.errored("reliability", "Reliability", exc)
    out = report.build([crashed], "offline", {})
    assert out["exit_code"] == 1 and out["overall"] == "red"
    assert out["crashed"][0]["reason"].startswith("RuntimeError: boom")
    row = next(r for r in out["matrix"] if r["row"] == "Reliability")
    assert row["status"] == "red" and "boom" in " ".join(row["crashed"])


def test_a_suite_that_cannot_run_says_why_and_is_not_green():
    out = report.build([R.not_run("accuracy_live", "Accuracy (live LLM judge)", "NEBIUS_API_KEY is not set")],
                       "offline", {})
    row = next(r for r in out["matrix"] if r["row"] == "Accuracy (live LLM judge)")
    assert row["status"] == "not_run"
    assert out["not_run"][0]["reason"] == "NEBIUS_API_KEY is not set"
    assert out["exit_code"] == 0, "a suite that cannot run is reported, not a failure"
    md = report.render_markdown(out)
    assert "NOT RUN" in md and "NEBIUS_API_KEY is not set" in md


def test_a_metric_with_no_value_is_not_run_and_carries_its_reason():
    m = R.metric("accuracy.clash_f1", "Clash F1", None, "ratio", "not run: fixture missing", [],
                 {"reason": "fixture missing: tests/fixtures/clash-golden.json"})
    out = report.build([R.ok("accuracy", "Accuracy", [m])], "offline", {"accuracy.clash_f1": RULE_UP})
    assert out["metrics"]["accuracy.clash_f1"]["status"] == "not_run"
    assert any("fixture missing" in n["reason"] for n in out["not_run"])


def test_the_matrix_has_the_seven_rows_in_the_markdown():
    out = report.build([], "offline", {})
    md = report.render_markdown(out)
    assert [r["row"] for r in out["matrix"]] == [
        "Accuracy", "Accuracy (live LLM judge)", "Reliability", "Performance", "Scalability", "Cost",
        "RAG quality"]
    for header in ("| Metric | How measured | Value | Threshold | Status | Example failure |",):
        assert header in md
    for row in out["matrix"]:
        assert f"**{row['row']}**" in md


def test_report_json_round_trips(tmp_path):
    suite = _suite("accuracy", "Accuracy", **{"accuracy.date": 0.99})
    out = report.build([suite], "offline", {"accuracy.date": RULE_UP})
    jp, mp = report.write(out, str(tmp_path))
    loaded = json.loads(open(jp, encoding="utf-8").read())
    assert loaded["metrics"]["accuracy.date"]["status"] == "green"
    assert loaded["metrics"]["accuracy.date"]["threshold"] == RULE_UP
    assert "Meira evaluation matrix" in open(mp, encoding="utf-8").read()


def test_formatting_of_each_unit():
    assert report.fmt(0.8123, "ratio") == "81.2%"
    assert report.fmt(52.4, "ms") == "52 ms"
    assert report.fmt(0.01556, "usd") == "$0.0156"
    assert report.fmt(None, "ratio") == "n/a"
    assert report.fmt_threshold(RULE_UP, "ratio").startswith("≥ 95.0%")


# ── the guards mirror ───────────────────────────────────────────────────────

def test_the_claim_regex_mirrors_lumi_agent_source():
    src = open(os.path.join(SERVER, "lumi_agent.py"), encoding="utf-8").read()
    for part in guards.CLAIM_PATTERN_PARTS:
        assert part in src, ("lumi_agent's save-claim guard no longer contains this fragment — update "
                             f"evals/guards.py to match, or the hallucination metric is measuring something "
                             f"else: {part!r}")
    for tool in guards.ACTION_TOOLS:
        assert f'"{tool}"' in src
    assert guards.ROUTE_LINE_PATTERN in src.replace("\n", "").replace('"\n', "") or \
        "לצאת|עזיבה|הגעה|leave|arrive|wake|קימה|להתעורר" in src
    assert guards.ROUTE_TOOLS == __import__("lumi_agent").ROUTE_TOOLS


def test_claims_save_sees_claims_and_ignores_denials():
    for text in ("✓ נשמר: פגישה", "הוספתי את הפגישה ליומן 👍", "Saved! See you tomorrow", "✓ עודכן"):
        assert guards.claims_save(text), text
    for text in ("המשימה לא נשמרה", "I could not save it", "⚠️ Nothing was actually saved yet",
                 "בסדר גמור", "אין לי כלי לזה", "✓ נשמר\n⚠️ לא שמרתי כלום עדיין".split("\n")[1]):
        assert not guards.claims_save(text), text
    assert guards.claims_save("✓ נשמר\n⚠️ לא שמרתי כלום עדיין"), "a surviving claim line is still a claim"


def test_the_guards_own_route_offer_is_not_a_route_claim():
    assert guards.route_lines("רוצה שאחשב מסלול מדויק בזמן אמת? 🚆") == []
    assert guards.route_lines("🚌 קו 251 · לצאת ב-08:10") != []
    assert guards.claims_route("לצאת ב-08:10")


def test_tool_succeeded_matches_the_production_rule():
    assert guards.tool_succeeded(json.dumps({"ok": True})) is True
    assert guards.tool_succeeded(json.dumps({"ok": False, "error": "x"})) is False
    assert guards.tool_succeeded(json.dumps({"error": "no ok key"})) is False
    assert guards.tool_succeeded(json.dumps({"text": "a task"})) is True
    assert guards.tool_succeeded("not json at all") is True, "unparseable is never punished (production rule)"


# ── hallucination classification on synthetic outcomes ─────────────────────

def _outcome(text, tools=(), tasks=(), error=None, timed_out=False, kind="reply"):
    from evals.harness import Outcome
    trace = Trace()
    trace.tool_events = [{"name": n, "ms": 1, "ok": ok, "raised": False} for n, ok in tools]
    return Outcome(content="x", user={}, result=None if error else {"text": text, "tasks": list(tasks),
                                                                   "type": kind},
                   error=error, timed_out=timed_out, trace=trace)


def test_a_claim_with_no_successful_action_is_a_hallucination_with_or_without_a_tick():
    from evals import reliability as rel
    assert rel.unbacked_claims(_outcome("✓ נשמר: פגישה"))
    assert rel.unbacked_claims(_outcome("הוספתי את הפגישה ליומן 👍")), "no tick, still a lie"
    assert rel.unbacked_claims(_outcome("Saved! See you.", tools=[("infer_task_details", False)]))


def test_a_claim_backed_by_a_successful_action_is_fine():
    from evals import reliability as rel
    assert not rel.unbacked_claims(_outcome("✓ נשמר", tools=[("infer_task_details", True)]))
    assert not rel.unbacked_claims(_outcome("✓ נשמר", tasks=[{"id": "1"}]))


def test_a_route_without_a_successful_route_tool_is_a_hallucination():
    from evals import reliability as rel
    assert rel.unbacked_claims(_outcome("🚌 קו 251 · לצאת ב-08:40", tools=[("plan_departure", False)]))
    assert not rel.unbacked_claims(_outcome("🚌 קו 251 · לצאת ב-08:40", tools=[("plan_departure", True)]))


def test_outcome_classes():
    from evals import reliability as rel
    case = rel.Case("c", "fault", "x", Scenario("s", []), intent="save", accept=(rel.SUCCESS,))
    assert rel.classify(case, _outcome("done", tasks=[{"id": 1}], tools=[("infer_task_details", True)]))[0] == rel.SUCCESS
    assert rel.classify(case, _outcome("", timed_out=True, error="timed out"))[0] == rel.TIMEOUT
    assert rel.classify(case, _outcome("", error="ValueError: x"))[0] == rel.CRASH
    assert rel.classify(case, _outcome("הוספתי ליומן"))[0] == rel.HALLU
    assert rel.classify(case, _outcome("לא הצלחתי לשמור, נסי שוב"))[0] == rel.HONEST
    assert rel.classify(case, _outcome("נתקעתי רגע 🙈"))[0] == rel.HONEST


# ── the fakes ───────────────────────────────────────────────────────────────

def test_the_fake_model_plays_its_rounds_and_raises_faults_the_right_number_of_times():
    scenario = Scenario("s", [
        {"fault": {"kind": "overloaded", "times": 2}, "calls": [("calculate_date", {"expression": "מחר"})]},
        {"text": "done"}])
    model = FakeModel(scenarios=[scenario], latency_s=0.0)
    user_msg = [{"role": "system", "content": "s"}, {"role": "user", "content": "תכנן"}]

    async def go():
        from evals import trace as T
        tok = T.CURRENT.set(Trace())
        sc = T.SCENARIO.set(scenario)
        try:
            tools = [{"type": "function"}]
            for _ in range(2):
                with pytest.raises(RuntimeError, match="503"):
                    await model.respond(messages=user_msg, tools=tools, tool_choice="auto")
            first = await model.respond(messages=user_msg, tools=tools, tool_choice="auto")
            assert first.choices[0].message.tool_calls[0].function.name == "calculate_date"
            wire = user_msg + [{"role": "assistant", "content": ""}, {"role": "tool", "content": "{}"}]
            second = await model.respond(messages=wire, tools=tools, tool_choice="auto")
            assert second.choices[0].message.content == "done"
            assert second.usage.prompt_tokens > 0
            return model.faults_raised
        finally:
            T.SCENARIO.reset(sc)
            T.CURRENT.reset(tok)

    assert asyncio.run(go()) == 2


def test_soft_faults_return_bad_text_instead_of_raising():
    scenario = Scenario("s", [{"fault": {"kind": "garbage", "times": 1}, "text": "ok"}])
    model = FakeModel(scenarios=[scenario], latency_s=0.0)

    async def go():
        from evals import trace as T
        sc = T.SCENARIO.set(scenario)
        try:
            args = dict(messages=[{"role": "user", "content": "x"}], tools=[{}], tool_choice="auto")
            bad = (await model.respond(**args)).choices[0].message.content
            good = (await model.respond(**args)).choices[0].message.content
            return bad, good
        finally:
            T.SCENARIO.reset(sc)

    bad, good = asyncio.run(go())
    assert re.search(r"(.)\1{11}", bad), "garbage must trip the degenerate-output guard (12 repeats)"
    assert good == "ok"


def test_the_side_calls_answer_with_json_not_tool_calls():
    model = FakeModel(latency_s=0.0, side_latency_s=0.0)
    r = asyncio.run(model.respond(messages=[{"role": "user", "content": "x"}],
                                  response_format={"type": "json_object"}))
    assert json.loads(r.choices[0].message.content)["actions"] == []
    assert r.choices[0].message.tool_calls is None


def test_estimated_tokens_scale_with_the_request():
    assert est_tokens("a" * 400) == 100
    assert est_tokens([{"role": "user", "content": "a" * 4000}]) > est_tokens("a" * 400)
    assert est_tokens(None) == 0


def test_the_simulated_world_counts_calls_and_blocks_unknown_hosts():
    import httpx
    sim = ExternalSim(latency_scale=0.0)

    async def go():
        ok = await sim.handle(httpx.Request("GET", "https://maps.googleapis.com/maps/api/geocode/json?address=x"))
        assert ok.status_code == 200 and ok.json()["status"] == "OK"
        with pytest.raises(httpx.ConnectError):
            await sim.handle(httpx.Request("GET", "https://api.openai.com/v1/models"))
        sim.faults["google"] = "denied"
        denied = await sim.handle(httpx.Request("GET", "https://maps.googleapis.com/maps/api/directions/json"))
        assert denied.json()["status"] == "REQUEST_DENIED"
        sim.faults["google"] = "timeout"
        with pytest.raises(httpx.ReadTimeout):
            await sim.handle(httpx.Request("GET", "https://maps.googleapis.com/maps/api/place/textsearch/json"))
        sim.faults["google"] = "http_403"
        assert (await sim.handle(httpx.Request("GET", "https://maps.googleapis.com/maps/api/geocode/json"))
                ).status_code == 403

    asyncio.run(go())
    assert sim.blocked == ["https://api.openai.com/v1/models"], "an unsimulated host must be recorded"
    assert sim.by_service()["google_geocode"] == 2 and sim.count() == 4


# ── cost maths ──────────────────────────────────────────────────────────────

def test_request_cost_is_tokens_times_the_price_table_plus_api_calls():
    import llm_usage
    from evals import cost
    t = Trace()
    model = "nvidia/nemotron-3-super-120b-a12b"
    t.model_events = [{"latency_s": 0.1, "tokens_in": 10_000, "tokens_out": 100, "fault": None, "model": model},
                      {"latency_s": 0.1, "tokens_in": 5_000, "tokens_out": 50, "fault": "timeout", "model": model}]
    t.ext_events = [{"service": "google_directions", "latency_s": 0.1}, {"service": "google_directions", "latency_s": 0.1},
                    {"service": "tavily", "latency_s": 0.1}]
    c = cost.request_cost(t)
    pin, pout = llm_usage.PRICES[model]
    assert c["model"] == pytest.approx((10_000 * pin + 100 * pout) / 1e6), "a failed call is not billed"
    assert c["api"] == pytest.approx(2 * 0.005 + 0.008)
    assert c["api_calls"] == {"google_directions": 2, "tavily": 1}
    assert c["total"] == pytest.approx(c["model"] + c["api"])


def test_summarise_checks_the_allowance_with_model_spend_only():
    from evals import cost
    costs = [{"model": 0.006, "api": 0.020, "total": 0.026, "tokens_in": 10_000, "tokens_out": 100,
              "model_calls": 2, "api_calls": {"google_directions": 4}}] * 4
    s = cost.summarise(costs, saved_tasks=2, cpu_s_per_request=0.02, source="t")
    assert s["per_request_usd"] == pytest.approx(0.026)
    assert s["per_saved_task_usd"] == pytest.approx(0.052)
    assert s["allowance_used"] == pytest.approx(0.006 * s["daily_requests"] / s["daily_usd_allowance"])
    assert s["api_calls_per_request"] == {"google_directions": 4.0}
    assert s["runway_days_worst_case"] == pytest.approx(
        s["spendable_usd"] / (s["free_seats"] * s["daily_requests"] * 0.006))


# ── the live harness cannot overspend ───────────────────────────────────────

def test_the_dollar_cap_refuses_the_next_call():
    b = live.Budget(limit_usd=0.001)
    calls = []

    async def real_create(**kw):
        calls.append(kw)
        return SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10_000, completion_tokens=100),
                               model="nvidia/nemotron-3-super-120b-a12b",
                               choices=[SimpleNamespace(message=SimpleNamespace(content="x", tool_calls=None))])

    real = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=real_create)))
    client = live.TimedClient(real, b)

    async def go():
        await client.chat.completions.create(model="m", messages=[])      # ~$0.003: now over the cap
        assert b.exhausted
        with pytest.raises(live.BudgetExceeded):
            await client.chat.completions.create(model="m", messages=[])

    asyncio.run(go())
    assert len(calls) == 1, "the second call must never reach the provider"
    assert b.spent_usd == pytest.approx(live.price_usd("nvidia/nemotron-3-super-120b-a12b", 10_000, 100))


def test_unknown_models_are_priced_at_the_dearest_known_one():
    import llm_usage
    dearest = max(llm_usage.PRICES.values(), key=lambda p: p[0] + p[1])
    assert live.price_usd("some/new-model", 1_000_000, 0) == pytest.approx(dearest[0])


def test_live_refuses_to_start_when_production_credentials_are_present():
    import config
    with mock.patch.multiple(config, LLM_API_KEY="k", SUPABASE_URL="https://prod.supabase.co"):
        assert "refusing" in live.preflight()
    with mock.patch.multiple(config, LLM_API_KEY="", SUPABASE_URL=""), \
            mock.patch.dict(os.environ, {"NEBIUS_API_KEY": ""}):
        assert "NEBIUS_API_KEY" in live.preflight()
    with mock.patch.multiple(config, LLM_API_KEY="k", SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY="",
                             WHATSAPP_API_TOKEN=""):
        assert live.preflight() == ""


def test_live_suites_are_not_run_offline_and_say_why():
    from evals import accuracy
    with mock.patch.dict(os.environ, {"NEBIUS_API_KEY": ""}):
        import config
        with mock.patch.multiple(config, LLM_API_KEY="", SUPABASE_URL=""):
            r = accuracy.run_live()
    assert r["status"] == "not_run" and "NEBIUS_API_KEY" in r["reason"]


def test_live_hard_checks_use_an_oracle_independent_of_the_module_under_test():
    from datetime import date
    from evals import live_accuracy as la
    today = date(2026, 10, 15)                      # a Thursday
    assert la.expected_date({"offset": 1}, today) == date(2026, 10, 16)
    assert la.expected_date({"weekday": 3}, today) == date(2026, 10, 22), "Thursday on a Thursday is next week"
    assert la.expected_date({"weekday": 0}, today) == date(2026, 10, 19)
    assert la.expected_date({"month_day": [12, 25]}, today) == date(2026, 12, 25)
    assert la.expected_date({"month_day": [10, 1]}, today) == date(2027, 10, 1)
    q = {"saves": {"date": {"offset": 1}, "time": "14:00"}}
    good = _outcome("ok", tasks=[{"date": "2026-10-16", "fixed_time": "14:00"}])
    bad = _outcome("ok", tasks=[{"date": "2026-10-17", "fixed_time": "14:00"}])
    assert all(c[1] for c in la.hard_checks(q, good, today))
    assert not dict((c[0], c[1]) for c in la.hard_checks(q, bad, today))["date_correct"]
    nothing = la.hard_checks({"saves": False}, _outcome("hi", tasks=[{"date": "x"}]), today)
    assert not dict((c[0], c[1]) for c in nothing)["saves_nothing"]


# ── datasets ────────────────────────────────────────────────────────────────

def test_datasets_are_well_formed():
    from evals import accuracy
    import categorize
    import task_intent
    dates = accuracy.load("dates.jsonl")
    cats = accuracy.load("categories.jsonl")
    intents = accuracy.load("intents.jsonl")
    live_q = accuracy.load("live_questions.jsonl")
    for rows in (dates, cats, intents, live_q, accuracy.load("rag_memories.jsonl"),
                 accuracy.load("rag_queries.jsonl")):
        ids = [r["id"] for r in rows]
        assert len(ids) == len(set(ids)), "duplicate ids"
    assert len(dates) >= 40 and len(cats) >= 40 and len(intents) >= 25 and len(live_q) >= 28
    assert any(re.search(r"[֐-׿]", r["input"]) for r in dates if r["kind"] == "resolve")
    assert any(r["input"].isascii() and r["input"] for r in dates if r["kind"] == "resolve")
    for r in dates:
        assert r["kind"] in ("resolve", "override", "night", "night_task")
        if r["kind"].startswith("night"):
            assert re.fullmatch(r"\d{2}:\d{2}", r["now"]), r   # the hour is part of the case
        assert r["expected"] is None or re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["expected"]), r
    for r in cats:
        assert r["category"] in categorize.VALID_CATEGORIES, r
        assert r.get("priority", "need_to") in categorize.VALID_PRIORITIES, r
    for r in intents:
        assert r["expected"] in task_intent.INTENTS, r
    for r in live_q:
        assert r["saves"] is False or isinstance(r["saves"], dict)
        assert r["rubric"]
    facts = {r["id"] for r in accuracy.load("rag_memories.jsonl")}
    assert len(facts) == 30
    queries = accuracy.load("rag_queries.jsonl")
    assert sum(1 for q in queries if q["relevant"]) == 20
    assert all(set(q["relevant"]) <= facts for q in queries)


# ── small end-to-end runs of the cheap suites ───────────────────────────────

def test_accuracy_offline_runs_and_reports_failures_as_examples():
    from evals import accuracy
    r = accuracy.run_offline()
    assert r["status"] == "ok"
    by_id = {m["id"]: m for m in r["metrics"]}
    for mid in ("accuracy.date", "accuracy.category", "accuracy.category_f1", "accuracy.intent",
                "accuracy.intent_f1", "accuracy.priority", "accuracy.clash_f1", "accuracy.clash_kind"):
        assert mid in by_id, mid
        assert 0.0 <= by_id[mid]["value"] <= 1.0
    assert by_id["accuracy.date"]["value"] >= 0.90
    # every non-perfect score must come with the example that explains it
    for m in r["metrics"]:
        if m["value"] is not None and m["value"] < 1.0 and m["id"] not in ("accuracy.category_confident_wrong",):
            assert m["failures"], f"{m['id']} < 100% with no failing example to read"
        for f in m["failures"]:
            assert {"input", "expected", "got"} <= set(f)
    th = report.load_thresholds()
    assert by_id["accuracy.date"]["id"] in th


def test_rag_offline_ranks_the_obvious_fact_first_and_beats_nothing():
    from evals import rag
    r = rag.run()
    assert r["status"] == "ok"
    v = {m["id"]: m["value"] for m in r["metrics"]}
    assert v["rag.recall_at_1"] <= v["rag.recall_at_3"] <= v["rag.recall_at_5"] <= 1.0
    assert 0.0 < v["rag.mrr"] <= 1.0
    assert v["rag.no_match_clean"] == 1.0, "questions with no relevant memory must retrieve nothing"
    rows = {row["id"]: row["ranked"] for row in r["details"]["rows"]}
    assert rows["r01"][0] == "m02" and rows["r02"][0] == "m03", "the lexically obvious fact ranks first"
    e = rag.HashEmbedder(["a b c", "d e f"])
    assert e.embed("kids pickup") == e.embed("kids pickup"), "the stand-in embedder is deterministic"
    assert rag.cosine(e.embed("kids pickup"), e.embed("kids pickup")) == pytest.approx(1.0)


def test_scale_out_inspection_reads_the_repo_not_a_guess():
    from evals import scalability
    facts = scalability._scale_out_inspection()
    names = {c["name"] for c in facts["checks"]}
    assert {"state_not_on_local_disk", "background_loops_safe_to_duplicate",
            "rate_limit_shared_across_machines", "fits_one_proxy_limit_at_10x"} <= names
    assert facts["machine"]["cpus"] is not None and facts["machine"]["proxy_hard_limit"] is not None
    assert facts["local_json_stores"], "found no JSON stores — the scan pattern has rotted"


def test_people_at_peak_solves_the_growing_store_cost_equation():
    from evals import scalability
    # U * r * (cpu + s*U) == 1 at the answer
    cpu, s, r = 0.025, 1.6e-4, 15 * 0.1 / 3600
    u = scalability._people_at_peak(cpu, s, r)
    assert u * r * (cpu + s * u) <= 1.0 < (u + 2) * r * (cpu + s * (u + 2))
    # no store growth: 1 / (cpu * r)
    assert scalability._people_at_peak(0.02, 0.0, 0.0005) == pytest.approx(100000, abs=1)


def test_the_offline_session_puts_the_fake_at_the_seam_and_runs_the_real_turn():
    """The whole point: run_turn -> lumi_agent -> react_loop -> the real tools,
    with only the model and the outside world replaced."""
    import ai_gate
    import config
    from evals import harness
    from evals.env import offline_session
    model = FakeModel(latency_s=0.0, side_latency_s=0.0)
    sim = ExternalSim(latency_scale=0.0)
    real_client = ai_gate.client
    with offline_session(model, sim):
        assert ai_gate.client is not real_client
        assert config.GOOGLE_MAPS_API_KEY == "offline-eval" and config.SUPABASE_URL == ""
        scenarios = harness.standard_scenarios()
        out = asyncio.run(harness.run_request(model, scenarios["save_gym"].note, harness.new_user(),
                                              scenario=scenarios["save_gym"], timeout_s=30))
        located = asyncio.run(harness.run_request(model, scenarios["save_located"].note, harness.new_user(),
                                                  scenario=scenarios["save_located"], timeout_s=30))
    assert ai_gate.client is real_client, "the seam must be restored"
    assert out.error is None and len(out.saved_tasks) == 1
    assert out.saved_tasks[0]["date"] == harness._tomorrow(), "the day was resolved by code"
    assert [e["name"] for e in out.trace.tool_events] == ["infer_task_details"]
    assert model.calls >= 2 and out.trace.tokens_in > 1000, "the real 18 KB prompt was 'sent'"
    assert sim.blocked == [], "nothing may reach an unsimulated host"
    assert located.error is None and sim.by_service().get("google_directions", 0) >= 1
    assert any(e["service"].startswith("google") and e["tool"] for e in located.trace.ext_events), \
        "outside calls are attributed to the tool that made them"


def test_reliability_subset_runs_and_separates_honest_from_dishonest():
    from evals import reliability as rel
    r = rel.run(only=["control/chat", "tool/update-nonexistent-id", "model/timeout-once", "lie/no-tool-confirms-with-tick"])
    assert r["status"] == "ok"
    names = {c["name"]: c for c in r["details"]["cases"]}
    assert names["control/chat"]["class"] == rel.SUCCESS
    assert names["model/timeout-once-retried-in-place"]["class"] == rel.SUCCESS
    assert names["model/timeout-once-retried-in-place"]["retries"] == 1
    assert names["tool/update-nonexistent-id-then-fake-update"]["class"] != rel.HALLU, \
        "the 30.8 incident: the guard must not let this confirmation through"
    assert names["lie/no-tool-confirms-with-tick"]["class"] != rel.HALLU
    ids = {m["id"] for m in r["metrics"]}
    assert {"reliability.baseline_error_rate", "reliability.hallucination_rate",
            "reliability.graceful_rate"} <= ids


def test_performance_overhead_is_wall_minus_the_simulated_world():
    from evals import performance
    t = Trace()
    t.started, t.finished = 0.0, 1.0
    t.model_events = [{"latency_s": 0.3, "tokens_in": 1, "tokens_out": 1, "fault": None}] * 2
    t.ext_events = [{"service": "tavily", "latency_s": 0.1}]
    assert performance.overhead_s(t) == pytest.approx(0.3)
    t.finished = 0.5                      # parallel tools can make the nominal sum exceed the wall
    assert performance.overhead_s(t) == 0.0


def test_every_threshold_id_is_a_metric_some_suite_can_emit():
    """A threshold for a metric nobody produces is a check that cannot fail."""
    src = ""
    for name in ("accuracy", "reliability", "performance", "scalability", "cost", "rag", "live_accuracy"):
        src += open(os.path.join(SERVER, "evals", f"{name}.py"), encoding="utf-8").read()
    for mid in report.load_thresholds():
        prefix, _, tail = mid.partition(".")
        literal = f'"{mid}"' in src
        # cost.py and rag.py emit the same metrics under two prefixes (offline and
        # live) with f"{prefix}.<tail>"; Recall@K is f"{prefix}.recall_at_{k}".
        templated = (prefix in ("cost", "cost_live", "rag", "rag_live")
                     and (f'f"{{prefix}}.{tail}"' in src
                          or (tail.startswith("recall_at_") and 'f"{prefix}.recall_at_{k}"' in src)))
        assert literal or templated, f"{mid} is in thresholds.json but no suite emits it"


# ── the live path, exercised without spending a cent ─────────────────────────

def _live_stand_in(budget_usd):
    """Run the WHOLE live pipeline (preflight, session, 30 questions, hard checks,
    judge, budget, report-shaped metrics) with a fake model standing in for the
    provider, so the thing that spends money has itself been run before it does."""
    import ai_gate
    import config
    import httpx
    from evals import live_accuracy
    from evals.fakes import FakeClient
    model = FakeModel(latency_s=0.0, side_latency_s=0.0,
                      side_json={"score": 5, "note": "fine", "understood": "", "kind": "chat",
                                 "actions": [], "ask": None})

    async def blocked(self, request):
        raise httpx.ConnectError("network is off in this test", request=request)

    with mock.patch.multiple(config, LLM_API_KEY="k", SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY="",
                             WHATSAPP_API_TOKEN="", GOOGLE_MAPS_API_KEY="", TAVILY_API_KEY=""), \
            mock.patch.object(ai_gate, "client", lambda *a, **k: FakeClient(model)), \
            mock.patch("httpx.AsyncHTTPTransport.handle_async_request", blocked):
        return live_accuracy.run(budget_usd=budget_usd)


def test_the_live_pipeline_runs_end_to_end_and_feeds_the_other_live_rows():
    from evals import cost, performance
    result = _live_stand_in(5.0)
    assert result["status"] == "ok", result["reason"]
    ids = {m["id"]: m for m in result["metrics"]}
    assert ids["accuracy.live_judge"]["value"] == 5.0
    assert result["details"]["questions_run"] == len(__import__("evals.accuracy", fromlist=["load"]).load("live_questions.jsonl")) and not result["details"]["stopped"]
    assert 0 < result["details"]["spent_usd"] < 5.0
    # a fake that never calls a tool saves nothing, so the dated requests must FAIL their hard checks:
    assert ids["accuracy.live_date"]["value"] == 0.0, "the hard checks must be able to fail"
    assert ids["accuracy.live_hard"]["value"] < 1.0 and ids["accuracy.live_hard"]["failures"]
    assert live.LAST is not None and len(live.LAST.outcomes) == len(__import__("evals.accuracy", fromlist=["load"]).load("live_questions.jsonl"))
    c = cost.run_live()
    assert c["status"] == "ok" and c["metrics"][0]["id"] == "cost_live.per_request_usd"
    p = performance.run_live()
    assert p["status"] in ("ok", "not_run")
    assert p["status"] == "ok" or "20 output tokens" in p["reason"], "an empty live row must say why"


def test_the_live_run_stops_at_its_budget_and_says_so():
    result = _live_stand_in(0.02)
    assert result["status"] == "ok"
    d = result["details"]
    assert 0 < d["questions_run"] < 30 and d["stopped"], "the cap must end the run early and state it"
    assert d["spent_usd"] <= 0.02 + 0.02, "overshoot is bounded by the call that was in flight"
    how = result["metrics"][0]["how"]
    assert "STOPPED" in how and "budget" in how


def test_a_timing_rule_cannot_block_ci(monkeypatch):
    # 15.10: loop lag 267 ms on a shared GitHub runner (limit 250) failed a deploy.
    from evals import report
    rule = {"op": "<=", "target": 50, "fail": 250, "timing": True}
    monkeypatch.setenv("CI", "true")
    assert report.judge(267, rule) == report.YELLOW
    monkeypatch.delenv("CI")
    assert report.judge(267, rule) == report.RED


def test_a_logic_rule_still_blocks_ci(monkeypatch):
    from evals import report
    monkeypatch.setenv("CI", "true")
    assert report.judge(0.2, {"op": "<=", "target": 0.0, "fail": 0.0}) == report.RED
