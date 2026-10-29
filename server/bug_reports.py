"""Bug reports filed from WhatsApp — "באג בלומי: …" / "bug in lumi: …".

A bug is a small session, not a one-off message: it has an id the user can
refer back to, a status that moves as the fix progresses, the screenshot they
attached, and the conversation turn that produced it. Without that, a reported
bug is just a line in a chat log that nobody can act on twice.

Deliberately dumb storage — flat JSON in DATA_DIR, same shape as reminders.py
and session.py, which already live on the Fly /data volume and survive deploys.

Status flow:
    new         filed, nothing has looked at it yet
    triaged     an issue exists for it (GitHub), fix not started
    fixing      a fix is being written
    fixed       fix merged, not yet in a build the user can install
    released    shipped in a build; `build` carries the install link
    wontfix     closed without a change, `note` says why

Dependencies: config (DATA_DIR), tz. Consumed by main.py (webhook intake +
status replies).
"""
import json
import logging
import os
import re
import uuid
from typing import Optional

import config
import database_service
import secure_store
from tz import now_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "bug_reports.json")

STATUSES = ("new", "triaged", "fixing", "fixed", "released", "wontfix")

# "באג בלומי: …", "bug in lumi: …", "לומי באג …" — the colon is optional
# because nobody types it consistently on a phone.
_TRIGGER = re.compile(
    r"^\s*(?:באג\s+ב?לומי|לומי\s+באג|bug\s+in\s+lumi|lumi\s+bug)\s*[:：\-–]?\s*(.*)",
    re.IGNORECASE | re.DOTALL,
)


def _digits(phone: str) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


def _same_number(a: str, b: str) -> bool:
    """Whether two phone strings are the same person.

    The same number reaches us as 972542902729 from WhatsApp and 0542902729
    when typed locally, so exact digit equality silently hides a user's own
    bugs from them. Compare the last 9 digits, matching what
    supabase_tasks.user_id_for_phone already does for account lookup.
    """
    da, db = _digits(a), _digits(b)
    if not da or not db:
        return False
    return da == db or da[-9:] == db[-9:]


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: conversation context attached to reports. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


def detect(text: str) -> Optional[str]:
    """The bug description if `text` opens a bug report, else None.

    Returns "" (falsy-but-not-None is deliberate) when the trigger matched with
    no description after it, so the caller can ask for one instead of filing an
    empty report.
    """
    if not text:
        return None
    m = _TRIGGER.match(text)
    if not m:
        return None
    return m.group(1).strip()


def file_bug(
    phone: str,
    description: str,
    *,
    image_id: Optional[str] = None,
    context: Optional[list] = None,
) -> dict:
    """Record a new bug. Returns the stored record, including its short id."""
    data = _load()
    # Short, sayable id — the user has to be able to type "LUMI-3f2a" back.
    bug_id = f"LUMI-{uuid.uuid4().hex[:4]}"
    record = {
        "id": bug_id,
        "phone": _digits(phone),
        "description": description,
        "imageMediaId": image_id,
        # The last few turns before the report: "it appeared twice" is
        # meaningless without knowing what "it" was.
        "context": (context or [])[-6:],
        "status": "new",
        "createdAt": now_il().isoformat(),
        "updatedAt": now_il().isoformat(),
        "issueUrl": None,
        "build": None,
        "note": None,
    }
    data[bug_id] = record
    _save(data)
    database_service.shadow_write(database_service.save_bug_report(
        {**record, "text": description}))
    logger.info("bug filed %s from %s", bug_id, _digits(phone)[-4:])
    return record


def set_status(bug_id: str, status: str, **fields) -> Optional[dict]:
    """Move a bug along. Unknown ids and statuses are refused, not invented."""
    if status not in STATUSES:
        logger.warning("refusing unknown bug status %r", status)
        return None
    data = _load()
    record = data.get(bug_id)
    if not record:
        return None
    record["status"] = status
    record["updatedAt"] = now_il().isoformat()
    for key, value in fields.items():
        if value is not None:
            record[key] = value
    data[bug_id] = record
    _save(data)
    database_service.shadow_write(database_service.save_bug_report(
        {**record, "text": record.get("description") or ""}))
    return record


def request_build(bug_id: str) -> Optional[dict]:
    """Mark that the user approved building a fix.

    The Mac agent cannot receive WhatsApp messages — only this server can — so
    approval is recorded here and the agent picks it up on its next poll.
    """
    data = _load()
    rec = data.get(bug_id)
    if not rec:
        return None
    rec["buildRequested"] = True
    rec["updatedAt"] = now_il().isoformat()
    data[bug_id] = rec
    _save(data)
    return rec


def get(bug_id: str) -> Optional[dict]:
    return _load().get(bug_id)


def list_for_phone(phone: str, *, open_only: bool = False) -> list:
    """This phone's bugs, newest first."""
    rows = [r for r in _load().values() if _same_number(r.get("phone", ""), phone)]
    if open_only:
        rows = [r for r in rows if r.get("status") not in ("released", "wontfix")]
    return sorted(rows, key=lambda r: r.get("createdAt", ""), reverse=True)


def list_all(*, status: Optional[str] = None) -> list:
    rows = list(_load().values())
    if status:
        rows = [r for r in rows if r.get("status") == status]
    return sorted(rows, key=lambda r: r.get("createdAt", ""), reverse=True)
