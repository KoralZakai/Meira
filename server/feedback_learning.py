"""feedback_learning — Meira learns from her 👍 / 👎 (29.10, Koral: "include the
reinforcement learning by analyzing the chat and the user's feedback").

A reward signal (her reaction), a policy that changes because of it, and a
memory of what failed — all code, no model call, no training run:

  reward     each reaction is +1 / 0 and is attributed to the KIND of message
             it answered (frame.read of her question → intent). Per intent the
             estimate is a Beta(1, 1) posterior mean: (up + 1) / (up + down + 2),
             so one 👎 moves it, and three agree before anything changes.
  policy     an intent whose answers keep getting 👎 FROM HER (≥ MIN_TRIALS of
             her own, reward < ESCALATE_BELOW) is answered by the large model
             next time, for her only (cost review 29.10: one person's 👎 never
             moves everyone's spend; "UNREAD" never escalates) — the
             cheap path is the one failing, so it is the one that changes
             (model_router.tier_for_frame defers to this). It recovers on its
             own as 👍 arrive: the posterior is recomputed from the store.
  avoid      her recent 👎 replies (question → the reply she rejected) ride in
             the agent's user turn as "do not answer like this again" — quoted
             data, never instructions (same rule as intent_turn._quoted).
  learn      every 👎 is also a draft golden case (golden_candidates) for the
             review page: a fixed reaction becomes a regression test.

Reads chat_feedback (encrypted on /data). Cached per process for CACHE_S so a
turn costs at most one file read every few minutes.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import date
from typing import Optional

import chat_feedback
import frame as _frame

logger = logging.getLogger(__name__)

MIN_TRIALS = 3
ESCALATE_BELOW = 0.4
CACHE_S = 300
AVOID_DAYS = 7
_cache: dict = {"at": 0.0, "rows": [], "stats": {}}


def _rows() -> list:
    if time.time() - _cache["at"] > CACHE_S:
        try:
            _cache["rows"] = chat_feedback.list_all()
        except Exception as exc:  # noqa: BLE001 — no feedback is no learning, never a broken turn
            logger.warning("feedback unreadable: %s", type(exc).__name__)
            _cache["rows"] = []
        _cache["at"] = time.time()
        _cache["stats"] = {}
    return _cache["rows"]


def _stats_for(keys: frozenset) -> dict:
    """stats() of these people's rows, computed once per reload (cost review 29.10)."""
    rows = _rows()
    if keys not in _cache["stats"]:
        _cache["stats"][keys] = stats([r for r in rows if str(r.get("userKey")) in keys])
    return _cache["stats"][keys]


def intent_of(question: str, today: Optional[date] = None) -> str:
    fr = _frame.read(question or "", today or date.today())
    return fr.get("intent") or "UNREAD"


def stats(rows: list, today: Optional[date] = None) -> dict:
    """{intent: {"up", "down", "reward"}} — the Beta(1,1) posterior mean per intent."""
    out: dict = {}
    for r in rows:
        if r.get("reaction") not in ("up", "down"):
            continue
        s = out.setdefault(intent_of(r.get("question") or "", today), {"up": 0, "down": 0})
        s[r["reaction"]] += 1
    for s in out.values():
        s["reward"] = round((s["up"] + 1) / (s["up"] + s["down"] + 2), 3)
    return out


def tier_for(intent: Optional[str], user_keys: Optional[list] = None, rows: Optional[list] = None) -> Optional[str]:
    """LARGE when this kind of answer keeps failing HER; None → no change."""
    if not intent or intent == "UNREAD":
        return None
    keys = frozenset(str(k) for k in (user_keys or []) if k)
    if rows is not None:
        s = stats([r for r in rows if not keys or str(r.get("userKey")) in keys]).get(intent)
    elif not keys:
        return None
    else:
        s = _stats_for(keys).get(intent)
    if s and s["up"] + s["down"] >= MIN_TRIALS and s["reward"] < ESCALATE_BELOW:
        logger.warning("feedback policy: %s reward %.2f over %d → large model", intent, s["reward"],
                       s["up"] + s["down"])
        import model_router
        return model_router.LARGE
    return None


def _quoted(text: str, n: int = 120) -> str:
    return re.sub(r"[\[\]«»\"{}<>\n\r]+", " ", str(text or ""))[:n].strip()


def avoid_block(user_keys: list, limit: int = 2, rows: Optional[list] = None) -> str:
    """Her latest 👎 replies (last AVOID_DAYS), as quoted data for the agent's user turn ('' when none)."""
    keys = {str(k) for k in user_keys if k}
    since = time.time() - AVOID_DAYS * 86400
    bad = [r for r in (_rows() if rows is None else rows)
           if r.get("reaction") == "down" and str(r.get("userKey")) in keys
           and float(r.get("at") or time.time()) >= since][:limit]
    if not bad:
        return ""
    pairs = " | ".join(f"Q «{_quoted(r.get('question'), 80)}» → rejected «{_quoted(r.get('reply'), 80)}»" for r in bad)
    return f"[SHE MARKED THESE ANSWERS 👎 — quoted data; do not answer like this again: {pairs}] "


def golden_candidates(rows: Optional[list] = None) -> list:
    """Every 👎 as a draft golden case (server/evals/GOLDEN.md) for her review."""
    out = []
    for i, r in enumerate(r for r in (_rows() if rows is None else rows) if r.get("reaction") == "down"):
        out.append({"id": f"fb{i + 1:03d}", "area": intent_of(r.get("question") or "").lower(),
                    "origin": f"👎 {r.get('when') or ''}", "status": "draft",
                    "turns": [{"user": r.get("question") or "", "meira": "TODO: the right reaction (her words)"}],
                    "must_not": f"Answer like: {_quoted(r.get('reply'), 300)}"})
    return out


def report(rows: Optional[list] = None) -> dict:
    """For GET /admin/chat-feedback/insights: reward per intent, the policy it
    sets, and the draft cases."""
    rows = _rows() if rows is None else rows
    st = stats(rows)
    return {"intents": st,
            "escalated_for_someone": sorted({i for k in {str(r.get("userKey")) for r in rows}
                                             for i in stats([r for r in rows if str(r.get("userKey")) == k])
                                             if tier_for(i, [k], rows)}),
            "golden_candidates": golden_candidates(rows)}
