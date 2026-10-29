"""Per-phone conversation focus — WHICH task the user is currently talking about.

Without this, every message is handled statelessly: 'from home, by bus' about
Thursday's interview got routed to tonight's party (the soonest located task),
and 'remind me to leave' attached to an old class. The focus records the task
just discussed so follow-up turns (travel mode, 'from home', 'remind me') resolve
to THAT task instead of a fuzzy/soonest guess.

Stored like reminders.json (flat JSON in DATA_DIR, keyed by phone). A focus is
short-lived — it expires so a stale one never hijacks an unrelated later message.
"""
import logging
import os
from typing import Optional

import config
import secure_store
from tz import now_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "active_session.json")
_TTL_SECONDS = 45 * 60   # a focus lasts 45 min of real time


def _digits(phone: str) -> str:
    """The store key: a phone's digits, so +972… and 972… are one person. A key
    with no digits at all keeps itself — it used to become "", one slot shared
    by everyone keyed that way (27.10 security review)."""
    raw = str(phone or "")
    return "".join(ch for ch in raw if ch.isdigit()) or raw


def _load() -> dict:
    """Encrypted (secure_store): entries name destinations. This used to be the
    one store left plaintext — and the boot migration's envelope was then read
    back here as a plain dict and re-written plaintext, every time."""
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    """Expired focus/choices are dropped, not kept: a destination from last week
    is a record of where she went, not context."""
    now = now_il().timestamp()
    horizon = max(_TTL_SECONDS, _PICK_TTL_SECONDS, _MAYBE_TTL_SECONDS)
    def live(entry) -> bool:
        if not isinstance(entry, dict):
            return False
        stamps = [float(v.get("at", 0)) for v in entry.values() if isinstance(v, dict)]
        stamps.append(float(entry.get("at", 0) or 0))
        newest = max(stamps)
        return newest <= 0 or now - newest <= horizon   # undated: not ours to judge
    secure_store.write_json(_PATH, {k: v for k, v in data.items() if live(v)})


def set_active_task(phone: str, task_id: Optional[str], dest: Optional[str] = None) -> None:
    """Mark `task_id` as the task in focus for this phone. No-op without an id."""
    if not task_id:
        return
    data = _load()
    kept = {k: v for k, v in (data.get(_digits(phone)) or {}).items()
            if k in ("last_saved", "pending_place", "maybe", "pending_fit", "state")}
    data[_digits(phone)] = {**kept, "task_id": task_id, "dest": dest,
                            "at": now_il().timestamp()}
    _save(data)


def get_active_task_id(phone: str) -> Optional[str]:
    """The focused task id, or None if unset or expired."""
    entry = _load().get(_digits(phone))
    if not entry:
        return None
    if now_il().timestamp() - float(entry.get("at", 0)) > _TTL_SECONDS:
        return None
    return entry.get("task_id")


def clear_active_task(phone: str) -> None:
    data = _load()
    if data.pop(_digits(phone), None) is not None:
        _save(data)


# ── pending numbered choice ─────────────────────────────────────────────────
# Lumi asks several numbered questions ("pick a bus 1-3", "pick a job 1-5").
# A bare "3" is meaningless on its own — it belongs to WHOEVER ASKED LAST.
#
# This used to be a route-only boolean that main.py set by string-matching the
# English prose "Pick a bus" in the outgoing message. In Hebrew that substring
# never appears, so the flag never set, and a bare number fell through to the HR
# job picker — typing "3" for a bus tailored a CV instead. Prose is translated;
# branching on it is the bug. The owner is recorded structurally instead, so it
# works in any language and any future numbered question joins in for free.
_PICK_TTL_SECONDS = 20 * 60


def set_pending_choice(phone: str, owner: str, count: int,
                       options: Optional[list] = None,
                       context: Optional[dict] = None) -> None:
    """Record that `owner` just asked a question with `count` numbered options.

    `options` and `context` are what makes the ANSWER usable. Until now only the
    count was kept, so a reply of "3" told us a ride was being picked and
    nothing about which ride — the pick was handed to the model, which had no
    access to the timetable it had just printed and answered "לא הבנתי" while
    re-asking where she was leaving from. Storing the rendered options (and the
    plan they belong to) is what lets the pick be honoured deterministically."""
    data = _load()
    entry = data.get(_digits(phone)) or {}
    entry["pending_choice"] = {"owner": owner, "count": int(count),
                               "at": now_il().timestamp()}
    if options is not None:
        entry["pending_choice"]["options"] = options
    if context is not None:
        entry["pending_choice"]["context"] = context
    data[_digits(phone)] = entry
    _save(data)


def get_pending_choice(phone: str) -> Optional[dict]:
    """The open numbered question ({owner, count}), or None if unset/expired."""
    entry = _load().get(_digits(phone))
    choice = (entry or {}).get("pending_choice")
    if not choice:
        return None
    if now_il().timestamp() - float(choice.get("at", 0)) > _PICK_TTL_SECONDS:
        return None
    return choice


def choice_owner(phone: str, number: int) -> Optional[str]:
    """Who owns a bare `number` right now — None if nobody asked, or if the
    number is outside the range that was actually offered."""
    choice = get_pending_choice(phone)
    if not choice:
        return None
    if not (1 <= number <= int(choice.get("count") or 0)):
        return None
    return choice.get("owner")


def clear_pending_choice(phone: str) -> None:
    data = _load()
    entry = data.get(_digits(phone))
    if entry and entry.pop("pending_choice", None) is not None:
        _save(data)


# ── what this conversation just saved ────────────────────────────────────────
# "מתי?" right after "saved ✓" is about THOSE tasks (27.10: she asked "when?"
# twice and Meira did not know what she meant). Kept apart from the focus,
# which one save overwrites with the last task of a list.
_SAVED_TTL_SECONDS = 45 * 60


def set_last_saved(phone: str, task_ids: list) -> None:
    ids = [str(t) for t in task_ids or [] if t]
    if not ids:
        return
    data = _load()
    entry = data.get(_digits(phone)) or {}
    entry["last_saved"] = {"ids": ids[:12], "at": now_il().timestamp()}
    data[_digits(phone)] = entry
    _save(data)


def get_last_saved(phone: str) -> list:
    entry = _load().get(_digits(phone)) or {}
    saved = entry.get("last_saved") or {}
    if now_il().timestamp() - float(saved.get("at", 0) or 0) > _SAVED_TTL_SECONDS:
        return []
    return list(saved.get("ids") or [])


# ── a trip waiting for a place ("where is your gym?") ────────────────────────
# 27.10: Meira routed "the gym" to a school, she wrote "my gym is not in
# Herzliya", then "יגאל אלון 76" — and the address went nowhere. The trip is
# kept here so her next message, if it is a place, is saved and routed.
_PLACE_TTL_SECONDS = 20 * 60


def set_pending_place(phone: str, pending: dict) -> None:
    data = _load()
    entry = data.get(_digits(phone)) or {}
    entry["pending_place"] = {**pending, "at": now_il().timestamp()}
    data[_digits(phone)] = entry
    _save(data)


def get_pending_place(phone: str) -> Optional[dict]:
    entry = _load().get(_digits(phone)) or {}
    pending = entry.get("pending_place")
    if not pending or now_il().timestamp() - float(pending.get("at", 0)) > _PLACE_TTL_SECONDS:
        return None
    return pending


def clear_pending_place(phone: str) -> None:
    data = _load()
    entry = data.get(_digits(phone))
    if entry and entry.pop("pending_place", None) is not None:
        data[_digits(phone)] = entry
        _save(data)


# ── a task that does not fit, waiting for her answer ─────────────────────────
# 28.10: "warn that it's impossible, and ask — save anyway or find a new time".
# The task is saved; this remembers the question so "לקבוע ב-15:30" / "לשמור
# בכל זאת" acts on THAT task (fit_check.reading).
_FIT_TTL_SECONDS = 30 * 60


def set_pending_fit(phone: str, pending: dict) -> None:
    data = _load()
    entry = data.get(_digits(phone)) or {}
    entry["pending_fit"] = {**pending, "at": now_il().timestamp()}
    data[_digits(phone)] = entry
    _save(data)


def get_pending_fit(phone: str) -> Optional[dict]:
    entry = _load().get(_digits(phone)) or {}
    pending = entry.get("pending_fit")
    if not pending or now_il().timestamp() - float(pending.get("at", 0)) > _FIT_TTL_SECONDS:
        return None
    return pending


def clear_pending_fit(phone: str) -> None:
    data = _load()
    entry = data.get(_digits(phone))
    if entry and entry.pop("pending_fit", None) is not None:
        data[_digits(phone)] = entry
        _save(data)


# ── a move waiting for the other person ("maybe" until he confirms) ─────────
_MAYBE_TTL_SECONDS = 3 * 24 * 3600


def set_maybe(phone: str, task_id: str, who: str) -> None:
    data = _load()
    entry = data.get(_digits(phone)) or {}
    entry["maybe"] = {"task_id": str(task_id), "who": who, "at": now_il().timestamp()}
    data[_digits(phone)] = entry
    _save(data)


def get_maybe(phone: str) -> Optional[dict]:
    entry = _load().get(_digits(phone)) or {}
    maybe = entry.get("maybe")
    if not maybe or now_il().timestamp() - float(maybe.get("at", 0)) > _MAYBE_TTL_SECONDS:
        return None
    return maybe


def clear_maybe(phone: str) -> None:
    data = _load()
    entry = data.get(_digits(phone))
    if entry and entry.pop("maybe", None) is not None:
        data[_digits(phone)] = entry
        _save(data)


# ── a follow-up offer ("study time? at what hour?") ───────────────────────────
# Meira moved an interview and asked ONE question; the next short message is the
# answer to it, in any words. Stored structurally, like pending_choice, so the
# answer is read as an answer — never as a new task. Expires: a "yes" an hour
# later is about something else.
_OFFER_TTL_SECONDS = 20 * 60


def set_pending_offer(phone: str, offer: dict) -> None:
    data = _load()
    entry = data.get(_digits(phone)) or {}
    entry["pending_offer"] = {**offer, "at": now_il().timestamp()}
    data[_digits(phone)] = entry
    _save(data)


def get_pending_offer(phone: str) -> Optional[dict]:
    entry = _load().get(_digits(phone))
    offer = (entry or {}).get("pending_offer")
    if not offer:
        return None
    if now_il().timestamp() - float(offer.get("at", 0)) > _OFFER_TTL_SECONDS:
        return None
    return offer


def clear_pending_offer(phone: str) -> None:
    data = _load()
    entry = data.get(_digits(phone))
    if entry and entry.pop("pending_offer", None) is not None:
        data[_digits(phone)] = entry
        _save(data)


# ── the conversation's working state (29.10) ─────────────────────────────────
# Not the transcript: what the conversation has ESTABLISHED — the last
# message's frame, the task it was about, what she corrected or turned down.
# Fed to the understanding step and stamped for the agent, so "Can you
# schedule Zumba?" after "I'm on vacation Monday" is read with Monday closed.
_STATE_TTL_SECONDS = 6 * 3600


def set_state(phone: str, state: dict) -> None:
    data = _load()
    entry = data.get(_digits(phone)) or {}
    entry["state"] = {**state, "at": now_il().timestamp()}
    data[_digits(phone)] = entry
    _save(data)


def get_state(phone: str) -> dict:
    entry = _load().get(_digits(phone)) or {}
    st = entry.get("state") or {}
    if now_il().timestamp() - float(st.get("at", 0) or 0) > _STATE_TTL_SECONDS:
        return {}
    return {k: v for k, v in st.items() if k != "at"}
