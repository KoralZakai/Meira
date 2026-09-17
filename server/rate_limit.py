"""rate_limit — a ceiling on what one caller can cost, per window.

Every expensive door in this app was unlimited. Two of them matter:

  POST /agent/chat       authenticated, so not open to strangers — but one
                         signed-in friend in a loop is a full ReAct turn per
                         request (up to 15 tool calls on a 235B model) charged
                         to Koral's Nebius credits. Authentication bounds WHO,
                         never HOW MUCH.

  POST /webhook/whatsapp public, and accepted anything at all until
                         WHATSAPP_APP_SECRET is set. A forged message body is
                         one curl away and each one runs the same full turn.
                         The signature is the real fix; this is the ceiling
                         that holds while it is being set, and afterwards.

Deliberately in-process and dependency-free. This runs on a 256 MB Fly machine
that already lost LangGraph for its 35 MB — adding Redis or slowapi to count to
twenty would be the same mistake in a smaller hat. One machine means one
counter is the whole truth; if this ever scales out, the limits become
per-machine and the ceiling multiplies by the machine count, which is a safe
direction to be wrong in.

A fixed window, not a token bucket: the failure it guards against is a loop or
a script, and both are caught by either. A fixed window is ~15 lines and has no
refill arithmetic to get subtly wrong, and the worst case — 2x the limit across
a window boundary — is irrelevant when the limit exists to stop thousands.

Pure enough to test: `now` is injectable, so tests/test_rate_limit.py drives
every branch without sleeping.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

# key -> (window_started_at, count_in_window)
_hits: dict[str, tuple[float, int]] = {}
_lock = threading.Lock()

# Stop the dict growing without bound on a long-lived process: a key that has
# not been seen for a whole window is gone, so the memory is bounded by the
# number of DISTINCT callers in one window rather than ever seen.
_MAX_KEYS = 10_000


class RateLimited(Exception):
    """This caller has spent its allowance for the current window."""

    def __init__(self, retry_after: int):
        super().__init__(f"rate limited, retry in {retry_after}s")
        self.retry_after = retry_after


def allow(key: str, limit: int, window_s: float, now: Optional[float] = None) -> bool:
    """True when this call is within `limit` for the current window.

    Counts the call it allows — a caller that never checks the result still
    consumes its allowance, so a forgotten `if not allow(...)` fails toward
    counting rather than toward silence.
    """
    t = time.monotonic() if now is None else now
    with _lock:
        started, count = _hits.get(key, (t, 0))
        if t - started >= window_s:
            started, count = t, 0
        count += 1
        _hits[key] = (started, count)

        if len(_hits) > _MAX_KEYS:
            cutoff = t - window_s
            for k in [k for k, (s, _) in _hits.items() if s < cutoff]:
                _hits.pop(k, None)

        return count <= limit


def check(key: str, limit: int, window_s: float, now: Optional[float] = None) -> None:
    """`allow`, but raises RateLimited with a Retry-After. Raises, never returns."""
    t = time.monotonic() if now is None else now
    if allow(key, limit, window_s, t):
        return
    with _lock:
        started, _ = _hits.get(key, (t, 0))
    retry_after = max(1, int(window_s - (t - started)) + 1)
    raise RateLimited(retry_after)


def reset() -> None:
    """Forget every counter. For tests, and for nothing else."""
    with _lock:
        _hits.clear()


# ── The ceilings ─────────────────────────────────────────────────────────────
# Chosen against real use, not against a round number. A heavy human day on
# WhatsApp is a few dozen messages; a day of active app use is fewer. Anything
# above these is a loop, a script, or a bug — and all three should be stopped
# for the same reason, which is that Koral pays for them.

# One signed-in account, talking to the brain.
CHAT_LIMIT, CHAT_WINDOW_S = 30, 60.0
# One phone number, over WhatsApp.
WHATSAPP_LIMIT, WHATSAPP_WINDOW_S = 30, 60.0
# The whole webhook, whoever is calling. The per-number limit does nothing
# against forged bodies that each name a DIFFERENT number, which is exactly
# what an unauthenticated webhook invites; this is the ceiling that does.
WEBHOOK_GLOBAL_LIMIT, WEBHOOK_GLOBAL_WINDOW_S = 240, 60.0
