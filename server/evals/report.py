"""report — run the suites, judge every number against thresholds.json, write
report.json (for machines) and report.md (for the CI summary and for people).

STATUS RULES
    green      meets 'target'
    yellow     worse than target, not yet past 'fail'   (a known gap; examples printed)
    red        worse than 'fail'                        (a regression; fails CI)
    info       no threshold defined for this metric
    not run    the suite or metric could not run, and says WHY

The job fails only on RED, and a suite that CRASHES is red: a harness that
silently stopped measuring is the exact failure mode this project keeps shipping
(CLAUDE.md, the silent-state rule). A suite that merely cannot run here (the
live ones, offline) is "not run" with its reason, listed in the report — never
a green and never hidden.

report.json
    generated_at, mode, git, overall, exit_code,
    matrix[]      one entry per row of the matrix (status = worst of its metrics)
    metrics{}     id -> {label, value, unit, how, threshold, status, failures[], ...}
    suites[]      name, row, status, reason, seconds
    not_run[]     {suite, reason}
    details{}     per-suite extras (per-tool latencies, ramp steps, ...)
"""
from __future__ import annotations

import json
import logging
import math
import os
import subprocess
import time
from datetime import datetime, timezone
from typing import Callable, Optional

from evals import SUITES
from evals import result as R

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
THRESHOLDS = os.path.join(HERE, "thresholds.json")

GREEN, YELLOW, RED, INFO, NOT_RUN = "green", "yellow", "red", "info", "not_run"
_SEVERITY = {GREEN: 0, INFO: 0, NOT_RUN: 0, YELLOW: 1, RED: 2}

#: The matrix: row name, the metrics that summarise it (id, short name), what the row measures.
ROWS = [
    ("Accuracy", [("accuracy.date", "dates"), ("accuracy.category", "category"),
                  ("accuracy.intent", "intent"), ("accuracy.clash_f1", "clash F1")],
     "Deterministic modules vs hand-labelled ground truth (dates, categories, intents, clashes)"),
    ("Accuracy (live LLM judge)", [("accuracy.live_hard", "hard checks"), ("accuracy.live_judge", "judge"),
                                   ("accuracy.live_fake_confirmation", "fake confirmations")],
     "~30 real questions through the real model, hard checks + LLM-as-judge (weekly, capped spend)"),
    ("Reliability", [("reliability.baseline_error_rate", "error rate"), ("reliability.success_rate", "recovered"),
                     ("reliability.hallucination_rate", "hallucination"), ("reliability.graceful_rate", "graceful")],
     "Scripted model + injected tool / model / API faults; lying-model cases"),
    ("Performance", [("performance.request_p95_ms", "request p95"), ("performance.overhead_p95_ms", "our overhead p95"),
                     ("performance.throughput_rps", "throughput"), ("performance.live_tokens_per_s", "tokens/s")],
     "Latency percentiles with the model fixed at 300 ms, so what remains is ours"),
    ("Scalability", [("scalability.p95_ratio_10x", "p95 at 10x"), ("scalability.throughput_ratio_10x", "throughput at 10x"),
                     ("scalability.people_at_peak", "people/machine"),
                     ("scalability.storage_ms_per_1000_users", "store ms per 1000 users"),
                     ("scalability.scale_out_blockers", "scale-out blockers")],
     "Concurrency ramp 1/5/10/50 over the real ASGI app, store growth, scale-out inspection"),
    ("Cost", [("cost.per_request_usd", "per request"), ("cost.per_saved_task_usd", "per saved task"),
              ("cost.per_user_day_usd", "per person-day"), ("cost.allowance_used", "of $ allowance"),
              ("cost.runway_days", "runway days")],
     "Tokens x PRICES + outside-API calls + CPU, against the per-person allowance"),
    ("RAG quality", [("rag.recall_at_5", "Recall@5"), ("rag.mrr", "MRR"), ("rag.block_recall", "in prompt")],
     "memory_recall retrieval on 30 synthetic facts / 20 questions (offline: lexical stand-in embedder)"),
]


def row_of(metric_id: str) -> str:
    """Which matrix row a metric id belongs to."""
    if metric_id.startswith("accuracy.live"):
        return "Accuracy (live LLM judge)"
    prefix = metric_id.split(".", 1)[0]
    return {"accuracy": "Accuracy", "reliability": "Reliability", "performance": "Performance",
            "scalability": "Scalability", "cost": "Cost", "cost_live": "Cost", "rag": "RAG quality",
            "rag_live": "RAG quality"}.get(prefix, prefix)


# ── thresholds ──────────────────────────────────────────────────────────────

def load_thresholds(path: str = THRESHOLDS) -> dict:
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def judge(value: Optional[float], rule: Optional[dict]) -> str:
    """green / yellow / red / info / not_run for one value against one rule."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return NOT_RUN
    if not rule:
        return INFO
    op, target, fail = rule["op"], rule["target"], rule["fail"]
    if op == ">=":
        status = GREEN if value >= target else (RED if value < fail else YELLOW)
    elif op == "<=":
        status = GREEN if value <= target else (RED if value > fail else YELLOW)
    else:
        raise ValueError(f"unknown op {op!r}")
    # A clock measured on a shared CI runner is noise, not a regression: on
    # 15.10 loop lag read 267 ms on GitHub (limit 250) and blocked a deploy
    # that changed no timing at all. On CI a "timing" rule can warn, never
    # block; logic rules (errors, hallucinations, accuracy) still do.
    if status == RED and rule.get("timing") and os.environ.get("CI") == "true":
        return YELLOW
    return status


def worst(statuses: list) -> str:
    real = [s for s in statuses if s in (GREEN, YELLOW, RED)]
    if not real:
        return NOT_RUN if NOT_RUN in statuses else INFO
    return max(real, key=lambda s: _SEVERITY[s])


# ── formatting ──────────────────────────────────────────────────────────────

def fmt(value: Optional[float], unit: str) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    if unit == "ratio":
        return f"{value * 100:.1f}%"
    if unit == "ms":
        return f"{value:.0f} ms"
    if unit == "us":
        return f"{value:.0f} us"
    if unit == "usd":
        return f"${value:.4f}"
    if unit == "x":
        return f"{value:.2f}x"
    if unit == "req/s":
        return f"{value:.1f} req/s"
    if unit == "tok/s":
        return f"{value:.0f} tok/s"
    if unit == "days":
        return f"{value:.0f} days" if value < 1e6 else "no limit"
    if unit == "score/5":
        return f"{value:.2f}/5"
    if unit == "count":
        return f"{value:.0f}"
    return f"{value:g}"


def fmt_threshold(rule: Optional[dict], unit: str) -> str:
    if not rule:
        return "-"
    op = "\u2265" if rule["op"] == ">=" else "\u2264"
    return f"{op} {fmt(rule['target'], unit)} (red {'<' if rule['op'] == '>=' else '>'} {fmt(rule['fail'], unit)})"


def fmt_goal(rule: Optional[dict], unit: str) -> str:
    if not rule:
        return "-"
    return f"{chr(0x2265) if rule['op'] == '>=' else chr(0x2264)} {fmt(rule['target'], unit)}"


def _cell(text: object, limit: int = 240) -> str:
    out = str(text).replace("|", "\\|").replace("\n", " ").replace("\r", " ").strip()
    return out if len(out) <= limit else out[: limit - 1] + "\u2026"


def _example(m: dict) -> str:
    if not m.get("failures"):
        return ""
    f = m["failures"][0]
    extra = f" (+{m['failures_total'] - 1} more)" if m.get("failures_total", 0) > 1 else ""
    got = f.get("got")
    note = f" \u2014 {f['note']}" if f.get("note") else ""
    return f"{f.get('input')} \u2192 {got} (expected {f.get('expected')}){note}{extra}"


# ── building ────────────────────────────────────────────────────────────────

def _git() -> dict:
    def run(*args):
        try:
            return subprocess.run(["git", *args], cwd=HERE, capture_output=True, text=True,
                                  timeout=5).stdout.strip() or None
        except Exception:  # noqa: BLE001 — provenance is a nicety, never a failure
            return None
    return {"sha": run("rev-parse", "--short", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD")}


def build(suites: list, mode: str, thresholds: Optional[dict] = None, seconds: Optional[dict] = None) -> dict:
    thresholds = load_thresholds() if thresholds is None else thresholds
    seconds = seconds or {}
    metrics: dict = {}
    not_run: list = []
    crashed: list = []
    for s in suites:
        if s["status"] == "not_run":
            not_run.append({"suite": s["name"], "row": s["row"], "reason": s["reason"]})
        elif s["status"] == "error":
            crashed.append({"suite": s["name"], "row": s["row"], "reason": s["reason"]})
        for m in s["metrics"]:
            rule = thresholds.get(m["id"])
            status = judge(m["value"], rule)
            entry = {**m, "row": s["row"], "suite": s["name"], "threshold": rule, "status": status}
            if status == NOT_RUN:
                reason = m.get("detail", {}).get("reason") or m.get("how", "")
                entry["reason"] = reason
                not_run.append({"suite": m["id"], "row": s["row"], "reason": reason})
            metrics[m["id"]] = entry

    matrix = []
    for row, keys, what in ROWS:
        members = [m for m in metrics.values() if row_of(m["id"]) == row]
        suite_errors = [c for c in crashed if c["row"] == row]
        statuses = [m["status"] for m in members] + ([RED] if suite_errors else [])
        row_not_run = [n for n in not_run if n["row"] == row]
        status = worst(statuses) if statuses else NOT_RUN
        shown, rules = [], []
        for mid, short in keys:
            m = metrics.get(mid)
            if m is None or m["value"] is None:
                shown.append(f"{short} not run")
                continue
            shown.append(f"{short} {fmt(m['value'], m['unit'])}")
            if thresholds.get(mid):
                rules.append(f"{short} {fmt_goal(thresholds[mid], m['unit'])}")
        ranked = sorted((m for m in members if m.get("failures") and m["status"] in (YELLOW, RED)),
                        key=lambda m: -_SEVERITY.get(m["status"], 0))
        matrix.append({
            "row": row, "what": what, "status": status, "summary": " \u00b7 ".join(shown),
            "thresholds": " \u00b7 ".join(rules),
            "metrics": [m["id"] for m in members],
            "worst_example": _example(ranked[0]) if ranked else "",
            "not_run": [n["reason"] for n in row_not_run][:3],
            "crashed": [c["reason"] for c in suite_errors],
        })

    overall_status = worst([r["status"] for r in matrix if r["status"] != NOT_RUN]
                           + [RED for _ in crashed])
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "mode": mode, "git": _git(), "overall": overall_status if overall_status in (GREEN, YELLOW, RED) else GREEN,
        "exit_code": 1 if overall_status == RED else 0,
        "matrix": matrix, "metrics": metrics,
        "suites": [{"name": s["name"], "row": s["row"], "status": s["status"], "reason": s["reason"],
                    "seconds": seconds.get(s["name"])} for s in suites],
        "not_run": not_run, "crashed": crashed,
        "details": {s["name"]: s["details"] for s in suites if s["details"]},
    }


# ── markdown ────────────────────────────────────────────────────────────────

_BADGE = {GREEN: "GREEN", YELLOW: "YELLOW", RED: "RED", INFO: "info", NOT_RUN: "NOT RUN"}


def render_markdown(report: dict) -> str:
    out = [f"## Meira evaluation matrix - {report['mode']} - overall **{_BADGE[report['overall']]}**", "",
           f"_{report['generated_at']} - {report['git'].get('branch') or '?'}@{report['git'].get('sha') or '?'}_", "",
           "| Metric | How measured | Value | Threshold | Status | Example failure |",
           "|---|---|---|---|---|---|"]
    for r in report["matrix"]:
        example = r["worst_example"] or ("; ".join(r["crashed"]) or "")
        out.append(f"| **{r['row']}** | {_cell(r['what'], 160)} | {_cell(r['summary'], 220)} | "
                   f"{_cell(r['thresholds'] or '-', 260)} | **{_BADGE[r['status']]}** | {_cell(example, 300)} |")
    out += ["", "_Threshold: goal (red when worse than the bracketed line). Yellow = a known gap, with the failing "
            "example shown; red = a regression and fails CI._", ""]

    gaps = [(m, _example(m)) for m in report["metrics"].values() if m["status"] in (YELLOW, RED) and m.get("failures")]
    out += ["### Every metric", "", "| Metric | Value | Threshold | Status |", "|---|---|---|---|"]
    for mid, m in report["metrics"].items():
        out.append(f"| `{mid}` {m['label']} | {fmt(m['value'], m['unit'])} | "
                   f"{_cell(fmt_threshold(m['threshold'], m['unit']))} | {_BADGE[m['status']]} |")

    if gaps:
        out += ["", "### Failing examples (input \u2192 outcome)", ""]
        for m, _ in sorted(gaps, key=lambda g: -_SEVERITY[g[0]["status"]]):
            out.append(f"**{m['label']}** (`{m['id']}`, {_BADGE[m['status']]}, {m.get('failures_total', 0)} total)")
            for f in m["failures"][:4]:
                note = f" \u2014 {_cell(f['note'], 200)}" if f.get("note") else ""
                out.append(f"- `{_cell(f.get('input'), 110)}` \u2192 {_cell(f.get('got'), 130)} "
                           f"(expected {_cell(f.get('expected'), 110)}){note}")
            out.append("")

    steps = report["details"].get("scalability", {}).get("steps")
    if steps:
        out += ["### Scalability ramp", "", "| Concurrent users | Requests | Throughput | p50 | p95 | p99 | Errors | "
                "Loop lag p95 | CPU/request | Time in model / outside APIs / stores / ours |", "|---|---|---|---|---|---|---|---|---|---|"]
        for s in steps:
            sh = s["share"]
            out.append(f"| {s['concurrency']} | {s['requests']} | {s['throughput_rps']:.1f} req/s | "
                       f"{s['latency']['p50_ms']:.0f} ms | {s['latency']['p95_ms']:.0f} ms | {s['latency']['p99_ms']:.0f} ms | "
                       f"{s['error_rate'] * 100:.1f}% | {s['loop_lag_p95_ms']:.0f} ms | {s['cpu_ms_per_request']:.0f} ms | "
                       f"{sh['model'] * 100:.0f}% / {sh['external'] * 100:.0f}% / {sh['storage'] * 100:.0f}% / {sh['ours'] * 100:.0f}% |")
        det = report["details"]["scalability"]
        out += ["", f"**Bottleneck:** {det['bottleneck']}.", ""]
        rows = det["storage"]["rows"]
        out += ["Per-turn store time as the JSON stores grow (every turn rewrites whole files, synchronously):", "",
                "| Users stored | Store time p50 | p95 | conversations.json | user_memory.json |", "|---|---|---|---|---|"]
        for r in rows:
            out.append(f"| {r['users_in_store']} | {r['turn_store_ms_p50']:.1f} ms | {r['turn_store_ms_p95']:.1f} ms | "
                       f"{r['conversations_kb']:.0f} KB | {r['user_memory_kb']:.0f} KB |")
        out += ["", "Scale-out checks (can a second instance be added?):", ""]
        out += [f"- {'OK' if c['ok'] else 'BLOCKER'} `{c['name']}` - {c['why']}" for c in det["scale_out"]["checks"]]
        cap = det["capacity_model"]
        glob = [x for x in det["rate_limits"] if x["scope"] == "global"]
        per_id = [x for x in det["rate_limits"] if x["scope"] == "per-identity"]
        out += ["", f"Capacity model: one machine serves about {cap['people_at_peak']} people before the JSON stores "
                    f"serialise it ({cap['assumptions']}); {cap['free_seats_today']} seats today.", "",
                "Rate limits (rate_limit.py): " + "; ".join(
                    f"{x['limit']} {x['per']} = {x['rps']:.1f} req/s" for x in glob)
                + " - a hard cap on that door's TOTAL throughput; per-account limits ("
                + ", ".join(f"{x['limit'].split(' per ')[0]} {x['per']}" for x in per_id)
                + ") only ever stop one noisy caller, and none was hit in the ramp.", ""]

    if report["not_run"] or report["crashed"]:
        out += ["### Not run / crashed (never a silent green)", ""]
        out += [f"- **{n['suite']}** ({n['row']}): {_cell(n['reason'], 300)}" for n in report["not_run"]]
        out += [f"- **CRASHED {c['suite']}** ({c['row']}): {_cell(c['reason'], 300)}" for c in report["crashed"]]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def write(report: dict, out_dir: str = OUT_DIR) -> tuple:
    os.makedirs(out_dir, exist_ok=True)
    json_path, md_path = os.path.join(out_dir, "report.json"), os.path.join(out_dir, "report.md")
    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, default=str)
    with open(md_path, "w", encoding="utf-8") as handle:
        handle.write(render_markdown(report))
    return json_path, md_path


# ── running ─────────────────────────────────────────────────────────────────

def _offline_suites() -> list:
    from evals import accuracy, cost, performance, rag, reliability, scalability
    return [("accuracy", accuracy.run_offline, "Accuracy"), ("reliability", reliability.run, "Reliability"),
            ("performance", performance.run, "Performance"), ("scalability", scalability.run, "Scalability"),
            ("cost", cost.run, "Cost"), ("rag", rag.run, "RAG quality")]


def _live_suites(budget: float) -> list:
    from evals import cost, live_accuracy, performance, rag
    return [("accuracy_live", lambda: live_accuracy.run(budget), "Accuracy (live LLM judge)"),
            ("performance_live", performance.run_live, "Performance"),
            ("cost_live", cost.run_live, "Cost"), ("rag_live", rag.run_live, "RAG quality")]


def run_suites(live: bool = False, only: Optional[list] = None, budget: float = 0.20,
               progress: Optional[Callable[[str], None]] = None) -> tuple:
    """-> (suite results, {suite: seconds}). Offline suites always; live ones when `live`."""
    plan = _offline_suites() + (_live_suites(budget) if live else [])
    results, seconds = [], {}
    previous = logging.root.manager.disable
    logging.disable(logging.CRITICAL)        # the server logs every guard it fires; the report is the output
    try:
        for name, fn, row in plan:
            if only and name.split("_")[0] not in only and name not in only:
                continue
            started = time.perf_counter()
            if progress:
                progress(f"running {name} ...")
            try:
                suite = fn()
            except Exception as exc:  # noqa: BLE001 — a crashed suite is RED, not skipped
                suite = R.errored(name, row, exc)
            seconds[name] = round(time.perf_counter() - started, 1)
            results.append(suite)
            if progress:
                progress(f"  {name}: {suite['status']} in {seconds[name]} s"
                         + (f" - {suite['reason']}" if suite["reason"] else ""))
    finally:
        logging.disable(previous)
    if not live:
        for name, row, why in (
                ("accuracy_live", "Accuracy (live LLM judge)", "live only: real questions through the real model "
                 "cost money - run `python -m evals --live` (weekly workflow evals-weekly.yml)"),
                ("performance_live", "Performance", "live only: tokens/second needs a real model"),
                ("cost_live", "Cost", "live only: real token counts come from the live run"),
                ("rag_live", "RAG quality", "live only: the real embedding model")):
            if not only or name in only or name.split("_")[0] in only:
                results.append(R.not_run(name, row, why))
    return results, seconds
