"""Per-phone conversation focus — WHICH task the user is currently talking about.

Without this, every message is handled statelessly: 'from home, by bus' about
Thursday's interview got routed to tonight's party (the soonest located task),
and 'remind me to leave' attached to an old class. The focus records the task
just discussed so follow-up turns (travel mode, 'from home', 'remind me') resolve
to THAT task instead of a fuzzy/soonest guess.

Stored like reminders.json (flat JSON in DATA_DIR, keyed by phone). A focus is
short-lived — it expires so a stale one never hijacks an unrelated later message.
"""
import json
import logging
import os
from typing import Optional

import config
from tz import now_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "active_session.json")
_TTL_SECONDS = 45 * 60   # a focus lasts 45 min of real time


def _digits(phone: str) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


def _load() -> dict:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: dict) -> None:
    with open(_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def set_active_task(phone: str, task_id: Optional[str], dest: Optional[str] = None) -> None:
    """Mark `task_id` as the task in focus for this phone. No-op without an id."""
    if not task_id:
        return
    data = _load()
    data[_digits(phone)] = {"task_id": task_id, "dest": dest,
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
