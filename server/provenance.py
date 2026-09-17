"""Where a task came from — the Session envelope around every turn.

Modelled on OpenClaw's input provenance: a closed `channel` enum carried on the
record itself, so "which conversation created this?" is answerable later rather
than guessed. The gap it closes is concrete — a task Koral created over
WhatsApp was stored with source='voice', because the app's addTasksForDate
stamped every task it wrote 'voice' regardless of origin, and the server never
recorded a channel at all. With both stores labelling by code path instead of
origin, provenance was unanswerable.

A session is one conversation on one channel. Turns within it share an id, so
the tasks created by a single message can be found together — which is what
makes "undo that" and "what did this message create?" possible, and what a
Hermes-style trajectory needs as its unit of replay.

Deliberately additive: this records provenance, it does not yet gate anything.
Nothing reads it to make a decision, so a wrong value cannot misroute a task.

Dependencies: config (DATA_DIR), tz (Israel-local timestamps).
"""
import json
import logging
import os
import time
import uuid
from typing import Optional

import config
import database_service
import secure_store

logger = logging.getLogger(__name__)
_PATH = os.path.join(config.DATA_DIR, "sessions.json")

# The closed set of ways a task can enter Lumi. Closed on purpose: an open
# string is what let 'voice' come to mean "created by this function".
CHANNELS = ("whatsapp", "app_voice", "app_chat", "app_manual",
            "calendar", "email", "agent", "unknown")

# How long one conversation stays the "same" session. A message the next
# morning is a new conversation, not a continuation of last night's.
SESSION_IDLE_SECONDS = 6 * 3600


def _digits(phone: str) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


def _key(phone: str) -> str:
    """Last 9 digits — the same identity rule as supabase_tasks, travel_prefs
    and known_places, so one person is one session thread however their number
    happens to be written."""
    d = _digits(phone)
    return d[-9:] if len(d) >= 9 else d


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: which conversation created which task. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


def current_session(phone: str, channel: str = "whatsapp",
                    now: Optional[float] = None) -> str:
    """The live session id for this phone+channel, starting one if the last
    turn is older than SESSION_IDLE_SECONDS."""
    key = _key(phone)
    if not key:
        return f"anon-{uuid.uuid4().hex[:12]}"
    now = time.time() if now is None else now
    data = _load()
    slot = (data.setdefault(key, {})).get(channel)
    if slot and (now - float(slot.get("last_seen", 0))) < SESSION_IDLE_SECONDS:
        slot["last_seen"] = now
        slot["turns"] = int(slot.get("turns", 0)) + 1
        data[key][channel] = slot
        _save(data)
        return slot["id"]
    fresh = {"id": f"{channel}-{uuid.uuid4().hex[:12]}", "last_seen": now,
             "turns": 1, "started_at": now}
    data[key][channel] = fresh
    _save(data)
    return fresh["id"]


def stamp(phone: str, channel: str = "whatsapp", text: Optional[str] = None,
          now: Optional[float] = None) -> dict:
    """The provenance envelope to attach to everything one turn creates.

    `turn_id` is unique per message; every task from that message shares it, so
    a single message's output can be found — or undone — as a unit.
    """
    if channel not in CHANNELS:
        channel = "unknown"
    now = time.time() if now is None else now
    envelope = {
        "channel": channel,
        "sessionId": current_session(phone, channel, now),
        "turnId": uuid.uuid4().hex[:12],
        "receivedAt": int(now * 1000),
        # The words that caused it. Trimmed — this is for tracing a task back to
        # its sentence, not for storing conversations (user_memory holds
        # distilled facts and deliberately never keeps raw transcript).
        "inputText": (text or "")[:160] or None,
    }
    # Shadowed so a task can be traced back to the sentence that made it even
    # after the volume is gone. Trimmed input only — provenance traces, it does
    # not archive conversations.
    database_service.shadow_write(
        database_service.record_session(phone, channel, envelope))
    return envelope


# The app's `source` column predates this and is a different, smaller
# vocabulary. Map rather than migrate: nothing reads provenance to decide
# anything yet, and a schema change on the shared tasks table is not something
# to do as a side effect.
_CHANNEL_TO_SOURCE = {
    "whatsapp": "whatsapp",
    "app_voice": "voice",
    "app_chat": "chat",
    "app_manual": "manual",
    "calendar": "calendar",
    "email": "email",
    "agent": "suggested",
    "unknown": "voice",
}


def to_source(channel: str) -> str:
    """The legacy `source` value for a channel."""
    return _CHANNEL_TO_SOURCE.get(channel, "voice")
