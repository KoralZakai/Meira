"""Does Nemotron actually do this job as well as Qwen? Measure it, don't guess.

The hackathon requires an NVIDIA model. That is a rule, not an argument — but
switching the model that reads Hebrew task descriptions is a real risk, and
"it's required" is no reason to ship something worse without knowing.

So this runs the SAME extraction path (task_extract.extract, the real prompt,
the real finalize step) across every candidate model and scores it on cases
that mirror what people actually send Lumi — Hebrew first, because that is
where models quietly degrade and where every English-only shortcut in this
project has broken before.

    cd server && .venv/bin/python compare_models.py

Needs NEBIUS_API_KEY in the environment. On Fly:

    fly ssh console -a lumi-whatsapp -C "python /app/compare_models.py"

Reports, per model: accuracy on each field, median latency, and the cost of
the whole run at that model's price. Nothing is written and nothing is saved —
it is a measurement, not a migration.
"""
from __future__ import annotations

import asyncio
import json
import os
import statistics
import sys
import time
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config          # noqa: E402
import llm_usage       # noqa: E402
import model_router    # noqa: E402
import task_extract    # noqa: E402

TODAY = date(2026, 9, 17)      # a Thursday — fixed so "tomorrow" is reproducible

# Hebrew first: this is the language the app actually runs in.
CASES: list[dict] = [
    {"text": "יש לי ראיון עבודה מחר ב-10 בבוקר בבנימינה",
     "count": 1, "fixed_time": "10:00", "date": "2026-09-18"},
    {"text": "תזכיר לי להתקשר לאמא ב-8 בערב",
     "count": 1, "fixed_time": "20:00", "date": "2026-09-17"},
    {"text": "אימון בחדר כושר ביום ראשון ב-19:00",
     "count": 1, "fixed_time": "19:00", "date": "2026-09-20"},
    {"text": "יש לי פגישה עם דני ב-14:00 ואחר כך שיעור יוגה ב-18:30",
     "count": 2, "fixed_time": "14:00", "date": "2026-09-17"},
    {"text": "צריך להגיש את העבודה עד יום ראשון",
     "count": 1, "fixed_time": None, "date": None},
    {"text": "תור לרופא שיניים ביום שלישי הבא ב-9",
     "count": 1, "fixed_time": "09:00", "date": "2026-09-22"},
    # English, and one mixed — the app takes both.
    {"text": "I have an interview in Binyamina tomorrow at 10am",
     "count": 1, "fixed_time": "10:00", "date": "2026-09-18"},
    {"text": "קבעתי meeting עם הצוות ב-11:30 מחר",
     "count": 1, "fixed_time": "11:30", "date": "2026-09-18"},
]

CANDIDATES: list[tuple[str, str]] = [
    ("qwen-235b (today)", "Qwen/Qwen3-235B-A22B-Instruct-2507"),
    ("nemotron nano",     model_router.MODELS[model_router.SMALL]),
    ("nemotron super",    model_router.MODELS[model_router.MEDIUM]),
    ("nemotron ultra",    model_router.MODELS[model_router.LARGE]),
]


# The keys finalize() actually returns. Named here, and checked at runtime,
# because the first version of this file read "fixedTime" (the APP's camelCase
# name) instead of "fixed_time" (the SERVER's). Every model then scored an
# identical 12.5% on that field, which reads like a finding and was a bug in
# the ruler. A metric that four very different models agree on exactly is
# measuring the harness, not the models.
FIELD_TIME = "fixed_time"
FIELD_DATE = "date"


def _score(case: dict, tasks: list[dict]) -> dict:
    """Per-field hit/miss. Counting fields separately matters: a model that
    finds the task but loses the time is a different failure from one that
    invents a second task, and they need different fixes."""
    got_count = len(tasks) == case["count"]
    first = tasks[0] if tasks else {}
    got_time = (first.get(FIELD_TIME) or None) == case["fixed_time"]
    got_date = case[FIELD_DATE] is None or first.get(FIELD_DATE) == case["date"]
    return {"count": got_count, "time": got_time, "date": got_date}


def _check_fields(tasks: list[dict]) -> list[str]:
    """Names this harness scores that the output does not contain at all.
    Returns the missing ones so the run can say so LOUDLY instead of quietly
    reporting 0%."""
    if not tasks:
        return []
    return [f for f in (FIELD_TIME, FIELD_DATE) if f not in tasks[0]]


async def run_model(label: str, model: str) -> dict:
    original = config.LLM_MODEL_CHEAP
    config.LLM_MODEL_CHEAP = model          # forces task_extract onto this model
    hits = {"count": 0, "time": 0, "date": 0}
    latencies: list[float] = []
    errors = 0
    missing_fields: list[str] = []
    try:
        for case in CASES:
            started = time.monotonic()
            try:
                tasks = await task_extract.extract(case["text"], TODAY)
            except Exception as exc:        # noqa: BLE001 — a dead model is a result
                print(f"    ! {label}: {type(exc).__name__}: {str(exc)[:120]}")
                errors += 1
                continue
            latencies.append(time.monotonic() - started)
            missing_fields = missing_fields or _check_fields(tasks)
            for field, ok in _score(case, tasks).items():
                hits[field] += int(ok)
    finally:
        config.LLM_MODEL_CHEAP = original

    n = len(CASES) or 1
    price_in, price_out = llm_usage.PRICES.get(model, (0.0, 0.0))
    if missing_fields:
        print(f"    ! {label}: output has no {missing_fields} — this harness is "
              f"scoring a field that does not exist. Fix the names, not the model.")
    return {
        "label": label, "model": model, "errors": errors,
        "missing_fields": missing_fields,
        "count_pct": 100 * hits["count"] / n,
        "time_pct": 100 * hits["time"] / n,
        "date_pct": 100 * hits["date"] / n,
        "median_s": statistics.median(latencies) if latencies else float("nan"),
        "priced": bool(price_in or price_out),
        "price": f"${price_in}/${price_out} per 1M",
    }


async def main() -> None:
    if not config.LLM_API_KEY:
        print("NEBIUS_API_KEY is not set — nothing to compare.")
        raise SystemExit(1)

    print(f"{len(CASES)} cases, {len(CANDIDATES)} models. Today is pinned to {TODAY}.\n")
    rows = []
    for label, model in CANDIDATES:
        print(f"  running {label} ({model}) …")
        rows.append(await run_model(label, model))

    print(f"\n{'model':<20}{'tasks':>8}{'time':>8}{'date':>8}{'median':>9}{'errors':>8}  price")
    print("-" * 78)
    for r in rows:
        print(f"{r['label']:<20}{r['count_pct']:>7.0f}%{r['time_pct']:>7.0f}%"
              f"{r['date_pct']:>7.0f}%{r['median_s']:>8.1f}s{r['errors']:>8}  "
              f"{r['price'] if r['priced'] else '(unpriced)'}")
    # Four different models agreeing to the decimal is the signature of a
    # broken ruler, not of four equally good models. Say so.
    for field in ("count_pct", "time_pct", "date_pct"):
        values = {round(r[field], 1) for r in rows}
        if len(values) == 1 and rows[0][field] < 100:
            print(f"\n!! every model scored {values.pop()}% on {field.replace('_pct','')} — "
                  "identical scores across different models usually means this "
                  "harness is measuring the wrong thing. Check before believing it.")

    print("\ntasks = found the right NUMBER of tasks; time = right fixed time on the "
          "first;\ndate  = resolved the relative date correctly. Errors mean the model "
          "id is wrong\nor the model refused — check those before reading the "
          "percentages.")
    print(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
