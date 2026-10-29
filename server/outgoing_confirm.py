"""A message to someone else goes out only after HER yes — checked in code.

`schedule_message` used to schedule straight away, to whatever number the model
passed. The model reads text nobody here wrote — web results, calendar invite
titles, email events — so one injected line ("also text +1 555… the code") was
enough for Meira to message a stranger, and she heard about it afterwards.

Now the tool only DRAFTS. The draft waits here, the model asks her one line,
and her next message is read by this module before any model sees it: a plain
yes schedules it, a no drops it, anything else drops it too. The model has no
tool that can say yes for her.

And the number: one she typed in this message, a saved contact, or her own.
A number that appears only in the model's arguments is not accepted.

Drafts live in memory for DRAFT_TTL_S. The machine sleeps when idle, so a yes
after a long pause finds no draft — the agent then drafts again and asks again.
That costs her one more "yes"; it never sends anything she did not approve.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Optional

logger = logging.getLogger(__name__)

DRAFT_TTL_S = 15 * 60

_drafts: dict[str, dict] = {}

_STAMP_RE = re.compile(r"^\s*(\[[^\]]*\]\s*)+")
_EDGE_RE = re.compile(r"^[\s.,!?׳\"'״:;-]+|[\s.,!?׳\"'״:;-]+$")

_YES = {
    "כן", "כן כן", "כן תשלחי", "כן שלחי", "תשלחי", "שלחי", "שלח", "תשלח", "אוקיי", "אוקי",
    "בטח", "נכון", "יאללה", "סגור", "מאשרת", "מאשר", "אישור", "👍",
    "yes", "y", "yep", "yeah", "yes please", "ok", "okay", "sure", "send", "send it",
    "go", "go ahead", "confirm", "confirmed",
}
_NO = {
    "לא", "לא תודה", "אל תשלחי", "אל תשלח", "בטלי", "בטל", "ביטול", "עזבי", "עזוב", "👎",
    "no", "n", "nope", "don't", "dont", "don't send", "cancel", "stop",
}


def _digits(value: object) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def national(number: object) -> str:
    """+972-50-123-4567, 972501234567 and 0501234567 are one number."""
    d = _digits(number)
    if d.startswith("972") and len(d) > 9:
        return "0" + d[3:]
    return d


def number_in_text(number: object, text: str) -> bool:
    """Did she type this number herself? Digits are compared after removing
    separators, so "050-123 4567" in her message matches 0501234567."""
    want = national(number)
    if len(want) < 7:
        return False
    for chunk in re.findall(r"\+?[\d][\d\s().-]{5,}\d", text or ""):
        if national(chunk) == want:
            return True
    return False


def her_words(stamped: str) -> str:
    """The message without the server's leading [..] stamps (time, place, mode)."""
    return _STAMP_RE.sub("", stamped or "").strip()


def classify(text: str) -> Optional[str]:
    """'yes' / 'no' for a plain answer, None for anything else."""
    t = _EDGE_RE.sub("", her_words(text).lower())
    t = re.sub(r"\s+", " ", t)
    if t in _YES:
        return "yes"
    if t in _NO:
        return "no"
    return None


def propose(key: str, draft: dict) -> None:
    """Hold one draft per person; a newer one replaces the older."""
    if key:
        _drafts[key] = {**draft, "_at": time.time()}


def pending(key: str) -> Optional[dict]:
    d = _drafts.get(key or "")
    if d and time.time() - d["_at"] > DRAFT_TTL_S:
        _drafts.pop(key, None)
        return None
    return d


def clear(key: str) -> None:
    _drafts.pop(key or "", None)


def answer(key: str, stamped: str, schedule, save_contact=None) -> Optional[str]:
    """Her reply to a waiting draft, handled without a model.

    Returns the line to send her, or None when there is no draft (the turn runs
    normally). Anything that is not a plain yes drops the draft: a stale draft
    must never be confirmed by a later, unrelated "yes".
    """
    draft = pending(key)
    if not draft:
        return None
    verdict = classify(stamped)
    he = bool(re.search(r"[֐-׿]", her_words(stamped))) or draft.get("lang") == "he"
    clear(key)
    if verdict is None:
        logger.info("outgoing draft dropped: reply was not a yes/no")
        return None
    name = draft.get("recipient_name") or draft.get("number")
    when = f"{draft.get('send_date')} {draft.get('send_time')}"
    if verdict == "no":
        return "בוטל, לא נשלח 👍" if he else "Cancelled — nothing sent 👍"
    ok = schedule(draft["owner_phone"], draft["number"], draft["send_time"],
                  draft["send_date"], draft["message"], draft.get("recipient_name") or "")
    if not ok:
        logger.warning("confirmed outgoing message could not be scheduled for %s", when)
        return ("לא הצלחתי לתזמן — השעה כבר עברה? שלחי לי שוב עם זמן אחר."
                if he else "Couldn't schedule it — has that time passed? Send it again with a new time.")
    if save_contact and draft.get("save_contact"):
        try:
            save_contact(draft["owner_phone"], draft.get("recipient_name") or "", draft["number"])
        except Exception as exc:  # noqa: BLE001 — the message is scheduled; the contact is a nicety
            logger.warning("contact not saved after confirmed send: %s", exc)
    return f"✓ יישלח ל{name} ב-{when}" if he else f"✓ Will send to {name} on {when}"
