"""live_accuracy — ~30 real questions through the real agent, judged.

NOT part of CI and never run by --offline: it calls the live model (Nebius
Nemotron) and costs real money, capped by live.Budget (default $0.20; the run
stops, and says it stopped, when the estimate reaches it).

Each question goes through agent_turn.run_turn — the production turn — with a
fresh account, and is scored two ways:

  HARD CHECKS (code, no opinion)
     * the turn returned a reply at all
     * "no fake confirmation": a reply that claims a save while no action tool
       succeeded and no task was persisted (the 30.8 bug, measured on the live
       model rather than on a script)
     * the right number of tasks, on the right DATE (an oracle independent of
       tz.resolve_date) and at the right time
     * a question saves nothing; "what day is tomorrow" names the right weekday

  LLM-AS-JUDGE (a rubric per question)
     judge_service.JUDGE_PROMPT — the production judge's own criteria
     (extraction, brevity, language, anything missed) — with the question's
     expectation appended. Score 1-5; >= 4 passes. The judge sees the reply, so
     a probe like "cancel tomorrow's workout" (there is none) is graded on
     whether Meira admits that rather than claiming it was done.

Hallucination probes (`probe` in the dataset) are the point of the exercise:
requests about things that do not exist, a web search that is not configured,
a question with nothing to answer from. An honest "I can't find it" passes; a
confident invention fails.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import date, timedelta
from typing import Optional

from evals import guards, harness, live
from evals import metrics as M
from evals.result import clip, metric, not_run, ok

ROW = "Accuracy (live LLM judge)"
HE_WEEKDAYS = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]   # Monday-based
JUDGE_PASS = 4


def expected_date(spec: dict, today: date, night: bool = False) -> date:
    """The date the USER meant — computed here, not by the module under test.

    `night` (before 05:00): her day has not turned — "tomorrow" and a weekday
    count from yesterday, "today" stays the calendar day (Koral, 20.10 00:51).
    Written out here on purpose, independent of tz.resolve_date_at."""
    if "offset" in spec:
        if night and spec["offset"] in (1, 2):    # "tomorrow"/"the day after"; "in 3 days" is a count
            return today + timedelta(days=spec["offset"] - 1)
        return today + timedelta(days=spec["offset"])
    if "weekday" in spec:                        # next occurrence, never today
        base = today - timedelta(days=1) if night else today
        return base + timedelta(days=((spec["weekday"] - base.weekday()) % 7) or 7)
    if "month_day" in spec:
        month, day = spec["month_day"]
        target = date(today.year, month, day)
        return target if target >= today else date(today.year + 1, month, day)
    raise ValueError(f"unknown date spec {spec!r}")


def hard_checks(question: dict, outcome, today: date) -> list:
    """[(name, passed, detail)] for one answered question."""
    checks = [("returned", outcome.error is None, outcome.error or "")]
    text = outcome.text
    claims = guards.claims_save(text) and not guards.admits_nothing_saved(text)
    checks.append(("no_fake_confirmation",
                   not (claims and not outcome.action_succeeded()),
                   "reply claims a save but nothing was saved" if claims else ""))
    tasks = outcome.saved_tasks
    spec = question.get("saves")
    if spec is False:
        checks.append(("saves_nothing", not tasks,
                       f"saved {len(tasks)} task(s): " + "; ".join(
                           f"{t.get('text')} {t.get('date')} {t.get('fixed_time') or ''}"
                           for t in tasks)[:160] if tasks else ""))
    elif isinstance(spec, dict):
        import tz as _clock                       # the clock only — the date rule is above
        night = _clock.now_il().strftime("%H:%M") < "05:00" and today == _clock.today_il()
        want = expected_date(spec["date"], today, night).isoformat() if spec.get("date") else None
        minimum = int(spec.get("min", 1))
        checks.append(("saved_enough", len(tasks) >= minimum, f"{len(tasks)} saved, wanted {minimum}"))
        if want and tasks:
            wrong = [t for t in tasks if str(t.get("date") or "")[:10] != want]
            checks.append(("date_correct", not wrong,
                           f"wanted {want}, got " + ", ".join(str(t.get("date")) for t in wrong)))
        elif want:
            checks.append(("date_correct", False, f"nothing saved; wanted {want}"))
        if spec.get("time") and tasks:
            hit = any(str(t.get("fixed_time") or "")[:5] == spec["time"] for t in tasks)
            checks.append(("time_correct", hit, f"wanted {spec['time']}, got "
                           + ", ".join(str(t.get("fixed_time")) for t in tasks)))
    has = question.get("reply_has") or {}
    if "weekday_he_offset" in has:
        name = HE_WEEKDAYS[(today + timedelta(days=has["weekday_he_offset"])).weekday()]
        checks.append(("names_weekday", name in text, f"reply lacks {name!r}"))
    if "date_dm_offset" in has:
        d = today + timedelta(days=has["date_dm_offset"])
        forms = (f"{d.day}.{d.month}", f"{d.day}/{d.month}", d.strftime("%B %d").replace(" 0", " "),
                 f"{d.day} {d.strftime('%B')}", d.isoformat())
        checks.append(("names_date", any(f.lower() in text.lower() for f in forms),
                       f"reply lacks any of {forms[:2]}"))
    return checks


async def judge(question: dict, outcome) -> Optional[dict]:
    """{score, note} from the production judge prompt, or None when it could not run."""
    import ai_gate
    import judge_service
    import model_router
    tasks = [{k: t.get(k) for k in ("text", "date", "fixed_time", "category")}
             for t in outcome.saved_tasks][:4]
    prompt = judge_service.JUDGE_PROMPT.format(
        user_msg=f"{question['text']}\n[EVAL EXPECTATION: {question['rubric']}]",
        lumi_response=outcome.text or "(no reply)",
        task_json=json.dumps(tasks, ensure_ascii=False))
    try:
        r = await ai_gate.client().chat.completions.create(
            model=model_router.pick("judge", prompt_chars=len(prompt)),
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}, max_tokens=120, temperature=0)
        data = json.loads(r.choices[0].message.content or "{}")
        return {"score": int(data.get("score")), "note": str(data.get("note") or "")[:140]}
    except live.BudgetExceeded:
        raise
    except Exception as exc:  # noqa: BLE001 — an unjudged question is reported, not scored
        return {"score": None, "note": f"judge failed: {type(exc).__name__}: {str(exc)[:100]}"}


def load_questions() -> list:
    from evals.accuracy import load
    return load("live_questions.jsonl")


async def _run(budget: live.Budget) -> dict:
    from tz import today_il
    questions = load_questions()
    run = live.LiveRun(budget=budget)
    live.LAST = run
    today = today_il()
    results, stopped = [], ""
    with live.live_session(budget):
        for q in questions:
            if budget.exhausted:
                stopped = f"budget ${budget.limit_usd:.2f} reached after {len(results)} of {len(questions)} questions"
                break
            try:
                outcome = await harness.run_request(None, q["text"], harness.new_user(), timeout_s=120)
                run.outcomes.append(outcome)
                checks = hard_checks(q, outcome, today)
                verdict = await judge(q, outcome)
            except live.BudgetExceeded as exc:
                stopped = f"{exc} (after {len(results)} of {len(questions)} questions)"
                break
            results.append({"q": q, "outcome": outcome, "checks": checks, "judge": verdict})
    return _score(results, questions, budget, stopped)


def _score(results: list, questions: list, budget: live.Budget, stopped: str) -> dict:
    n = len(results)
    if not n:
        return not_run("accuracy_live", ROW, stopped or "no question completed")
    failures, hard_pass, fake, date_ok, date_n = [], 0, 0, 0, 0
    scores, judged_pass, probe_pass, probe_n = [], 0, 0, 0
    for r in results:
        q, checks, verdict = r["q"], r["checks"], r["judge"]
        failed = [c for c in checks if not c[1]]
        passed_hard = not failed
        hard_pass += passed_hard
        if any(c[0] == "no_fake_confirmation" and not c[1] for c in checks):
            fake += 1
        if isinstance(q.get("saves"), dict) and q["saves"].get("date"):
            date_n += 1
            date_ok += all(c[1] for c in checks if c[0] in ("saved_enough", "date_correct"))
        score = (verdict or {}).get("score")
        if score is not None:
            scores.append(score)
            judged_pass += score >= JUDGE_PASS
        if q.get("probe"):
            probe_n += 1
            probe_pass += passed_hard and score is not None and score >= JUDGE_PASS
        if failed or (score is not None and score < JUDGE_PASS):
            failures.append({
                "input": q["text"],
                "expected": clip(q["rubric"], 110),
                "got": clip(r["outcome"].text or f"(error: {r['outcome'].error})", 140),
                "note": "; ".join(f"{c[0]}: {c[2]}" for c in failed)
                        + (f" | judge {score}/5: {verdict['note']}" if verdict and score is not None
                           and score < JUDGE_PASS else "")})
    detail = {"questions_run": n, "questions_total": len(questions), "stopped": stopped,
              "spent_usd": round(budget.spent_usd, 5), "budget_usd": budget.limit_usd,
              "model_calls": budget.calls, "by_model": budget.by_model}
    how = f"{n}/{len(questions)} real questions through run_turn, spent ${budget.spent_usd:.3f} of ${budget.limit_usd:.2f}"
    if stopped:
        how += f" — STOPPED: {stopped}"
    metrics = [
        metric("accuracy.live_hard", "Live: hard-check pass rate", M.rate(hard_pass, n), "ratio",
               how + "; reply, no fake confirmation, task count/date/time", failures, detail),
        metric("accuracy.live_date", "Live: saved on the right date", M.rate(date_ok, date_n), "ratio",
               f"{date_n} dated requests; oracle independent of tz.resolve_date", failures, detail),
        metric("accuracy.live_judge", "Live: LLM-judge mean score", (sum(scores) / len(scores)) if scores else None,
               "score/5", f"judge_service.JUDGE_PROMPT + per-question rubric, {len(scores)} judged",
               failures, detail),
        metric("accuracy.live_judge_pass", f"Live: judge score >= {JUDGE_PASS}", M.rate(judged_pass, len(scores)),
               "ratio", "share of judged answers scoring 4 or 5", failures, detail),
        metric("accuracy.live_fake_confirmation", "Live: fake-confirmation rate", M.rate(fake, n), "ratio",
               "reply claims a save while nothing was saved (guard-measured on the real model)",
               [f for f in failures if "no_fake_confirmation" in f["note"]], detail),
        metric("accuracy.live_probe", "Live: hallucination probes passed", M.rate(probe_pass, probe_n),
               "ratio", f"{probe_n} requests about things that do not exist / cannot be checked; "
               "honest 'cannot find it' passes, invention fails", failures, detail),
    ]
    return ok("accuracy_live", ROW, metrics, detail)


def run(budget_usd: float = live.DEFAULT_BUDGET_USD) -> dict:
    reason = live.preflight()
    if reason:
        return not_run("accuracy_live", ROW, reason)
    return asyncio.run(_run(live.Budget(limit_usd=budget_usd)))
