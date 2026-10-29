"""feedback_store — 👍/👎 on what Meira suggested, and what it changes next time.

Koral asked (29.9) how Meira learns — "the reinforcement learning?". The honest
answer was: from what she SAYS (save_memory) and from how long things took
(LearningService), never from whether a suggestion was any good. A laundromat
she hated could be Meira's pick every week.

A verdict now does two things, and each one is visible:

1. RANKING, in code. A place she liked moves up the errand list; a place she
   turned down drops below everything she has not judged, and is never
   "Meira's pick" again. Deterministic: the same verdicts give the same order,
   and the card says "you liked it before" when that is the reason.

2. MEMORY, in words. One sentence goes into user_memory as a preference
   ("didn't want: prep for karaoke — not useful") — the store save_memory
   writes to, which is shadowed and embedded — AND the last few verdicts are
   handed straight to the models that plan prep and errands. Straight, because
   retrieval only works when embeddings are up; a thumbs-down must not depend
   on that to count.

Store: {user_key: [verdict, …]}, newest last, capped. Encrypted (secure_store).
Deleted with the account (account_deletion._STORE_MODULES).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

import config
import identity_keys
import secure_store

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "feedback.json")
_MAX_PER_USER = 200
SURFACES = ("errand", "prep", "brief")
VERDICTS = ("up", "down")


def _load() -> dict:
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def _clean(s: Optional[str], n: int) -> str:
    return " ".join(str(s or "").split())[:n]


def sentence(v: dict) -> str:
    """The verdict as one line a model (and she) can read."""
    what = {"errand": "place for an errand", "prep": "preparation", "brief": "meeting brief"}[v["surface"]]
    subject = v.get("subject") or ""
    about = f" ({v['about']})" if v.get("about") else ""
    reason = f" — {v['reason']}" if v.get("reason") else ""
    if v["verdict"] == "up":
        return f"liked {what}: {subject}{about}{reason}"
    return f"did not want {what}: {subject}{about}{reason}"


def record(user_key: str, surface: str, verdict: str, subject: str, *,
           place_id: Optional[str] = None, about: Optional[str] = None,
           reason: Optional[str] = None) -> dict:
    """Store one verdict. Raises ValueError on a bad surface/verdict/subject."""
    if surface not in SURFACES:
        raise ValueError(f"surface must be one of {SURFACES}")
    if verdict not in VERDICTS:
        raise ValueError(f"verdict must be one of {VERDICTS}")
    subject = _clean(subject, 120)
    if not subject:
        raise ValueError("subject is required")
    v = {"surface": surface, "verdict": verdict, "subject": subject,
         "place_id": _clean(place_id, 200) or None, "about": _clean(about, 80) or None,
         "reason": _clean(reason, 60) or None, "at": time.time()}
    data = _load()
    mine = [x for x in data.get(user_key, [])
            # A new verdict on the same thing replaces the old one: she changed her mind.
            if not (x.get("surface") == surface and x.get("subject") == subject
                    and x.get("place_id") == v["place_id"])]
    mine.append(v)
    data[user_key] = mine[-_MAX_PER_USER:]
    _save(data)
    try:
        import user_memory
        user_memory.add_insight(user_key, "preference", sentence(v))
    except Exception as exc:  # noqa: BLE001 — the ranking half still counts
        logger.warning("feedback: memory insight not saved: %s", exc)
    return v


def verdicts(user_key: str, surface: Optional[str] = None) -> list:
    """Her verdicts, oldest first — under every key she was stored with
    (identity_keys): the app routes recorded them under her phone until 6.10."""
    data = _load()
    rows = [r for k in (identity_keys.keys_of(user_key) or [user_key]) for r in data.get(k, [])]
    rows.sort(key=lambda r: r.get("at") or 0)
    return [r for r in rows if not surface or r.get("surface") == surface]


def place_verdict(user_key: str, place_id: Optional[str]) -> Optional[str]:
    """'up' | 'down' | None — her latest word on this place."""
    if not place_id:
        return None
    for r in reversed(verdicts(user_key, "errand")):
        if r.get("place_id") == place_id:
            return r.get("verdict")
    return None


def lines(user_key: str, surface: str, n: int = 5) -> str:
    """Her last few verdicts on this surface, for a model's MEMORY block."""
    rows = verdicts(user_key, surface)[-n:]
    return "\n".join(f"- {sentence(r)}" for r in rows)
