"""Token-usage ledger — billing visibility for the Nebius LLM calls.

Every LLM call site records its token counts here; GET /usage (main.py)
returns today's + this month's totals with an estimated dollar cost, so
model spend is observable without opening the Nebius console.

Coverage: the WhatsApp chat agent ('chat') and agent runs ('agent') — the
two dominant costs. Judge/profile-extraction micro-calls are not counted
(same model, ~5% of volume; add a source here if that changes).

Storage: flat JSON {date: {source: {in, out, calls}}} in DATA_DIR, pruned
to ~2 months. Same _load/_save pattern as reminders.py.
"""
import json
import logging
import os
from datetime import timedelta

import config
import database_service
from tz import today_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "llm_usage.json")
# Reserved key inside a day's row: per-model token totals, so cost is priced
# per model rather than at whatever model is current. Not a source — every
# reader must skip it.
BY_MODEL = "__by_model__"
_KEEP_DAYS = 62

# $ per 1M tokens (input, output) — Nebius Token Factory eu-north1 list prices.
PRICES: dict[str, tuple[float, float]] = {
    # NVIDIA Nemotron 3 — the tiers model_router routes between. Verified
    # against the Nebius Token Factory catalog on 2026-09-17.
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": (0.06, 0.24),
    "nvidia/nemotron-3-super-120b-a12b": (0.30, 0.90),
    "nvidia/Nemotron-3-Ultra-550b-a55b": (1.00, 3.00),
    "nvidia/Nemotron-3_5-Lightning": (0.06, 0.24),
    "NousResearch/Hermes-4-70B": (0.13, 0.40),
    "NousResearch/Hermes-4-405B": (1.00, 3.00),
    "Qwen/Qwen3-235B-A22B-Instruct-2507": (0.20, 0.60),
    "Qwen/Qwen3-30B-A3B-Instruct-2507": (0.10, 0.30),
    "meta-llama/Llama-3.3-70B-Instruct": (0.13, 0.40),
}


def _load() -> dict:
    try:
        with open(_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: dict) -> None:
    try:
        with open(_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError as exc:
        logger.error("usage save failed: %s", exc)


def record(source: str, tokens_in: int, tokens_out: int, model: str | None = None) -> None:
    """Add one call's tokens under today/source. Best-effort — never raises.

    `model` is also accumulated under the reserved `__by_model__` key so cost
    is priced per model. Without it a month that mixed nano and ultra would be
    billed entirely at whichever model happened to be current when /usage was
    read — off by 12x in the direction that matters."""
    if not (tokens_in or tokens_out):
        return
    try:
        data = _load()
        day = today_il().isoformat()
        cutoff = (today_il() - timedelta(days=_KEEP_DAYS)).isoformat()
        data = {d: v for d, v in data.items() if d >= cutoff}
        row = data.setdefault(day, {}).setdefault(source, {"in": 0, "out": 0, "calls": 0})
        row["in"] += int(tokens_in)
        row["out"] += int(tokens_out)
        row["calls"] += 1
        if model:
            mrow = data[day].setdefault(BY_MODEL, {}).setdefault(
                model, {"in": 0, "out": 0, "calls": 0})
            mrow["in"] += int(tokens_in)
            mrow["out"] += int(tokens_out)
            mrow["calls"] += 1
        _save(data)
        # Shadowed as the accumulated TOTAL, not an increment — the upsert is
        # then idempotent, where a retried increment would double-count.
        database_service.shadow_write(database_service.record_usage(
            day, source, row["in"], row["out"], row["calls"]))
    except Exception as exc:  # noqa: BLE001 — accounting must never break a reply
        logger.warning("usage record failed: %s", exc)


def _cost(tokens_in: int, tokens_out: int, model: str) -> float:
    pin, pout = PRICES.get(model, (0.0, 0.0))
    return (tokens_in * pin + tokens_out * pout) / 1_000_000


def summary() -> dict:
    """Today + current-month totals, per source, with estimated USD at the
    CURRENT model's price (history isn't tagged per model — close enough
    for a personal budget dial; the Nebius console is the invoice truth)."""
    data = _load()
    model = config.LLM_MODEL
    today = today_il().isoformat()
    month = today[:7]

    def _agg(days: list[str]) -> dict:
        tin = tout = calls = 0
        by_source: dict[str, dict] = {}
        by_model: dict[str, dict] = {}
        for d in days:
            for src, row in data.get(d, {}).items():
                if src == BY_MODEL:
                    for mdl, mrow in row.items():
                        m = by_model.setdefault(mdl, {"in": 0, "out": 0, "calls": 0})
                        m["in"] += mrow["in"]; m["out"] += mrow["out"]; m["calls"] += mrow["calls"]
                    continue
                tin += row["in"]; tout += row["out"]; calls += row["calls"]
                s = by_source.setdefault(src, {"in": 0, "out": 0, "calls": 0})
                s["in"] += row["in"]; s["out"] += row["out"]; s["calls"] += row["calls"]

        if by_model:
            # Priced per model — the only honest number once tiers are in play.
            cost = sum(_cost(m["in"], m["out"], mdl) for mdl, m in by_model.items())
            unpriced = [mdl for mdl in by_model if mdl not in PRICES]
        else:
            # Pre-tier history carries no model tag; fall back to the old
            # single-model estimate rather than reporting $0.
            cost = _cost(tin, tout, model)
            unpriced = [] if model in PRICES else [model]
        for mdl, m in by_model.items():
            m["est_cost_usd"] = round(_cost(m["in"], m["out"], mdl), 4)

        return {"tokens_in": tin, "tokens_out": tout, "calls": calls,
                "est_cost_usd": round(cost, 4),
                "unpriced_models": unpriced,
                "by_source": by_source,
                "by_model": by_model}

    return {
        "model": model,
        "priced": model in PRICES,
        "budget_usd": config.LLM_MONTHLY_BUDGET_USD or None,
        "today": _agg([today]),
        "month": _agg([d for d in data if d[:7] == month]),
    }
