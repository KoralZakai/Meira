"""chat_feedback — her 👍 / 👎 on Meira's replies in the app chat.

27.10, Koral: "the question about parking was great! — add an emoji response
so I can sign where an answer was good or bad". A 👎 is a bug report in one
tap, and the raw material for a golden case (server/evals/GOLDEN.md).

Stored like bug_reports: encrypted JSON on /data (secure_store, key in the
LUMI_DATA_KEY Fly secret), never in a plaintext file and never in the
conversation history that is replayed to the model. Keyed by person; one
entry per message —
reacting again replaces it, "none" removes it. Capped at _KEEP entries and
_KEEP_DAYS days. Bodies are never logged.

Consumed by main.py (POST /agent/feedback, GET /admin/chat-feedback).
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import config
import privacy
import secure_store
from tz import now_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "chat_feedback.json")
_KEEP = 500
_KEEP_DAYS = 90
_MAX_CHARS = 1200
REACTIONS = ("up", "down", "none")


def _load() -> dict:
    """{userKey: [rows]} — keyed by person, like every per-user store, so
    account_deletion removes hers by key."""
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def record(user_key: str, reaction: str, reply: str, question: str = "",
           message_id: str = "") -> bool:
    """Keep one reaction. -> False when it could not be stored (the app says so)."""
    if reaction not in REACTIONS or not user_key:
        return False
    try:
        data = _load()
        now = now_il()
        horizon = now.timestamp() - _KEEP_DAYS * 86400
        mid = str(message_id or "")[:64]
        rows = [r for r in data.get(user_key) or [] if isinstance(r, dict)
                and float(r.get("at", 0)) >= horizon and not (mid and r.get("messageId") == mid)]
        if reaction != "none":
            rows.append({
                "reaction": reaction, "messageId": mid,
                "reply": privacy.strip_location(reply or "")[:_MAX_CHARS],
                "question": privacy.strip_location(question or "")[:_MAX_CHARS],
                "at": now.timestamp(), "when": now.isoformat(timespec="minutes"),
            })
        if rows:
            data[user_key] = rows[-_KEEP:]
        else:
            data.pop(user_key, None)
        _save(data)
        logger.warning("chat feedback: %s", reaction)
        return True
    except Exception as exc:  # noqa: BLE001 — the caller answers 503, never a fake ok
        logger.warning("chat feedback not stored: %s", type(exc).__name__)
        return False


def list_all(reaction: Optional[str] = None) -> list:
    rows = [{**r, "userKey": key} for key, items in _load().items() if isinstance(items, list)
            for r in items if isinstance(r, dict) and (not reaction or r.get("reaction") == reaction)]
    return sorted(rows, key=lambda r: -float(r.get("at", 0)))
