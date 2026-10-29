"""The last door before Nebius — every model call passes through here.

Two hard stops, on top of user_quota's per-person dollar allowance (7.10,
Koral: "limit users to 10 AI calls a day; never go below $0 in Token Factory;
I must not end up in debt"):

  1. BALANCE. Token Factory is prepaid. We cannot read the balance through its
     API, so she tells us what it was on a date (TOKEN_FACTORY_BALANCE_USD +
     TOKEN_FACTORY_BALANCE_DATE) and we subtract what llm_usage recorded since
     — the whole of that day, unknown models at the dearest known price, so the
     estimate errs towards stopping early. When what is left reaches
     LLM_RESERVE_USD (default $10, for calls the ledger cannot see) NOTHING
     reaches the model, for anyone, the owner included.
  2. REQUESTS. Each person gets USER_AI_DAILY_REQUESTS (default 10) requests a
     day that use the AI — one chat message, one mic command, one brief. A
     request that makes several model calls (the ReAct loop, the judge after
     it) counts once. Counted in user_quota.admit().

Refused here = a synthetic HTTP 402 from the transport: the OpenAI SDK raises
an APIStatusError without retrying, and every caller's existing failure path
runs. The chat entries ask user_quota.blocked_reply() FIRST, so she reads one
line saying why instead of a generic failure (silent-state rule 1).

Every AsyncOpenAI pointed at Nebius must come from client() below;
tests/test_ai_gate.py fails on any other construction.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

import importlib

from openai import AsyncOpenAI, DefaultAsyncHttpxClient

# The HTTP library the SDK's own client is built on. openai >= 3 sends through
# httpx2, a fork with its own Response/stream types; a guard built on plain
# httpx hands it a response it rejects with a bare `assert` (no message). That
# was every model call on the 8.10 deploy: "model step failed:" and nothing
# else. So the guard takes its types from the SDK, never from a guess.
_http = importlib.import_module(next(
    c for c in DefaultAsyncHttpxClient.__mro__ if c.__name__ == "AsyncClient").__module__.split(".")[0])

import config

logger = logging.getLogger(__name__)

_CACHE_S = 15.0
_cache: tuple[float, Optional[dict]] = (0.0, None)


def _num(name: str, default: str) -> float:
    try:
        return max(0.0, float(os.getenv(name, default) or 0))
    except ValueError:
        logger.warning("ai_gate: %s is not a number, using %s", name, default)
        return float(default)


def _price(model: str) -> tuple[float, float]:
    import llm_usage
    known = llm_usage.price_of(model)
    if known:
        return known
    # Unknown model: the dearest price we know. Stopping early beats debt.
    return max(llm_usage.PRICES.values(), key=lambda p: p[0] + p[1])


def _spent_since(day: str) -> float:
    import llm_usage
    total = 0.0
    for d, row in llm_usage._load().items():
        if d < day or not isinstance(row, dict):
            continue
        by_model = row.get(llm_usage.BY_MODEL)
        if by_model:
            for model, m in by_model.items():
                pin, pout = _price(model)
                total += (m.get("in", 0) * pin + m.get("out", 0) * pout) / 1_000_000
        else:
            pin, pout = _price("")
            for src, m in row.items():
                if isinstance(m, dict) and "in" in m:
                    total += (m.get("in", 0) * pin + m.get("out", 0) * pout) / 1_000_000
    return total


def balance(fresh: bool = False) -> dict:
    """What is left of the prepaid balance, by our own count."""
    global _cache
    now = time.monotonic()
    if not fresh and _cache[1] is not None and now - _cache[0] < _CACHE_S:
        return _cache[1]
    start = _num("TOKEN_FACTORY_BALANCE_USD", "0")
    since = (os.getenv("TOKEN_FACTORY_BALANCE_DATE") or "").strip()
    reserve = _num("LLM_RESERVE_USD", "10")
    if not start or not since:
        out = {"set": False, "closed": False,
               "why": "TOKEN_FACTORY_BALANCE_USD / _DATE not set — no balance stop"}
    else:
        try:
            spent = _spent_since(since)
        except Exception as exc:  # noqa: BLE001 — unreadable ledger: stop, don't guess
            logger.error("ai_gate: usage ledger unreadable, AI closed: %s", exc)
            out = {"set": True, "closed": True, "why": f"ledger unreadable: {exc}"}
        else:
            left = start - spent
            out = {"set": True, "balance_usd": start, "since": since,
                   "spent_usd": round(spent, 4), "remaining_usd": round(left, 4),
                   "reserve_usd": reserve, "closed": left <= reserve}
    _cache = (now, out)
    return out


def closed() -> bool:
    b = balance()
    if b["closed"]:
        logger.error("ai_gate: AI closed — balance stop (%s)", b)
    return b["closed"]


def refusal() -> Optional[str]:
    """None to let this model call through, else why not ('balance'|'requests')."""
    if closed():
        return "balance"
    import user_quota
    return user_quota.admit()


_MESSAGES = {
    "balance": "Meira's AI budget is used up — the call was not made",
    "requests": "Daily AI requests for this person are used up — the call was not made",
}


def _thinking_on() -> bool:
    """LLM_THINKING=on brings Nemotron's hidden reasoning back, for an experiment."""
    return os.getenv("LLM_THINKING", "off").strip().lower() in ("on", "1", "true")


def without_thinking(request):
    """The same chat request with Nemotron's hidden reasoning switched off.

    Nemotron 3 nano AND super think before every answer unless told not to,
    and nobody had told them (probed on Fly, 19.10: a one-line JSON reply cost
    44-47 tokens with thinking, 6 without; super returned 131 chars of
    reasoning_content nobody reads). Every reply paid for it in seconds, and the
    ledger showed calls ending exactly at their max_tokens cap — email_events at
    600 every time — i.e. reasoning ate the budget meant for the answer.
    `/no_think` in the prompt does NOT turn it off; chat_template_kwargs does.

    One place, so no call site can forget it. A caller that set
    chat_template_kwargs itself is left alone."""
    if _thinking_on() or request.method != "POST" or not request.url.path.endswith("/chat/completions"):
        return request
    try:
        body = json.loads(request.read() or b"{}")
    except (ValueError, TypeError) as exc:
        logger.warning("ai_gate: request body unreadable, thinking left as is: %s", exc)
        return request
    if not isinstance(body, dict) or "chat_template_kwargs" in body:
        return request
    body["chat_template_kwargs"] = {"enable_thinking": False}
    headers = [(k, v) for k, v in request.headers.raw if k.lower() != b"content-length"]
    return _http.Request(request.method, request.url, headers=headers,
                         content=json.dumps(body).encode(), extensions=request.extensions)


class _Guard(_http.AsyncBaseTransport):
    def __init__(self, inner):
        self._inner = inner

    async def handle_async_request(self, request):
        why = refusal()
        if why:
            logger.warning("ai_gate: refused %s %s — %s", request.method, request.url.path, why)
            return _http.Response(402, request=request, json={"error": {
                "message": _MESSAGES[why], "type": "meira_ai_limit", "code": why}})
        return await self._inner.handle_async_request(without_thinking(request))

    async def aclose(self) -> None:
        await self._inner.aclose()


def http_client(inner=None):
    """The SDK's client, every request through the guard. `inner` is for tests."""
    return DefaultAsyncHttpxClient(transport=_Guard(inner or _http.AsyncHTTPTransport()))


#: A call with no timeout of its own waited up to the SDK's 600 s, three times
#: (2 retries), under a loop that retries again — while the app gave up at 90 s.
#: Now 30 s and one retry: the worst case fits inside the app's wait. A call
#: that passes timeout= keeps its own.
CALL_TIMEOUT_S = _num("LLM_CALL_TIMEOUT_S", "30")


def client(api_key: Optional[str] = None, base_url: Optional[str] = None) -> AsyncOpenAI:
    """The ONLY way to build a Nebius client."""
    return AsyncOpenAI(api_key=api_key or config.LLM_API_KEY,
                       base_url=base_url or config.LLM_ENDPOINT,
                       http_client=http_client(),
                       timeout=CALL_TIMEOUT_S, max_retries=1)
