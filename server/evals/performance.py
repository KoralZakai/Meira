"""performance — how long does it take, and how much of that is us?

OFFLINE. Real agent turns (agent_turn.run_turn, the real tools, guards and JSON
stores) with the FAKE model answering after a FIXED simulated latency (300 ms
per call) and the outside APIs answering after fixed nominal latencies
(evals.fakes.EXTERNAL_LATENCY_S). Because the world's speed is a known
constant, what is left over is ours:

    overhead = wall time of the request - model time - outside-API time

That is the number a code change can move, and the one the threshold is on.
(Where a turn runs tools in parallel the nominal sum can exceed the wall, so
overhead is clamped at 0 rather than reported negative.)

Measured at light concurrency — 4 requests in flight — so it includes a little
queueing and is, if anything, pessimistic for a single request.

    per request   p50 / p95 / p99 of wall time and of overhead
    per tool      p50 / p95 / p99 of each tool's own time, and of the part that
                  is not an outside call
    throughput    requests per second sustained by those 4 workers
    code paths    the deterministic modules (date, category, intent, day
                  builder, clash resolver) timed in isolation, in microseconds

LIVE (--live): tokens/second from the provider's own usage numbers and the
wall time of each model call during the live accuracy run — end-to-end,
non-streaming, so it includes time-to-first-token. Not measurable offline: the
fake model has no generation speed, and inventing one would be a made-up number.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from collections import defaultdict
from datetime import date

from evals import harness
from evals import metrics as M
from evals.env import REPO_ROOT, offline_session
from evals.fakes import ExternalSim, FakeModel
from evals.result import metric, not_run, ok

ROW = "Performance"
MODEL_LATENCY_S = 0.3
WORKERS = 4
REPEATS = 8               # per scenario


async def _pool(model, sim, jobs: list, workers: int) -> tuple:
    """Run `jobs` [(scenario, content)] over `workers` coroutines -> (outcomes, seconds)."""
    queue: asyncio.Queue = asyncio.Queue()
    for job in jobs:
        queue.put_nowait(job)
    outcomes: list = []

    async def worker():
        while True:
            try:
                scenario, content = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            outcomes.append(await harness.run_request(model, content, harness.new_user(),
                                                      scenario=scenario, timeout_s=60))

    started = time.perf_counter()
    await asyncio.gather(*[worker() for _ in range(workers)])
    return outcomes, time.perf_counter() - started


def overhead_s(trace) -> float:
    """Wall time minus the simulated model and outside-API time, floored at 0."""
    return max(0.0, trace.wall_s - trace.model_s - trace.external_s)


def _micro() -> dict:
    """µs per call of the deterministic code paths. {name: {p50_us, p95_us, p99_us, n}}."""
    import categorize
    import clashes
    import day_schedule
    import task_intent
    import tz
    today = date(2026, 10, 15)
    day = [{"id": str(i), "text": f"task {i}", "fixed_time": f"{8 + i % 10:02d}:00" if i % 2 else None,
            "duration_minutes": 45, "priority": ["must", "have_to", "need_to", "nice_to_do"][i % 4],
            "date": "2026-10-15"} for i in range(12)]
    days_path = os.path.join(REPO_ROOT, "tests", "fixtures", "clash-days.json")
    clash_day = None
    if os.path.exists(days_path):
        with open(days_path, encoding="utf-8") as handle:
            clash_day = json.load(handle)["days"][0]
    paths = {
        "tz.resolve_date": (lambda: tz.resolve_date("ביום שני", today), 2000),
        "categorize.infer": (lambda: categorize.infer("ראיון עבודה במר גרופ מחר"), 2000),
        "task_intent.classify": (lambda: task_intent.classify("תזיז את היוגה ל-19:00"), 2000),
        "day_schedule.build (12 tasks)": (lambda: day_schedule.build_day_schedule(day, now="09:10"), 300),
    }
    if clash_day:
        paths["clashes.resolve (1 day)"] = (
            lambda: clashes.resolve_clashes(clash_day["tasks"], clash_day["dayEnd"]), 300)
    out = {}
    for name, (fn, n) in paths.items():
        samples = []
        for _ in range(n):
            t0 = time.perf_counter()
            fn()
            samples.append(time.perf_counter() - t0)
        out[name] = {"p50_us": M.percentile(samples, 50) * 1e6, "p95_us": M.percentile(samples, 95) * 1e6,
                     "p99_us": M.percentile(samples, 99) * 1e6, "n": n}
    return out


def run(repeats: int = REPEATS) -> dict:
    model = FakeModel(latency_s=MODEL_LATENCY_S, side_latency_s=0.15)
    sim = ExternalSim()
    with offline_session(model, sim):
        scenarios = harness.standard_scenarios()
        jobs = [(sc, sc.note) for sc in scenarios.values() for _ in range(repeats)]
        # Interleave the shapes so the workers do not all hit the same tool at once.
        jobs = [jobs[i] for i in sorted(range(len(jobs)), key=lambda i: (i % repeats, i))]
        outcomes, seconds = asyncio.run(_pool(model, sim, jobs, WORKERS))

    errors = [o for o in outcomes if o.error]
    traces = [o.trace for o in outcomes if not o.error]
    wall = M.latency_summary([t.wall_s for t in traces])
    over = M.latency_summary([overhead_s(t) for t in traces])
    per_tool: dict = defaultdict(list)
    per_tool_over: dict = defaultdict(list)
    for t in traces:
        for e in t.tool_events:
            per_tool[e["name"]].append(e["ms"] / 1000)
            per_tool_over[e["name"]].append(max(0.0, e["ms"] / 1000 - e.get("ext_s", 0.0)))
    tools = {name: {**M.latency_summary(vals),
                    "overhead_p95_ms": M.percentile([v * 1000 for v in per_tool_over[name]], 95)}
             for name, vals in sorted(per_tool.items())}
    slowest = max(tools.items(), key=lambda kv: kv[1]["overhead_p95_ms"]) if tools else None
    micro = _micro()
    slowest_micro = max(micro.items(), key=lambda kv: kv[1]["p95_us"])

    how = (f"{len(outcomes)} real turns ({len(scenarios)} shapes x {REPEATS}), {WORKERS} in flight, "
           f"fake model fixed at {int(MODEL_LATENCY_S * 1000)} ms/call, outside APIs at nominal latency")
    metrics = [
        metric("performance.request_p50_ms", "Request latency p50", wall["p50_ms"], "ms", how, [],
               {"summary": wall}),
        metric("performance.request_p95_ms", "Request latency p95", wall["p95_ms"], "ms", how, [], {}),
        metric("performance.request_p99_ms", "Request latency p99", wall["p99_ms"], "ms", how, [], {}),
        metric("performance.overhead_p50_ms", "Our overhead p50", over["p50_ms"], "ms",
               "wall - simulated model - simulated outside APIs", [], {"summary": over}),
        metric("performance.overhead_p95_ms", "Our overhead p95", over["p95_ms"], "ms",
               "wall - simulated model - simulated outside APIs (code, JSON stores, queueing)",
               [{"input": o.content, "expected": "<= overhead budget",
                 "got": f"{overhead_s(o.trace) * 1000:.0f} ms overhead, {o.trace.wall_s * 1000:.0f} ms wall"}
                for o in sorted((o for o in outcomes if not o.error),
                                key=lambda o: -overhead_s(o.trace))[:3]], {}),
        metric("performance.overhead_p99_ms", "Our overhead p99", over["p99_ms"], "ms", how, [], {}),
        metric("performance.tool_overhead_p95_ms", "Slowest tool, own time p95",
               slowest[1]["overhead_p95_ms"] if slowest else None, "ms",
               f"p95 of a tool's time with its outside calls subtracted; slowest: "
               f"{slowest[0] if slowest else '-'}", [], {"tools": tools}),
        metric("performance.throughput_rps", "Throughput (4 in flight)", len(outcomes) / seconds, "req/s",
               f"{len(outcomes)} requests in {seconds:.1f} s; capped by the simulated model latency "
               f"(4 workers / mean wall {wall['mean_ms']:.0f} ms)", [], {"seconds": seconds}),
        metric("performance.code_path_p95_us", "Slowest deterministic code path p95", slowest_micro[1]["p95_us"],
               "us", f"{len(micro)} pure-code paths timed in isolation; slowest: {slowest_micro[0]}",
               [], {"paths": micro}),
    ]
    if errors:
        metrics[0]["failures"] = [{"input": o.content, "expected": "a reply", "got": o.error}
                                  for o in errors[:8]]
    return ok("performance", ROW, metrics, {"tools": tools, "code_paths": micro, "errors": len(errors)})


def run_live() -> dict:
    """Tokens/second from the live accuracy run's own model calls."""
    from evals import live
    if live.LAST is None or not live.LAST.outcomes:
        return not_run("performance_live", "Performance",
                       "no live run in this process — tokens/sec is read from the live accuracy run's traces")
    calls = [e for o in live.LAST.outcomes for e in o.trace.model_events
             if e.get("tokens_out", 0) >= 20 and e.get("latency_s", 0) > 0]
    if not calls:
        return not_run("performance_live", "Performance", "no model call produced >= 20 output tokens")
    rates = [e["tokens_out"] / e["latency_s"] for e in calls]
    lat = M.latency_summary([e["latency_s"] for e in calls])
    reqs = M.latency_summary([o.trace.wall_s for o in live.LAST.outcomes if not o.error])
    how = (f"{len(calls)} real model calls (>= 20 output tokens) during the live run; end-to-end, "
           "non-streaming, so time-to-first-token is included")
    return ok("performance_live", "Performance", [
        metric("performance.live_tokens_per_s", "Live: tokens/second (median call)", M.percentile(rates, 50),
               "tok/s", how, [], {"p05": M.percentile(rates, 5), "p95": M.percentile(rates, 95)}),
        metric("performance.live_model_call_p95_ms", "Live: model call latency p95", lat["p95_ms"], "ms",
               how, [], {"summary": lat}),
        metric("performance.live_request_p95_ms", "Live: full request latency p95", reqs["p95_ms"], "ms",
               f"{reqs['n']} real turns through run_turn", [], {"summary": reqs}),
    ])
