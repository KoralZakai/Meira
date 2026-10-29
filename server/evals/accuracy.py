"""accuracy — are the answers right? Dataset + ground truth, by task.

OFFLINE (CI, free, deterministic) — the parts of Meira that are CODE, not model,
scored against hand-labelled ground truth in evals/datasets/*.jsonl:

    dates       tz.resolve_date and agent_turn.override_task_date
                (the model is never allowed to derive a date; this is the rule
                that stops it) — plain accuracy
    categories  categorize.infer — accuracy, macro precision/recall/F1 per
                label, the rate at which the table is CONFIDENTLY WRONG, and
                priority accuracy
    intents     task_intent.classify — accuracy and macro-F1
    clashes     clashes.resolve_clashes against tests/fixtures/clash-golden.json
                (generated from the TypeScript the phone runs) — precision /
                recall / F1 of the clash set, and the kind of each

The ground truth was written BEFORE the code was run and is deliberately not
tuned to it: where a module is wrong (e.g. "brunch" contains "run"), the example
is kept and shows up as a failure. The threshold is then set just under the
measured value (thresholds.json), so the suite is a ratchet: it fails if a
change makes any of this worse, and the failing examples say what to fix.

LIVE (--live only, never CI) — ~30 real agent questions through
agent_turn.run_turn against the real model, scored by hard checks (the task was
saved on the right date; no confirmation without a save) AND an LLM-as-judge
rubric. A hard dollar cap stops the run.
"""
from __future__ import annotations

import json
import os
from datetime import date
from unittest import mock

from evals import metrics as M
from evals.env import REPO_ROOT
from evals.result import clip, metric, not_run, ok

DATASETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datasets")
TODAY = date(2026, 10, 15)          # a Thursday; every date in dates.jsonl is relative to it
ROW = "Accuracy"


def load(name: str) -> list:
    with open(os.path.join(DATASETS, name), encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


# ── dates ───────────────────────────────────────────────────────────────────

def _score_dates() -> dict:
    import tz
    assert TODAY.strftime("%A") == "Thursday", "the dates ground truth assumes a Thursday"
    rows = load("dates.jsonl")
    import agent_turn
    truths, preds, failures = [], [], []
    by_kind: dict = {"resolve": [0, 0], "override": [0, 0], "night": [0, 0], "night_task": [0, 0]}
    import datetime as _dt
    import understand
    with mock.patch.object(tz, "today_il", lambda: TODAY):
        for row in rows:
            if row["kind"] == "resolve":
                got = tz.resolve_date(row["input"], TODAY)
                got = got.isoformat() if got else None
                shown = row["input"]
            elif row["kind"] in ("night", "night_task"):
                # Her hour matters (20.10, 00:51): the clock is part of the case.
                hh, mm = (int(x) for x in row["now"].split(":"))
                at = _dt.datetime.combine(TODAY, _dt.time(hh, mm), tzinfo=tz.now_il().tzinfo)
                with mock.patch.object(tz, "now_il", lambda: at):
                    if row["kind"] == "night":
                        got = tz.resolve_date_at(row["input"], TODAY)
                        got = got.isoformat() if got else None
                        shown = f'{row["input"]}  [at {row["now"]}]'
                    else:
                        task = understand.task_from(row["action"], row["message"], TODAY)
                        got = (task or {}).get("date")
                        shown = f'{row["message"]}  [at {row["now"]}, model said {row["action"].get("date_expression")}]'
            else:
                task = {"text": "x", "date": row["model_date"]}
                fixed = agent_turn.override_task_date(task, row["message"])
                got = fixed.get("date")
                shown = f'{row["message"]}  [model said {row["model_date"]}]'
            truths.append(row["expected"])
            preds.append(got)
            by_kind[row["kind"]][1] += 1
            if got == row["expected"]:
                by_kind[row["kind"]][0] += 1
            else:
                failures.append({"input": shown, "expected": row["expected"], "got": got,
                                 "note": row.get("note", "")})
    return {"accuracy": M.accuracy(truths, preds), "n": len(rows), "failures": failures,
            "by_kind": {k: {"correct": c, "n": n, "accuracy": M.rate(c, n)}
                        for k, (c, n) in by_kind.items()}}


# ── categories / priority ───────────────────────────────────────────────────

def _score_categories() -> dict:
    import categorize
    rows = load("categories.jsonl")
    truth, pred, matched, failures = [], [], [], []
    pri_truth, pri_pred, pri_failures = [], [], []
    for row in rows:
        got = categorize.infer(row["text"])
        truth.append(row["category"])
        pred.append(got["category"])
        matched.append(got["matched"])
        if got["category"] != row["category"]:
            failures.append({
                "input": row["text"], "expected": row["category"], "got": got["category"],
                "note": "table fired and was WRONG" if got["matched"]
                        else "table had no opinion (the model fills this one in production)"})
        if "priority" in row:
            pri_truth.append(row["priority"])
            pri_pred.append(got["priority"])
            if got["priority"] != row["priority"]:
                pri_failures.append({"input": row["text"], "expected": row["priority"],
                                     "got": got["priority"]})
    stats = M.prf(truth, pred)
    fired = [(t, p) for t, p, m in zip(truth, pred, matched) if m]
    confident_wrong = [f for f in failures if f["note"].startswith("table fired")]
    return {
        "accuracy": stats["accuracy"], "macro": stats["macro"], "labels": stats["labels"],
        "n": len(rows),
        "coverage": M.rate(sum(matched), len(matched)),
        "precision_when_fired": M.accuracy([t for t, _ in fired], [p for _, p in fired]),
        "confident_wrong_rate": M.rate(len(confident_wrong), len(rows)),
        "confident_wrong": confident_wrong,
        "failures": failures,
        "priority_accuracy": M.accuracy(pri_truth, pri_pred), "priority_n": len(pri_truth),
        "priority_failures": pri_failures,
    }


# ── intents ─────────────────────────────────────────────────────────────────

def _score_intents() -> dict:
    import task_intent
    rows = load("intents.jsonl")
    truth, pred, failures = [], [], []
    for row in rows:
        got = task_intent.classify(row["text"], row.get("mode", "capture"))
        truth.append(row["expected"])
        pred.append(got)
        if got != row["expected"]:
            failures.append({"input": row["text"], "expected": row["expected"], "got": got,
                             "note": row.get("note", "")})
    stats = M.prf(truth, pred)
    return {"accuracy": stats["accuracy"], "macro": stats["macro"], "labels": stats["labels"],
            "n": len(rows), "failures": failures}


# ── clashes ─────────────────────────────────────────────────────────────────

def _score_clashes():
    """-> dict, or a reason string when the fixtures are not in this checkout."""
    days_path = os.path.join(REPO_ROOT, "tests", "fixtures", "clash-days.json")
    golden_path = os.path.join(REPO_ROOT, "tests", "fixtures", "clash-golden.json")
    for path in (days_path, golden_path):
        if not os.path.exists(path):
            return f"fixture missing: {os.path.relpath(path, REPO_ROOT)}"
    import clashes
    with open(days_path, encoding="utf-8") as handle:
        days = json.load(handle)["days"]
    with open(golden_path, encoding="utf-8") as handle:
        golden = json.load(handle)
    if len(days) != len(golden):
        return f"fixtures and golden disagree ({len(days)} days vs {len(golden)})"
    truth, predicted, failures, kind_ok, kind_n = set(), set(), [], 0, 0
    for day, want in zip(days, golden):
        got = clashes.resolve_clashes(day["tasks"], day["dayEnd"])
        want_pairs = {(day["name"], c["a"], c["b"]): c["kind"] for c in want["clashes"]}
        got_pairs = {(day["name"], c["a"]["id"], c["b"]["id"]): c["kind"] for c in got}
        truth |= set(want_pairs)
        predicted |= set(got_pairs)
        for key, kind in want_pairs.items():
            kind_n += 1
            if got_pairs.get(key) == kind:
                kind_ok += 1
            else:
                failures.append({"input": f"{key[0]}: {key[1]} x {key[2]}",
                                 "expected": kind, "got": got_pairs.get(key, "(no clash found)")})
        for key in set(got_pairs) - set(want_pairs):
            failures.append({"input": f"{key[0]}: {key[1]} x {key[2]}",
                             "expected": "(no clash)", "got": got_pairs[key]})
    stats = M.set_prf(truth, predicted)
    return {"stats": stats, "kind_accuracy": M.rate(kind_ok, kind_n), "days": len(days),
            "clashes": len(truth), "failures": failures}


# ── regressions: every bug that reached Koral, kept fixed ────────────────────

def _score_regressions() -> dict:
    """Golden set of past bugs (datasets/regressions.jsonl): each row names the day it hurt,
    the input that did it, and what must come out. The set only grows — a fixed bug that
    breaks again turns accuracy.regression red. The TypeScript half of the same bugs
    (arrival dates, address in title, way home, held moves) is pinned by tests/run-*.ts."""
    import tempfile
    rows = load("regressions.jsonl")
    failures, passed = [], 0
    for row in rows:
        kind, got = row["kind"], None
        try:
            if kind in ("app_edit_title", "chat_remention_title"):
                import user_memory
                with tempfile.TemporaryDirectory() as tmp:
                    old_path = user_memory._PATH
                    user_memory._PATH = os.path.join(tmp, "m.json")
                    try:
                        first = user_memory.add_task("0500000000", {"text": row["old"], "date": "2026-10-21"})
                        got = user_memory.add_task(
                            "0500000000", {"id": first["id"], "text": row["new"], "date": "2026-10-21"},
                            trust_status=(kind == "app_edit_title"))["text"]
                    finally:
                        user_memory._PATH = old_path
            elif kind == "routine_lines":
                import routine_text
                got = routine_text.canonical_lines(row["text"])
            elif kind == "routine_hours":
                import routine_text
                got = routine_text.read_hours(row["text"])
            elif kind == "reschedule":
                import reschedule
                move = reschedule.find_move(row["text"], row["tasks"], date.fromisoformat(row["today"]))
                got = {"id": move["task"]["id"], "date": move["new_date"]} if move else None
            elif kind == "chosen_mode":
                import daychain
                got = daychain.chosen_mode(row["row"])
            elif kind == "rename_patch":
                import understand
                got = understand.patch_from(row["action"])
            elif kind == "brief_company":
                import meeting_brief
                got = meeting_brief.subjects(row["event"])["company"]
            elif kind == "return_later":
                import agent_turn
                got = agent_turn.asks_return_later(row["text"])
            elif kind == "merge_routines":
                import user_profile
                got = user_profile.merge_routine_lines(row["old"], row["new"]).split("\n")
            elif kind == "hollow_title":
                import task_rescue
                got = task_rescue.hollow_title(row["text"])
            else:
                got = f"(unknown kind {kind})"
        except Exception as exc:  # noqa: BLE001 — a crash is a failure, said as one
            got = f"(raised {type(exc).__name__}: {exc})"
        if got == row["expected"]:
            passed += 1
        else:
            failures.append({"input": row["id"] + " " + row["bug"], "expected": row["expected"], "got": got})
    return {"accuracy": M.rate(passed, len(rows)), "n": len(rows), "failures": failures}


# ── the suite ───────────────────────────────────────────────────────────────

def run_offline() -> dict:
    d = _score_dates()
    c = _score_categories()
    i = _score_intents()
    k = _score_clashes()
    g = _score_regressions()

    metrics = [
        metric("accuracy.date", "Date resolution accuracy", d["accuracy"], "ratio",
               f"tz.resolve_date + agent_turn.override_task_date on {d['n']} labelled "
               f"HE/EN expressions, today pinned to {TODAY}", d["failures"],
               {"by_kind": d["by_kind"], "n": d["n"]}),
        metric("accuracy.category", "Category accuracy", c["accuracy"], "ratio",
               f"categorize.infer on {c['n']} HE/EN task texts (unmatched = 'general')",
               c["failures"], {"n": c["n"], "coverage": c["coverage"]}),
        metric("accuracy.category_f1", "Category macro-F1", c["macro"]["f1"], "ratio",
               "unweighted mean of per-label F1 over every category seen in truth or predictions",
               c["failures"], {"macro": c["macro"], "labels": c["labels"]}),
        metric("accuracy.category_confident_wrong", "Category confidently wrong", c["confident_wrong_rate"],
               "ratio", "share of tasks where the keyword table FIRED and chose the wrong category "
               "(the model may not overrule a match — this is the error it cannot repair)",
               c["confident_wrong"],
               {"coverage": c["coverage"], "precision_when_fired": c["precision_when_fired"]}),
        metric("accuracy.priority", "Priority accuracy", c["priority_accuracy"], "ratio",
               f"categorize.infer priority on the {c['priority_n']} rows that carry a priority label",
               c["priority_failures"], {"n": c["priority_n"]}),
        metric("accuracy.intent", "Intent accuracy", i["accuracy"], "ratio",
               f"task_intent.classify on {i['n']} HE/EN check-in sentences", i["failures"],
               {"n": i["n"]}),
        metric("accuracy.intent_f1", "Intent macro-F1", i["macro"]["f1"], "ratio",
               "unweighted mean of per-intent F1", i["failures"],
               {"macro": i["macro"], "labels": i["labels"]}),
    ]
    metrics.append(metric(
        "accuracy.regression", "Past bugs stay fixed (golden set)", g["accuracy"], "ratio",
        f"{g['n']} cases from bugs that reached Koral, each with the input that did it "
        "(datasets/regressions.jsonl) — the set only grows", g["failures"], {"n": g["n"]}))
    if isinstance(k, dict):
        metrics += [
            metric("accuracy.clash_f1", "Clash detection F1", k["stats"]["f1"], "ratio",
                   f"clashes.resolve_clashes vs the TypeScript golden: {k['days']} days, "
                   f"{k['clashes']} true clashes; set precision/recall/F1 over (day, a, b)",
                   k["failures"], {"stats": k["stats"]}),
            metric("accuracy.clash_kind", "Clash kind accuracy", k["kind_accuracy"], "ratio",
                   "the kind (overlap / travel / double / spatial / parallel) of each true clash",
                   k["failures"], {}),
        ]
    else:
        for mid, label in (("accuracy.clash_f1", "Clash detection F1"),
                           ("accuracy.clash_kind", "Clash kind accuracy")):
            metrics.append(metric(mid, label, None, "ratio", f"not run: {k}", [], {"reason": k}))
    return ok("accuracy", ROW, metrics, {"dates": d["by_kind"]})


def run_live(budget_usd: float = 0.20) -> dict:
    """Delegates to evals.live_accuracy so importing this module never needs a key."""
    try:
        from evals import live_accuracy
    except ImportError as exc:     # pragma: no cover
        return not_run("accuracy_live", "Accuracy (live LLM judge)", f"live harness missing: {exc}")
    return live_accuracy.run(budget_usd)
