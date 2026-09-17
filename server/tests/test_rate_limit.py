"""A ceiling on what one caller can cost — and one that cannot itself fail open.

Written before sharing the app with new users. Two doors run a full ReAct turn
(up to 15 tool calls on a 235B model) and neither had a limit:

  POST /agent/chat       authentication bounds WHO, never HOW MUCH. One
                         signed-in friend in a retry loop spends Koral's
                         Nebius credits as fast as the network allows.
  POST /webhook/whatsapp public, and — until WHATSAPP_APP_SECRET is set —
                         accepts any JSON at all. A forged body is one curl,
                         and each one is a paid turn.

The per-number limit is not enough on its own for the second: forged bodies
each name a DIFFERENT number, so every one of them looks like a new user with
a fresh allowance. That is why there is a global webhook ceiling as well, and
why this file tests it separately.
"""
from __future__ import annotations

import pytest

import rate_limit


@pytest.fixture(autouse=True)
def _clean():
    rate_limit.reset()
    yield
    rate_limit.reset()


def test_under_the_limit_is_allowed():
    for i in range(5):
        assert rate_limit.allow("a", limit=5, window_s=60, now=100.0), f"call {i}"


def test_the_call_past_the_limit_is_refused():
    for _ in range(5):
        rate_limit.allow("a", limit=5, window_s=60, now=100.0)
    assert not rate_limit.allow("a", limit=5, window_s=60, now=100.0)


def test_callers_do_not_share_an_allowance():
    """One noisy user must not lock everyone else out — the limit is per key."""
    for _ in range(5):
        rate_limit.allow("noisy", limit=5, window_s=60, now=100.0)
    assert not rate_limit.allow("noisy", limit=5, window_s=60, now=100.0)
    assert rate_limit.allow("quiet", limit=5, window_s=60, now=100.0)


def test_the_window_rolls_over():
    for _ in range(5):
        rate_limit.allow("a", limit=5, window_s=60, now=100.0)
    assert not rate_limit.allow("a", limit=5, window_s=60, now=100.0)
    # A full window later the allowance is fresh.
    assert rate_limit.allow("a", limit=5, window_s=60, now=161.0)


def test_the_window_does_not_roll_over_early():
    for _ in range(5):
        rate_limit.allow("a", limit=5, window_s=60, now=100.0)
    assert not rate_limit.allow("a", limit=5, window_s=60, now=159.9)


def test_an_unchecked_call_still_spends_its_allowance():
    """A caller that ignores the answer must not get a free ride.

    The dangerous shape is a forgotten `if not allow(...)`: if `allow` only
    counted the calls whose result was honoured, that mistake would be
    invisible AND free. It counts the call it is asked about, full stop.
    """
    for _ in range(6):
        rate_limit.allow("a", limit=5, window_s=60, now=100.0)   # result dropped
    assert not rate_limit.allow("a", limit=5, window_s=60, now=100.0)


def test_check_raises_with_a_usable_retry_after():
    for _ in range(5):
        rate_limit.check("a", limit=5, window_s=60, now=100.0)
    with pytest.raises(rate_limit.RateLimited) as exc:
        rate_limit.check("a", limit=5, window_s=60, now=130.0)
    # Half the window gone, so roughly half of it left — and never zero, which
    # would invite an immediate retry.
    assert 0 < exc.value.retry_after <= 60
    assert exc.value.retry_after >= 1


def test_check_is_silent_while_under_the_limit():
    for _ in range(5):
        rate_limit.check("a", limit=5, window_s=60, now=100.0)   # must not raise


def test_the_key_table_does_not_grow_without_bound():
    """A public endpoint invites one key per forged caller; memory is bounded.

    Old windows are dropped once the table is large, so what is retained is the
    number of DISTINCT callers in one window, not the number ever seen.
    """
    for i in range(rate_limit._MAX_KEYS + 500):      # noqa: SLF001 — testing the bound
        rate_limit.allow(f"k{i}", limit=1, window_s=1, now=0.0)
    # Everything above is inside one window, so nothing is collectable yet.
    assert len(rate_limit._hits) <= rate_limit._MAX_KEYS + 500   # noqa: SLF001
    # A later call is past that window, so the sweep can drop the old keys.
    rate_limit.allow("fresh", limit=1, window_s=1, now=10.0)
    assert len(rate_limit._hits) < 10, len(rate_limit._hits)     # noqa: SLF001


def test_the_shipped_ceilings_are_sane():
    """Guards against a zero or a missing value silently disabling a limit."""
    for limit, window in (
        (rate_limit.CHAT_LIMIT, rate_limit.CHAT_WINDOW_S),
        (rate_limit.WHATSAPP_LIMIT, rate_limit.WHATSAPP_WINDOW_S),
        (rate_limit.WEBHOOK_GLOBAL_LIMIT, rate_limit.WEBHOOK_GLOBAL_WINDOW_S),
    ):
        assert limit > 0 and window > 0
    # A human day is a few dozen messages; the ceiling must sit above real use
    # and well below a loop.
    assert 10 <= rate_limit.CHAT_LIMIT <= 120
    # The global webhook ceiling has to exceed one person's, or a single real
    # user would trip it alone.
    assert rate_limit.WEBHOOK_GLOBAL_LIMIT > rate_limit.WHATSAPP_LIMIT


def test_a_forged_flood_of_distinct_numbers_is_still_stopped():
    """The attack the per-number limit cannot see.

    Each forged body names a different `from`, so every one looks like a new
    user with a full allowance. Only the global ceiling catches it.
    """
    allowed = 0
    for i in range(rate_limit.WEBHOOK_GLOBAL_LIMIT * 2):
        per_number = rate_limit.allow(
            f"wa:{i}", rate_limit.WHATSAPP_LIMIT, rate_limit.WHATSAPP_WINDOW_S, now=5.0)
        globally = rate_limit.allow(
            "wa:all", rate_limit.WEBHOOK_GLOBAL_LIMIT,
            rate_limit.WEBHOOK_GLOBAL_WINDOW_S, now=5.0)
        if per_number and globally:
            allowed += 1
    assert allowed == rate_limit.WEBHOOK_GLOBAL_LIMIT, allowed
