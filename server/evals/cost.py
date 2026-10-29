"""cost — what a request, a saved task and a person-day cost, in dollars.

Five inputs, as the owner defined them:

  tokens      the model's input and output tokens per request, priced per model
              with llm_usage.PRICES (llm_usage.price_of — the same table the
              billing dial, ai_gate and user_quota use)
  API calls   Directions / Geocoding / Places / Tavily calls per request, each
              at its public list price (EXTERNAL_USD_PER_CALL below)
  CPU         process CPU seconds per request, valued at the machine's price
  infra       the fixed monthly cost of the Fly machine + volume, spread over
              the people using it

OFFLINE the tokens are ESTIMATED from the real requests the server builds
(chars / 4, tool schemas included — the 18 KB system prompt and 20+ tool
definitions are most of every request) and the API-call counts are the calls
the real tools made against the simulator. LIVE (--live) the tokens are the
provider's own usage numbers from the live accuracy run.

It then answers the question that actually decides things: does a person's day
fit inside the allowance that was set for it?

    USER_AI_DAILY_REQUESTS   requests per person per day      (fly.toml: 15)
    USER_LLM_DAILY_USD       dollars per person per day       (user_quota: 0.15)
    TOKEN_FACTORY_BALANCE    prepaid dollars, less LLM_RESERVE_USD

...and how many days the prepaid balance lasts if every free seat spends its
whole request allowance every day (the worst case the fly.toml comment plans
for: "$130 lasts a month even if all 20 max out").

PRICES ARE ASSUMPTIONS where marked. Google and Tavily list prices change and
free tiers apply; CLAUDE.md rule 10 says the provider's own console is the
truth — compare this against it before relying on the cents.
"""
from __future__ import annotations

import asyncio
import os
import re
import time

from evals import harness
from evals import metrics as M
from evals.env import REPO_ROOT, offline_session
from evals.fakes import ExternalSim, FakeModel
from evals.result import metric, not_run, ok

ROW = "Cost"

#: Public list prices, USD per call. ASSUMPTIONS — verify against the billing
#: consoles. Free monthly tiers are ignored (conservative).
EXTERNAL_USD_PER_CALL = {
    "google_geocode": 0.005,       # Geocoding API, $5 / 1 000
    "google_directions": 0.005,    # Directions, $5 / 1 000 (transit + traffic can be $10 / 1 000)
    "google_places": 0.032,        # Places Text Search, $32 / 1 000
    "tavily": 0.008,               # one basic-search credit, pay-as-you-go
    "supabase": 0.0,               # flat plan, not per call
    "other": 0.0,
}
#: Fly.io shared-cpu-1x / 256 MB machine plus a small volume, USD per month. ASSUMPTION.
INFRA_USD_PER_MONTH = 2.2

#: The same 20-request day mix the scalability ramp uses.
from evals.scalability import MIX   # noqa: E402


def _fly_env() -> dict:
    """Settings that govern the allowance, read from fly.toml's [env] — not assumed."""
    path = os.path.join(REPO_ROOT, "fly.toml")
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    code = re.sub(r"(?m)^\s*#.*$", "", text)

    def get(name, default):
        m = re.search(rf"{name}\s*=\s*'?\"?([0-9.]+)", code)
        return float(m.group(1)) if m else default

    return {"daily_requests": get("USER_AI_DAILY_REQUESTS", 10.0),
            "daily_usd": get("USER_LLM_DAILY_USD", 0.0),
            "balance_usd": get("TOKEN_FACTORY_BALANCE_USD", 0.0),
            "reserve_usd": get("LLM_RESERVE_USD", 10.0)}


def request_cost(trace) -> dict:
    """USD for one traced request: {model, api, total, tokens_in, tokens_out, calls}."""
    from evals.live import price_usd
    model_usd = sum(price_usd(e.get("model"), e["tokens_in"], e["tokens_out"])
                    for e in trace.model_events if not e.get("fault"))
    api_usd = sum(EXTERNAL_USD_PER_CALL.get(e["service"], 0.0) for e in trace.ext_events)
    calls: dict = {}
    for e in trace.ext_events:
        calls[e["service"]] = calls.get(e["service"], 0) + 1
    return {"model": model_usd, "api": api_usd, "total": model_usd + api_usd,
            "tokens_in": trace.tokens_in, "tokens_out": trace.tokens_out,
            "model_calls": sum(1 for e in trace.model_events if not e.get("fault")), "api_calls": calls}


def summarise(costs: list, saved_tasks: int, cpu_s_per_request: float, source: str) -> dict:
    """Turn per-request costs into the matrix numbers and the allowance verdicts."""
    import user_quota
    n = len(costs)
    mean_req = sum(c["total"] for c in costs) / n
    mean_model = sum(c["model"] for c in costs) / n
    mean_api = sum(c["api"] for c in costs) / n
    fly = _fly_env()
    # Read AFTER the eval session closed (it zeroes the allowance while it runs):
    # this is the allowance a real person gets — the env value if set, else 0.15.
    daily_usd = (fly["daily_usd"] if not os.getenv("USER_LLM_DAILY_USD") and fly["daily_usd"]
                 else user_quota.daily_limit())
    daily_requests = fly["daily_requests"]
    per_user_day = mean_req * daily_requests
    cpu_usd = cpu_s_per_request * INFRA_USD_PER_MONTH / (30 * 86400)
    free_seats = float(user_quota.free_seats())
    # The prepaid Token Factory balance pays for MODEL tokens only.
    worst_day = free_seats * daily_requests * mean_model
    spendable = max(0.0, fly["balance_usd"] - fly["reserve_usd"])
    runway_days = spendable / worst_day if worst_day else float("inf")
    api_calls: dict = {}
    for c in costs:
        for k, v in c["api_calls"].items():
            api_calls[k] = api_calls.get(k, 0) + v
    return {
        "source": source, "requests": n, "per_request_usd": mean_req,
        "model_usd_per_request": mean_model, "api_usd_per_request": mean_api,
        "cpu_usd_per_request": cpu_usd,
        "per_saved_task_usd": (sum(c["total"] for c in costs) / saved_tasks) if saved_tasks else None,
        "saved_tasks": saved_tasks,
        "per_user_day_usd": per_user_day, "daily_requests": daily_requests, "daily_usd_allowance": daily_usd,
        # user_quota charges MODEL spend only (llm_usage.record -> user_quota.charge);
        # Google and Tavily are billed to the project, not to her allowance.
        "allowance_used": (mean_model * daily_requests) / daily_usd if daily_usd else None,
        "requests_until_dollar_cap": daily_usd / mean_model if mean_model else None,
        "tokens_in_per_request": sum(c["tokens_in"] for c in costs) / n,
        "tokens_out_per_request": sum(c["tokens_out"] for c in costs) / n,
        "model_calls_per_request": sum(c["model_calls"] for c in costs) / n,
        "api_calls_per_request": {k: v / n for k, v in sorted(api_calls.items())},
        "infra_usd_per_user_day_at_seats": INFRA_USD_PER_MONTH / 30 / free_seats,
        "free_seats": free_seats, "worst_case_usd_per_day": worst_day, "spendable_usd": spendable,
        "runway_days_worst_case": runway_days, "balance_usd": fly["balance_usd"],
        "reserve_usd": fly["reserve_usd"],
    }


def _metrics(s: dict, prefix: str, how_tokens: str) -> list:
    fail_note = []
    if s["allowance_used"] and s["allowance_used"] > 1:
        fail_note = [{"input": "one person-day", "expected": f"<= ${s['daily_usd_allowance']:.2f}",
                      "got": f"${s['model_usd_per_request'] * s['daily_requests']:.3f} of model spend for "
                             f"{s['daily_requests']:.0f} requests",
                      "note": "the dollar allowance would stop her before the request cap"}]
    calls = ", ".join(f"{k} {v:.2f}" for k, v in s["api_calls_per_request"].items()) or "none"
    return [
        metric(f"{prefix}.per_request_usd", "Cost per request", s["per_request_usd"], "usd",
               f"{how_tokens}: {s['tokens_in_per_request']:.0f} in / {s['tokens_out_per_request']:.0f} out tokens over "
               f"{s['model_calls_per_request']:.1f} model calls (${s['model_usd_per_request']:.4f}) + outside API calls "
               f"per request: {calls} (${s['api_usd_per_request']:.4f}). CPU ${s['cpu_usd_per_request']:.8f}",
               [], {"summary": s}),
        metric(f"{prefix}.per_saved_task_usd", "Cost per saved task", s["per_saved_task_usd"], "usd",
               f"all {s['requests']} requests' cost / {s['saved_tasks']} tasks they saved "
               "(questions cost money and save nothing)", [], {}),
        metric(f"{prefix}.per_user_day_usd", "Cost per person-day", s["per_user_day_usd"], "usd",
               f"{s['daily_requests']:.0f} requests (fly.toml USER_AI_DAILY_REQUESTS) x cost per request; "
               f"+ ${s['infra_usd_per_user_day_at_seats']:.3f} fixed infra per person at {s['free_seats']:.0f} seats",
               fail_note, {}),
        metric(f"{prefix}.allowance_used", "Share of the daily $ allowance used", s["allowance_used"], "ratio",
               f"MODEL cost per person-day / USER_LLM_DAILY_USD (${s['daily_usd_allowance']:.2f}; only model "
               f"tokens count toward it); above 1.0 the dollar cap, not the request cap, ends her day after "
               f"{s['requests_until_dollar_cap']:.1f} requests",
               fail_note, {}),
        metric(f"{prefix}.runway_days", "Days the prepaid balance lasts, worst case", s["runway_days_worst_case"],
               "days", f"(${s['balance_usd']:.0f} balance - ${s['reserve_usd']:.0f} reserve) / "
               f"(${s['worst_case_usd_per_day']:.2f}/day of model spend if {s['free_seats']:.0f} seats each "
               f"use all {s['daily_requests']:.0f} requests)", [], {}),
    ]


async def _run_mix(model, sim) -> list:
    scenarios = harness.standard_scenarios()
    outcomes = []
    for name in MIX:
        sc = scenarios[name]
        outcomes.append(await harness.run_request(model, sc.note, harness.new_user(),
                                                  scenario=sc, timeout_s=60))
    return outcomes


def run() -> dict:
    model = FakeModel(latency_s=0.005, side_latency_s=0.003)
    sim = ExternalSim(latency_scale=0.02)
    with offline_session(model, sim):
        cpu0, t0 = time.process_time(), time.perf_counter()
        outcomes = asyncio.run(_run_mix(model, sim))
        cpu = time.process_time() - cpu0
    good = [o for o in outcomes if not o.error]
    if not good:
        return not_run("cost", ROW, "no request completed: " + (outcomes[0].error if outcomes else "none sent"))
    costs = [request_cost(o.trace) for o in good]
    saved = sum(len(o.saved_tasks) for o in good)
    s = summarise(costs, saved, cpu / len(outcomes), "offline estimate")
    metrics = _metrics(s, "cost", "tokens ESTIMATED (chars/4) from the real requests")
    return ok("cost", ROW, metrics, s)


def run_live() -> dict:
    from evals import live
    if live.LAST is None or not live.LAST.outcomes:
        return not_run("cost_live", "Cost", "no live run in this process — real token counts come "
                                                   "from the live accuracy run")
    good = [o for o in live.LAST.outcomes if not o.error and o.trace.model_events]
    if not good:
        return not_run("cost_live", "Cost", "the live run produced no completed request")
    costs = [request_cost(o.trace) for o in good]
    saved = sum(len(o.saved_tasks) for o in good)
    s = summarise(costs, saved, 0.02, f"live, {len(good)} real requests")
    return ok("cost_live", "Cost", _metrics(s, "cost_live", "tokens as REPORTED by the provider"), s)
