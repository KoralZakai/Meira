#!/usr/bin/env python3
"""
Job C — Evaluate teacher vs student on Lumi's parser (Nebius Serverless AI Job).

This is the gate that decides what the Serverless Endpoint serves. It runs the
same parser function on a fair, held-out gold set against BOTH:

  - the teacher  (default Qwen/Qwen3-235B-A22B-Instruct-2507 on AI Studio), and
  - the student  (the LoRA model from Job B, normally hit at its deployed
                  Serverless Endpoint via STUDENT_BASE_URL / STUDENT_API_KEY).

For each candidate it issues one call per example with the canonical
PARSER_SYSTEM_PROMPT (identical to Job A / the endpoint), parses {"tasks":[...]},
and scores it with EDD-style field checks (the same checks tests/edd-evaluator.ts
applies, ported here and aligned to the parser schema). It reports accuracy,
JSON-validity, per-field breakdown, latency and (optional) cost, then recommends
the model the endpoint should serve.

Output (to OUTPUT_DIR, default /output):
  report.json   full metrics for every model + the head-to-head decision
  report.md     human-readable comparison table

The gold set (eval_set.jsonl) is non-circular: expectations are hand-authored,
not teacher labels, so the teacher is graded fairly rather than against itself.
"""

import inspect  # noqa: F401  (kept for parity with sibling jobs' tooling)
import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from openai import OpenAI

# ── Lumi parser schema + prompt ──────────────────────────────────────────────
# DUPLICATED VERBATIM from nebius/job-datagen/generate.py. The parser prompt is
# the single source of truth and MUST stay byte-identical across Job A (labels),
# Job C (this eval) and the Endpoint — otherwise the student is graded/served
# against a different function than it was trained on. If you edit it in one
# place, edit it in all three.

CATEGORIES = [
    "interview", "course", "conference", "class", "work", "meeting", "call",
    "doctor", "gym", "aspiration", "leisure", "general", "zoom", "hobby_class",
]
PRIORITIES = ["must", "have_to", "need_to", "nice_to_do"]
RECURRENCE_TYPES = ["daily", "weekly", "monthly"]

PARSER_SYSTEM_PROMPT = f"""You are Lumi's task parser. Convert a user's natural-language message (English, Hebrew, or a mix) into structured tasks.

Respond with ONLY a JSON object, no prose: {{"tasks": [ ... ]}}

Each task object may contain:
- "text" (string, required): concise task description, in the user's language.
- "category" (string, required): one of {CATEGORIES}.
- "priority" (string, required): one of {PRIORITIES}. Infer from urgency; default "need_to".
- "fixedTime" (string "HH:MM", optional): only if the user states a specific clock time.
- "deadline" (string "YYYY-MM-DD", optional): resolve relative dates ("tomorrow", "next Monday", "in 3 days") against REFERENCE_DATE.
- "hasDeadline" (bool): true iff a day/deadline was specified.
- "location" (string, optional) and "hasLocation" (bool).
- "contactName" (string, optional), "contactPhone" (string, optional).
- "how" (string, optional): method, if the user explains it.
- "why" (string, optional): reason, if the user explains it.
- "subgroup" (string, optional): a shared project label when several tasks belong together.
- "isRecurring" (bool, optional), "recurrenceType" ("daily"|"weekly"|"monthly", optional), "recurrenceDays" (int, optional).
- "tags" (string array, required): a few lowercase keywords.

Rules:
- Split multiple INDEPENDENT tasks into separate objects.
- A repeating task is ONE object with "isRecurring": true and recurrence fields.
  Never expand it into one object per occurrence, and never duplicate the same task.
- Do not emit two task objects with identical "text".
- Keep "text" faithful to the user; never invent details that were not said.
- Resolve every date relative to REFERENCE_DATE.
- Output valid JSON only."""

# ── Config ───────────────────────────────────────────────────────────────────

def env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default

def env_int(name, default):
    return int(env(name, str(default)))

def env_float(name, default):
    return float(env(name, str(default)))

STUDIO_BASE   = "https://api.studio.nebius.ai/v1"
SHARED_KEY    = env("NEBIUS_API_KEY") or env("EXPO_PUBLIC_NEBIUS_API_KEY")

TEACHER_MODEL = env("TEACHER_MODEL", "Qwen/Qwen3-235B-A22B-Instruct-2507")
TEACHER_BASE  = env("TEACHER_BASE_URL", STUDIO_BASE)
TEACHER_KEY   = env("TEACHER_API_KEY", SHARED_KEY)

# The student normally lives behind its own Serverless Endpoint. Point
# STUDENT_BASE_URL at it (and STUDENT_API_KEY at its token). If STUDENT_BASE_URL
# is unset we fall back to AI Studio with STUDENT_MODEL (e.g. to sanity-check the
# *base* student before fine-tuning).
STUDENT_MODEL = env("STUDENT_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
STUDENT_BASE  = env("STUDENT_BASE_URL", STUDIO_BASE)
STUDENT_KEY   = env("STUDENT_API_KEY", SHARED_KEY)

SKIP_TEACHER  = env("SKIP_TEACHER", "0").strip().lower() in ("1", "true", "yes")
SKIP_STUDENT  = env("SKIP_STUDENT", "0").strip().lower() in ("1", "true", "yes")

EVAL_SET      = Path(env("EVAL_SET", str(Path(__file__).parent / "eval_set.jsonl")))
OUTPUT_DIR    = Path(env("OUTPUT_DIR", "/output"))
CONCURRENCY   = env_int("CONCURRENCY", 8)
MAX_RETRIES   = env_int("MAX_RETRIES", 4)
WIN_TOLERANCE = env_float("WIN_TOLERANCE", 0.03)  # student wins if within this of teacher

# Optional cost reporting: USD per 1M tokens (prompt+completion combined).
TEACHER_PRICE = env_float("TEACHER_PRICE_PER_1M", 0.0)
STUDENT_PRICE = env_float("STUDENT_PRICE_PER_1M", 0.0)


def log(msg):
    print(f"[eval] {msg}", flush=True)


# ── Teacher/student call ─────────────────────────────────────────────────────

def with_retries(fn):
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — batch job, back off & retry
            last = e
            time.sleep(min(2 ** attempt, 10))
    raise last


def parse_with_model(client, model, reference_date, message):
    """Return (tasks_or_None, latency_ms, tokens). tasks is None on invalid JSON."""
    user_turn = f"REFERENCE_DATE: {reference_date}\nMESSAGE: {message}"

    def call():
        return client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": PARSER_SYSTEM_PROMPT},
                {"role": "user", "content": user_turn},
            ],
            temperature=0.0, max_tokens=900,
            response_format={"type": "json_object"},
        )

    t0 = time.perf_counter()
    resp = with_retries(call)
    latency_ms = (time.perf_counter() - t0) * 1000.0

    tokens = 0
    if getattr(resp, "usage", None):
        tokens = getattr(resp.usage, "total_tokens", 0) or 0

    content = resp.choices[0].message.content or ""
    try:
        obj = json.loads(content)
        tasks = obj.get("tasks")
        if not isinstance(tasks, list):
            tasks = None
    except json.JSONDecodeError:
        tasks = None
    return tasks, latency_ms, tokens


# ── Scoring (EDD-style field checks, aligned to the parser schema) ────────────

def _has_deadline(t):
    return bool(t.get("hasDeadline")) or bool(t.get("deadline"))

def _has_location(t):
    return bool(t.get("hasLocation")) or bool(t.get("location"))

def _loc_text(t):
    loc = t.get("location")
    if isinstance(loc, str):
        return loc
    if isinstance(loc, dict):
        return loc.get("address") or loc.get("displayName") or ""
    return ""


def check_task(actual, exp):
    """Yield (field, passed) for each per-task expectation present."""
    if "text_contains" in exp:
        yield "text", exp["text_contains"] in (actual.get("text") or "")
    if "category" in exp:
        yield "category", actual.get("category") == exp["category"]
    if "category_in" in exp:
        yield "category", actual.get("category") in exp["category_in"]
    if "priority" in exp:
        yield "priority", actual.get("priority") == exp["priority"]
    if "fixedTime" in exp:
        yield "fixedTime", actual.get("fixedTime") == exp["fixedTime"]
    if "hasDeadline" in exp:
        yield "hasDeadline", _has_deadline(actual) == exp["hasDeadline"]
    if "deadline" in exp:
        yield "deadline", actual.get("deadline") == exp["deadline"]
    if "hasLocation" in exp:
        yield "hasLocation", _has_location(actual) == exp["hasLocation"]
    if "location_contains" in exp:
        yield "location", exp["location_contains"] in _loc_text(actual)
    if "contactName_contains" in exp:
        yield "contactName", exp["contactName_contains"] in (actual.get("contactName") or "")
    if "isRecurring" in exp:
        yield "isRecurring", bool(actual.get("isRecurring")) == exp["isRecurring"]
    if "recurrenceType" in exp:
        yield "recurrenceType", actual.get("recurrenceType") == exp["recurrenceType"]
    if "tags_include" in exp:
        tags = actual.get("tags") or []
        tags = [str(x).lower() for x in tags] if isinstance(tags, list) else []
        yield "tags", all(x.lower() in tags for x in exp["tags_include"])


def score_example(tasks, expected):
    """Return (checks, by_field) where checks is a list of (field, passed)."""
    checks = []
    if tasks is None:
        # Invalid JSON: every declared expectation counts as a failure.
        checks.append(("json", False))
        return checks

    exp = expected
    if "count" in exp:
        checks.append(("count", len(tasks) == exp["count"]))
    if "count_gte" in exp:
        checks.append(("count", len(tasks) >= exp["count_gte"]))
    if "categories_include" in exp:
        cats = {t.get("category") for t in tasks if isinstance(t, dict)}
        for c in exp["categories_include"]:
            checks.append(("category", c in cats))

    for i, exp_task in enumerate(exp.get("tasks", [])):
        if i < len(tasks) and isinstance(tasks[i], dict):
            checks.extend(check_task(tasks[i], exp_task))
        else:
            # expected a task at this index but the model produced none
            for field, _ in check_task({}, exp_task):
                checks.append((field, False))
    return checks


# ── Per-model evaluation ─────────────────────────────────────────────────────

def evaluate_model(spec, examples):
    name, model, base, key, price = (
        spec["name"], spec["model"], spec["base"], spec["key"], spec["price"])
    if not key:
        log(f"{name}: no API key — skipping.")
        return None
    log(f"{name}: model={model} base={base} on {len(examples)} examples")
    client = OpenAI(api_key=key, base_url=base)

    results = [None] * len(examples)

    def run(i):
        ex = examples[i]
        tasks, latency, tokens = parse_with_model(
            client, model, ex["reference_date"], ex["message"])
        return i, tasks, latency, tokens

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = [pool.submit(run, i) for i in range(len(examples))]
        done = 0
        for fut in as_completed(futures):
            i, tasks, latency, tokens = fut.result()
            results[i] = (tasks, latency, tokens)
            done += 1
            if done % 5 == 0 or done == len(examples):
                log(f"{name}: {done}/{len(examples)}")

    total_checks = passed_checks = 0
    json_valid = 0
    exact = 0
    latencies, total_tokens = [], 0
    by_field = {}  # field -> [passed, total]
    per_example = []

    for ex, (tasks, latency, tokens) in zip(examples, results):
        latencies.append(latency)
        total_tokens += tokens
        if tasks is not None:
            json_valid += 1
        checks = score_example(tasks, ex["expected"])
        ex_passed = sum(1 for _, ok in checks if ok)
        ex_total = len(checks)
        total_checks += ex_total
        passed_checks += ex_passed
        if ex_total > 0 and ex_passed == ex_total:
            exact += 1
        for field, ok in checks:
            slot = by_field.setdefault(field, [0, 0])
            slot[1] += 1
            if ok:
                slot[0] += 1
        per_example.append({
            "id": ex["id"], "passed": ex_passed, "total": ex_total,
            "latency_ms": round(latency, 1),
            "failed_fields": [f for f, ok in checks if not ok],
        })

    n = len(examples)
    metrics = {
        "name": name,
        "model": model,
        "base_url": base,
        "examples": n,
        "json_valid_rate": round(json_valid / n, 4) if n else 0.0,
        "accuracy": round(passed_checks / total_checks, 4) if total_checks else 0.0,
        "checks_passed": passed_checks,
        "checks_total": total_checks,
        "exact_match_rate": round(exact / n, 4) if n else 0.0,
        "latency_ms_mean": round(statistics.mean(latencies), 1) if latencies else 0.0,
        "latency_ms_p95": round(_p95(latencies), 1) if latencies else 0.0,
        "total_tokens": total_tokens,
        "by_field": {f: {"passed": p, "total": t,
                         "accuracy": round(p / t, 4) if t else 0.0}
                     for f, (p, t) in sorted(by_field.items())},
        "per_example": per_example,
    }
    if price > 0:
        metrics["est_cost_usd"] = round(total_tokens / 1_000_000 * price, 6)
        metrics["price_per_1m_usd"] = price
    return metrics


def _p95(xs):
    if not xs:
        return 0.0
    s = sorted(xs)
    k = max(0, int(round(0.95 * (len(s) - 1))))
    return s[k]


# ── Decision + reporting ─────────────────────────────────────────────────────

def decide(teacher, student):
    """Recommend which model the endpoint should serve."""
    if teacher and not student:
        return {"recommended": "teacher", "reason": "student not evaluated"}
    if student and not teacher:
        return {"recommended": "student", "reason": "teacher not evaluated"}
    if not teacher and not student:
        return {"recommended": None, "reason": "no models evaluated"}

    gap = round(teacher["accuracy"] - student["accuracy"], 4)
    if student["json_valid_rate"] < 0.95:
        return {"recommended": "teacher",
                "reason": f"student JSON-validity {student['json_valid_rate']:.0%} "
                          f"below 95% threshold",
                "accuracy_gap": gap}
    if student["accuracy"] >= teacher["accuracy"] - WIN_TOLERANCE:
        return {"recommended": "student",
                "reason": f"student within {WIN_TOLERANCE:.0%} of teacher accuracy "
                          f"(gap {gap:+.3f}) — far cheaper & faster, so it serves",
                "accuracy_gap": gap}
    return {"recommended": "teacher",
            "reason": f"student trails teacher by {gap:.3f} (> {WIN_TOLERANCE:.0%} "
                      f"tolerance) — keep teacher until the student improves",
            "accuracy_gap": gap}


def write_leaderboard(report):
    """Markdown for MODELS mode: one row per model, best accuracy first.

    The column names below are the keys evaluate_model ACTUALLY returns, and
    they are read through .get with a default of None so a renamed metric shows
    as "—" instead of silently printing 0%. Two earlier versions of a
    comparison table in this project scored a field that did not exist and
    produced a clean, confident, meaningless number; a dash is the honest
    output for "not measured".

    Accuracy, cost and latency sit side by side on purpose: the cheapest model
    that passes is not automatically the right one. A model 3x cheaper and 10x
    slower is a bad trade for an assistant whose whole promise is telling you
    to leave NOW.
    """
    def pct(value):
        return f"{value * 100:.0f}%" if isinstance(value, (int, float)) else "—"

    rows = sorted(report["models"].values(),
                  key=lambda m: (-(m.get("accuracy") or 0), m.get("est_cost_usd") or 0))
    out = ["# Model comparison — Lumi's parser", "",
           f"`{report['examples']}` examples from `{report['eval_set']}`.", "",
           "| model | field accuracy | fully correct | valid JSON | p95 latency | cost (this run) |",
           "|---|---|---|---|---|---|"]
    for m in rows:
        p95_ms = m.get("latency_ms_p95")
        latency = f"{p95_ms / 1000:.1f}s" if isinstance(p95_ms, (int, float)) else "—"
        cost = (f"${m['est_cost_usd']:.4f}" if isinstance(m.get("est_cost_usd"), (int, float))
                else "—")
        out.append(f"| `{m.get('model', '?')}` | {pct(m.get('accuracy'))} | "
                   f"{pct(m.get('exact_match_rate'))} | {pct(m.get('json_valid_rate'))} | "
                   f"{latency} | {cost} |")
    if rows:
        best = rows[0]
        out += ["", f"**Best field accuracy:** `{best.get('model')}` at "
                    f"{pct(best.get('accuracy'))}.", "",
                "`valid JSON` below 100% means the model failed to return parseable "
                "output on some calls — check that before reading any other column, "
                "because a model that often returns nothing can still score well on "
                "the few answers it did give.", "",
                "Per-field breakdowns and every individual example are in `report.json`."]
    return "\n".join(out)


def write_markdown(report):
    rows = [m for m in (report.get("teacher"), report.get("student")) if m]
    lines = ["# Lumi parser — teacher vs student (Job C)", ""]
    if not rows:
        lines.append("_No models were evaluated._")
        return "\n".join(lines) + "\n"

    lines += [
        f"Eval set: `{report['eval_set']}` ({report['examples']} examples). "
        f"Decision tolerance: {WIN_TOLERANCE:.0%}.",
        "",
        "| Model | Accuracy | Exact-match | JSON-valid | Mean latency | p95 | Tokens | Cost |",
        "|-------|----------|-------------|------------|--------------|-----|--------|------|",
    ]
    for m in rows:
        cost = f"${m['est_cost_usd']:.4f}" if "est_cost_usd" in m else "—"
        lines.append(
            f"| {m['name']} (`{m['model']}`) | {m['accuracy']:.1%} | "
            f"{m['exact_match_rate']:.1%} | {m['json_valid_rate']:.1%} | "
            f"{m['latency_ms_mean']:.0f} ms | {m['latency_ms_p95']:.0f} ms | "
            f"{m['total_tokens']} | {cost} |")

    d = report["decision"]
    lines += ["", f"**Recommended for the endpoint: `{d['recommended']}`** — {d['reason']}", ""]

    # Per-field breakdown
    fields = sorted({f for m in rows for f in m["by_field"]})
    if fields:
        header = "| Field | " + " | ".join(m["name"] for m in rows) + " |"
        sep = "|" + "---|" * (len(rows) + 1)
        lines += ["## Per-field accuracy", "", header, sep]
        for f in fields:
            cells = []
            for m in rows:
                bf = m["by_field"].get(f)
                cells.append(f"{bf['accuracy']:.0%} ({bf['passed']}/{bf['total']})"
                             if bf else "—")
            lines.append(f"| {f} | " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


# ── Main ─────────────────────────────────────────────────────────────────────

def load_eval_set():
    if not EVAL_SET.exists():
        sys.exit(f"ERROR: eval set not found: {EVAL_SET}")
    examples = []
    with open(EVAL_SET, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))
    if not examples:
        sys.exit(f"ERROR: eval set is empty: {EVAL_SET}")
    return examples


def main():
    if not SHARED_KEY and not (TEACHER_KEY or STUDENT_KEY):
        sys.exit("ERROR: set NEBIUS_API_KEY (or per-model TEACHER_API_KEY/STUDENT_API_KEY).")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    examples = load_eval_set()
    log(f"loaded {len(examples)} eval examples from {EVAL_SET}")

    # MODELS mode: compare an arbitrary LIST of models instead of teacher vs
    # student. Added for the Nemotron switch — "the rules require an NVIDIA
    # model" is a reason to change, not evidence that the change is harmless,
    # and the model being swapped is the one that reads Hebrew.
    #   MODELS="qwen=Qwen/Qwen3-235B-A22B-Instruct-2507@0.2,nano=nvidia/...@0.06"
    # The @price suffix is USD per 1M tokens and is optional.
    models_env = env("MODELS", "").strip()
    if models_env:
        specs = []
        for item in models_env.split(","):
            item = item.strip()
            if not item:
                continue
            label, _, model = item.partition("=")
            model, _, price = (model or label).partition("@")
            specs.append({"name": label.strip() or model.strip(),
                          "model": model.strip(),
                          "base": TEACHER_BASE, "key": SHARED_KEY or TEACHER_KEY,
                          "price": float(price or 0)})
        results = {}
        for spec in specs:
            m = evaluate_model(spec, examples)
            if m:
                results[spec["name"]] = m
        report = {"eval_set": str(EVAL_SET), "examples": len(examples),
                  "mode": "models", "models": results}
        with open(OUTPUT_DIR / "report.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        md = write_leaderboard(report)
        with open(OUTPUT_DIR / "report.md", "w", encoding="utf-8") as f:
            f.write(md)
        log("=" * 60)
        print(md, flush=True)
        log(f"report -> {OUTPUT_DIR/'report.json'} and report.md")
        return

    specs = []
    if not SKIP_TEACHER:
        specs.append({"name": "teacher", "model": TEACHER_MODEL,
                      "base": TEACHER_BASE, "key": TEACHER_KEY, "price": TEACHER_PRICE})
    if not SKIP_STUDENT:
        specs.append({"name": "student", "model": STUDENT_MODEL,
                      "base": STUDENT_BASE, "key": STUDENT_KEY, "price": STUDENT_PRICE})

    results = {}
    for spec in specs:
        m = evaluate_model(spec, examples)
        if m:
            results[spec["name"]] = m

    teacher = results.get("teacher")
    student = results.get("student")
    decision = decide(teacher, student)

    report = {
        "eval_set": str(EVAL_SET),
        "examples": len(examples),
        "win_tolerance": WIN_TOLERANCE,
        "teacher": teacher,
        "student": student,
        "decision": decision,
    }
    with open(OUTPUT_DIR / "report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    md = write_markdown(report)
    with open(OUTPUT_DIR / "report.md", "w", encoding="utf-8") as f:
        f.write(md)

    log("=" * 60)
    print(md, flush=True)
    log(f"report -> {OUTPUT_DIR/'report.json'} and report.md")
    log(f"DECISION: serve '{decision['recommended']}' — {decision['reason']}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
