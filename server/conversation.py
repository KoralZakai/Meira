"""Per-phone short conversation memory (JSON file).

The webhook is stateless, so without this every message is a cold start — which
makes multi-turn flows (the MBTI quiz, confirming an address) loop forever. We
keep the last few turns so the agent has context. Migrates to the DB later.

Dependencies: config (DATA_DIR). Consumed by lumi_agent.handle_whatsapp_message
(get_history feeds the LangGraph agent; append persists each finished turn).
"""
import json
import logging
import os
from typing import List, Dict

import config
import database_service
import secure_store

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "conversations.json")
_MAX_TURNS = 30  # keep last 30 messages (~15 exchanges) — planning chats run long


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: conversation excerpts. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


def get_history(phone: str) -> List[Dict[str, str]]:
    """Recent {role, content} turns for this phone (oldest first)."""
    return _load().get(phone, [])


def reset(phone: str) -> None:
    """Drop this phone's transcript. Used when the model falls into a
    repetition loop: the stuck reply lives in the history and keeps
    re-teaching itself, so the only way out is to clear it."""
    data = _load()
    if data.pop(phone, None) is not None:
        _save(data)


def append(phone: str, user_text: str, assistant_text: str) -> None:
    """Persist one finished turn (user + assistant), trimmed to the last _MAX_TURNS.

    Each turn carries `ts` (Israel-local ISO) — without it the model could not
    tell yesterday's '13:00' from today's and re-confirmed stale reminder times.
    lumi_agent._sanitize_history renders it back as a [HH:MM] prefix.
    """
    from tz import now_il

    # Where she IS is used for this turn and never kept (privacy.strip_location):
    # history is replayed to the model later and shadowed to lumi_conversations.
    import privacy
    user_text = privacy.strip_location(user_text)
    data = _load()
    hist = data.get(phone, [])
    ts = now_il().isoformat(timespec="minutes")
    if user_text:
        hist.append({"role": "user", "content": user_text, "ts": ts})
    if assistant_text:
        hist.append({"role": "assistant", "content": assistant_text, "ts": ts})
    data[phone] = hist[-_MAX_TURNS:]
    _save(data)
    # Shadowed into Postgres (lumi_conversations, migration 0007). The file
    # keeps only the last _MAX_TURNS; the table keeps the whole thread, which is
    # what makes "what did we agree last week" answerable at all.
    for role, text in (("user", user_text), ("assistant", assistant_text)):
        if text:
            database_service.shadow_write(
                database_service.append_turn(phone, role, text))
