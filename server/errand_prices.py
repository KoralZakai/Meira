"""errand_prices — what an errand will COST, from the web (Tavily), never guessed.

Koral, 29.9: "laundry — get a location, opening hours AND cost… recommend which
laundry to go to that's already on my way". errands_along answers where and
when (Google Places: the route, the hours at the minute she passes). Google
knows a price LEVEL ($–$$$$) at best. The actual number — "₪35 a load",
"wash & fold ₪12/kg", "basic car wash ₪45" — lives on the business's own page,
a price list, a review. That is a live-web question, which is Tavily's job.

TWO STEPS, and the second one is code, not trust:

1. SEARCH (Tavily). Per shortlisted place, one query about THE PLACE — its
   name, its city, the service — never about her.
2. READ (Nemotron Nano). Out of the numbered snippets, one line: the price
   and the source number, or nothing.
   Then CODE checks it: every number in the price line must appear, verbatim,
   in the snippet it cites. A price the page does not say is dropped before
   she sees it. A model that invents "₪30" is worse than no price at all —
   she would go there expecting it.

Cache: in memory, per place, 24 h. Prices are public facts about a business,
not about her, and a sleeping machine forgetting them costs one search.
Nothing personal is stored, so there is no store to delete with the account.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Optional

import ai_gate
import config
import llm_usage
import model_router
import tavily_search

logger = logging.getLogger(__name__)

_TTL_S = 24 * 3600
_cache: dict[str, tuple[float, Optional[dict]]] = {}
MAX_PLACES = 3

_SYSTEM = """You read web snippets about ONE local business and report what \
the service costs there.

Rules:
- Use ONLY the snippets. If none states a price for this business, return \
{"price": "", "source": 0}.
- "price": max 60 characters, the number(s) exactly as written, with the \
currency and unit ("₪35 per load", "from ₪12/kg", "₪45 basic wash").
- "source": the snippet number the price came from.
- Write "price" in the language of the snippet.

Return JSON only: {"price": "", "source": 0}"""

_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")


def _city(address: Optional[str]) -> str:
    """'Dizengoff 50, Tel Aviv-Yafo, Israel' → 'Tel Aviv-Yafo'."""
    parts = [p.strip() for p in str(address or "").split(",") if p.strip()]
    parts = [p for p in parts if p.lower() not in ("israel", "ישראל") and not p.isdigit()]
    return parts[-1] if len(parts) >= 2 else ""


def query_for(place: dict, service: str) -> str:
    """About the place and the service — nothing about her."""
    return " ".join(x for x in (f'"{place.get("name")}"', _city(place.get("address")), service, "מחיר price") if x)


def verified(price: str, snippet: str) -> bool:
    """Every number in the price line must appear in the cited snippet."""
    nums = _NUM_RE.findall(price or "")
    if not nums:
        return False
    hay = (snippet or "").replace(",", "")
    # Whole numbers only: "35" must not be found inside "135".
    return all(re.search(rf"(?<![\d.]){re.escape(n.replace(',', ''))}(?![\d])", hay) for n in nums)


async def _read(place: dict, service: str, sources: list[dict]) -> Optional[dict]:
    listing = "\n".join(f"[{i+1}] {s.get('title')}\n{(s.get('snippet') or '')[:700]}"
                        for i, s in enumerate(sources))
    user = f"BUSINESS: {place.get('name')} — {place.get('address') or ''}\nSERVICE: {service}\n\nSNIPPETS:\n{listing}"
    model = model_router.pick("errand_price", prompt_chars=len(_SYSTEM) + len(user))
    client = ai_gate.client()
    try:
        resp = await client.chat.completions.create(
            model=model, temperature=0.0, max_tokens=80, timeout=30,
            messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}],
            response_format={"type": "json_object"},
        )
    except Exception as exc:  # noqa: BLE001 — no price is not a failed errand
        logger.warning("errand_prices read failed: %s", exc)
        return None
    usage = getattr(resp, "usage", None)
    if usage:
        llm_usage.record("errand_price", usage.prompt_tokens or 0, usage.completion_tokens or 0, model)
    try:
        raw = json.loads(resp.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        return None
    return raw if isinstance(raw, dict) else None


async def price_for(place: dict, service: str) -> dict:
    """{price, source_title, source_url} or {reason}. Never a guessed number."""
    pid = str(place.get("place_id") or place.get("name") or "")
    hit = _cache.get(pid)
    if hit and time.time() - hit[0] < _TTL_S:
        return hit[1] or {"reason": "no_price_published", "cached": True}
    if not tavily_search.is_configured():
        return {"reason": "search_not_configured"}

    res = await tavily_search.search(query_for(place, service), max_results=5)
    if not res.get("ok"):
        # Rule 1: a dead key is not "no price".
        return {"reason": f"search_failed: {res.get('error')}"}
    sources = [r for r in res.get("results") or [] if r.get("snippet")]
    if not sources:
        _cache[pid] = (time.time(), None)
        return {"reason": "no_price_published"}

    raw = await _read(place, service, sources)
    if raw is None:
        return {"reason": "read_failed"}
    price = str(raw.get("price") or "").strip()[:60]
    try:
        n = int(raw.get("source") or 0)
    except (TypeError, ValueError):
        n = 0
    if not price or not (1 <= n <= len(sources)):
        _cache[pid] = (time.time(), None)
        return {"reason": "no_price_published"}
    src = sources[n - 1]
    if not verified(price, f"{src.get('title') or ''} {src.get('snippet') or ''}"):
        logger.warning("errand_prices: dropped a price its source does not state (%s)", place.get("name"))
        _cache[pid] = (time.time(), None)
        return {"reason": "price_not_in_source"}
    out = {"price": price, "source_title": src.get("title"), "source_url": src.get("link")}
    _cache[pid] = (time.time(), out)
    return out


async def enrich(candidates: list[dict], service: str) -> list[dict]:
    """Add `price` (or `price_reason`) to the first MAX_PLACES candidates."""
    for c in candidates[:MAX_PLACES]:
        try:
            got = await price_for(c, service)
        except Exception as exc:  # noqa: BLE001 — a price is a bonus
            logger.warning("errand_prices: %s", exc)
            got = {"reason": f"error: {type(exc).__name__}"}
        if got.get("price"):
            c["price"] = got
        else:
            c["price_reason"] = got.get("reason")
    return candidates
