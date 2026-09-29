"""Which model answers this call — by size of the job, and by money left.

Three tiers, all NVIDIA Nemotron on Nebius Token Factory:

    small   nano   — classification, extraction, intent. Most of our volume.
    medium  super  — the conversational agent and tool selection.
    large   ultra  — long-running / long-context reasoning. Rare on purpose.

Two things move a call off its default tier:

1. TOKENS. A prompt that will not fit a tier's context window is escalated,
   because the alternative is a truncated prompt and a confidently wrong
   answer. Escalation is logged — a small-tier call that keeps escalating is
   a prompt that grew, not a model that is too small.

2. MONEY. `llm_usage` already tracks spend. Past LLM_BUDGET_SOFT_PCT of the
   monthly budget the large tier is withdrawn; past 100% everything runs on
   small. Lumi keeps answering — degraded, never dark. A personal assistant
   that goes silent at month-end is worse than one that gets terser.

Configure per tier with NEBIUS_MODEL_SMALL / _MEDIUM / _LARGE. Nothing here
hard-fails on an unknown model id: `verify()` asks Nebius which models it
actually serves and logs loudly, because this project's failure mode has
always been silence, not crashes.
"""
import logging
import os
from typing import Optional

import config

logger = logging.getLogger(__name__)

SMALL, MEDIUM, LARGE = "small", "medium", "large"
_ORDER = (SMALL, MEDIUM, LARGE)


def _env(name: str, default: str) -> str:
    return os.getenv(name, "").strip() or default


# Defaults are the Nemotron 3 family on Nebius. Override per tier by secret if
# Nebius renames an id — that is a `fly secrets set`, not a deploy.
MODELS: dict[str, str] = {
    SMALL:  _env("NEBIUS_MODEL_SMALL",  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"),
    MEDIUM: _env("NEBIUS_MODEL_MEDIUM", "nvidia/nemotron-3-super-120b-a12b"),
    LARGE:  _env("NEBIUS_MODEL_LARGE",  "nvidia/Nemotron-3-Ultra-550b-a55b"),
}

# Usable context per tier, in tokens, with headroom left for the reply.
#
# These are the NEBIUS numbers, and they are much smaller than the same model's
# headline figure elsewhere: Nano is 32K on Nebius and 131K on NVIDIA's own NIM.
# Taking the bigger number would have meant nano never escalating — a 40K-token
# prompt would go out, come back truncated, and be answered confidently and
# wrongly. When Nebius changes a limit, change it here by secret.
CONTEXT: dict[str, int] = {
    SMALL:  int(_env("NEBIUS_CTX_SMALL",  "28000")),    # 32K, minus reply headroom
    MEDIUM: int(_env("NEBIUS_CTX_MEDIUM", "240000")),   # 262K
    LARGE:  int(_env("NEBIUS_CTX_LARGE",  "900000")),   # 1M
}

# Which tier each call site gets when money and tokens allow.
DEFAULT_TIER: dict[str, str] = {
    "task_extract":    SMALL,
    "understand":      MEDIUM,   # meaning, not keywords: the conversation → actions
    "profile_extract": SMALL,
    "email_events":    SMALL,
    "categorize":      SMALL,
    "judge":           SMALL,
    "chat":            MEDIUM,
    "agent":           MEDIUM,
    "meeting_brief":   MEDIUM,
    "task_prep_plan":  SMALL,    # is there anything worth preparing? which searches
    "task_prep":       MEDIUM,   # cited prep items from the searches
    "errand_understand": SMALL,  # is this an errand, and what to search on the map
    "errand_price": SMALL,       # read one price out of cited web snippets (code verifies it)
    "research":        LARGE,
}

# Hebrew tokenizes worse than English — roughly one token per 2.5 characters
# on a mixed he/en prompt. Deliberately pessimistic: over-estimating costs one
# escalation, under-estimating costs a truncated prompt.
_CHARS_PER_TOKEN = 2.5


def estimate_tokens(text: str) -> int:
    return int(len(text or "") / _CHARS_PER_TOKEN) + 1


def _budget_ceiling() -> Optional[str]:
    """Highest tier the budget still allows, or None for no limit."""
    budget = config.LLM_MONTHLY_BUDGET_USD
    if not budget or budget <= 0:
        return None
    try:
        import llm_usage
        spent = float(llm_usage.summary()["month"]["est_cost_usd"])
    except Exception as exc:  # noqa: BLE001 — accounting must never gate a reply
        logger.warning("budget check failed, assuming unlimited: %s", exc)
        return None
    used = spent / budget
    if used >= 1.0:
        return SMALL
    if used >= config.LLM_BUDGET_SOFT_PCT:
        return MEDIUM
    return None


def pick(source: str, *, prompt_chars: int = 0, tier: Optional[str] = None) -> str:
    """The model id for this call. `source` is the llm_usage source name."""
    chosen = tier or DEFAULT_TIER.get(source, MEDIUM)
    if chosen not in _ORDER:
        chosen = MEDIUM

    # 1. Tokens: climb until the prompt fits.
    need = int(prompt_chars / _CHARS_PER_TOKEN) if prompt_chars else 0
    if need:
        while need > CONTEXT[chosen] and chosen != LARGE:
            nxt = _ORDER[_ORDER.index(chosen) + 1]
            logger.info("model_router: %s needs ~%d tokens, %s → %s", source, need, chosen, nxt)
            chosen = nxt

    # 2. Money: never above the ceiling the budget leaves us.
    ceiling = _budget_ceiling()
    if ceiling and _ORDER.index(chosen) > _ORDER.index(ceiling):
        logger.warning("model_router: budget caps %s at %s (was %s)", source, ceiling, chosen)
        chosen = ceiling
        # Money wins over tokens on purpose — but say so loudly, because this
        # is the one path where a prompt can reach the provider too big for the
        # context and come back truncated instead of answered.
        if need > CONTEXT[chosen]:
            logger.error("model_router: %s needs ~%d tokens but the budget caps it at "
                         "%s (%d) — this reply may be truncated", source, need, chosen,
                         CONTEXT[chosen])

    return MODELS[chosen]


def tier_of(model: str) -> Optional[str]:
    for tier, name in MODELS.items():
        if name == model:
            return tier
    return None


async def verify() -> dict:
    """Ask Nebius which models it serves and report any tier pointing at one it
    does not. Called from /diag/models — never at import, so a slow or sleeping
    Nebius cannot hold up boot."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{config.LLM_ENDPOINT.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {config.LLM_API_KEY}"})
        served = {m["id"] for m in resp.json().get("data", [])}
    except Exception as exc:  # noqa: BLE001
        logger.warning("model verify failed: %s", exc)
        return {"ok": False, "error": str(exc)[:200]}

    report = {t: {"model": m, "served": m in served} for t, m in MODELS.items()}
    for tier, row in report.items():
        if not row["served"]:
            logger.error(
                "model_router: tier %s points at %r, which Nebius does NOT serve — "
                "set NEBIUS_MODEL_%s to one of: %s",
                tier, row["model"], tier.upper(),
                ", ".join(sorted(s for s in served if "emotron" in s.lower())) or "(no Nemotron found)")
    return {"ok": True, "tiers": report,
            "nemotron_available": sorted(s for s in served if "emotron" in s.lower())}
