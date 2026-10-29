"""The small records the server owns: who this WhatsApp number is, their push
token, their personality signals, their handoff tokens.

This used to be `database_service` — an asyncpg pool against a Postgres that
WAS NEVER PROVISIONED. `DATABASE_URL` has never been set as a Fly secret, so
every call raised `[Errno 111] Connection refused`, every caller swallowed it
in a try/except, and the server ran fine on its JSON store. The damage was not
noise in the log: `set_push_token_by_phone` failed too, so the app's Expo push
token had nowhere to land and the reminder loop could never notify the phone.

So the pool is gone and these records live where the rest of Lumi's state
already lives — the /data volume — with ONE exception that matters:

    identity comes from Supabase, not from here.

`get_user_by_whatsapp` asks Supabase which auth account has linked this number
(app_settings."whatsAppPhone") and uses THAT user id. Before, the id was a
phone in one code path and a random uuid in another, so the app and WhatsApp
were two people. Now they are one, and the local record only carries what
Supabase has no column for: name, language, mbti, push token.

Tasks are deliberately absent. They belong to Supabase (supabase_tasks) with
user_memory as the offline mirror; a third copy here is how they diverge.

Dependencies: config (DATA_DIR), supabase_tasks (identity lookup).
Consumed by main.py, reminders (push token), personality_learning_service,
personality_handoff.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import config
import database_service
import secure_store

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "user_store.json")

# One WhatsApp number maps to one auth account; the answer does not change
# mid-conversation, and the webhook is a hot path. Cheap TTL cache.
_ID_CACHE: dict = {}
_ID_TTL = 300.0

# Caps: this store is a few users, not a log. Trimmed rather than grown.
_MAX_MESSAGES = 500
_MAX_SIGNALS = 200

# Stable ids for a number that has NOT linked a Supabase account yet, so a
# restart does not mint a new "person" for the same phone.
_ID_NAMESPACE = uuid.UUID("6f9b1c2e-0e4a-4f8b-9d3a-2c7e5b1a0d44")


def _normalize_phone(phone: str) -> str:
    """Canonicalize phone numbers for WhatsApp lookups across backend and app."""
    if not phone:
        return ""
    return "".join(ch for ch in str(phone).strip() if ch.isdigit())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    """The whole store; a fresh skeleton if missing.

    Sensitive: identity, linked phone numbers, Expo push tokens, personality
    signals. Decrypted by secure_store when LUMI_DATA_KEY is set; a
    DecryptionError propagates rather than handing back an empty skeleton that
    the next save would write over the real data.
    """
    data = secure_store.read_json(_PATH, {})
    if not isinstance(data, dict):
        data = {}
    data.setdefault("users", {})            # normalized phone -> user record
    data.setdefault("messages", {})         # wa_message_id -> {...}
    data.setdefault("handoff_tokens", {})   # token -> {user_id, expires_at, used}
    data.setdefault("signals", [])          # [{user_id, signal_type, ...}]
    return data


def _save(data: dict) -> None:
    """Encrypted (when configured) and atomic — secure_store keeps the temp-file
    + rename this function already relied on to protect every push token."""
    secure_store.write_json(_PATH, data)


async def _supabase_user_id(phone: str) -> Optional[str]:
    """The auth account that linked this WhatsApp number, if any. Cached."""
    key = _normalize_phone(phone)
    if not key:
        return None
    hit = _ID_CACHE.get(key)
    if hit and hit[1] > time.time():
        return hit[0]
    try:
        import supabase_tasks
        uid = await supabase_tasks.user_id_for_phone(key)
    except Exception as exc:  # noqa: BLE001 — unlinked is normal, not an error
        logger.debug("supabase identity lookup failed for %s: %s", key, exc)
        uid = None
    _ID_CACHE[key] = (uid, time.time() + _ID_TTL)
    return uid


def _identity_changed() -> None:
    """A number's id moved (created, or linked to an account): the brain-key map
    in identity_keys must not answer from its cache for another minute."""
    try:
        import identity_keys
        identity_keys.invalidate()
    except Exception as exc:  # noqa: BLE001 — the map expires on its own in 60 s
        logger.warning("identity map not invalidated: %s", exc)


def _local_id(phone: str) -> str:
    """A stable id for a number with no linked account yet."""
    return str(uuid.uuid5(_ID_NAMESPACE, _normalize_phone(phone)))


async def init_pool() -> None:
    """Kept so main.lifespan reads the same; there is nothing to open."""
    logger.info("user store at %s", _PATH)


async def close_pool() -> None:
    """Nothing to close — writes are flushed on every call."""
    return None


class DatabaseService:
    """The same facade the callers already use. No database behind it.

    Methods no longer raise on a missing backend: the store is a local file, so
    "unavailable" is not a state these can be in. The callers' try/except blocks
    stay — they are still correct, just no longer load-bearing.
    """

    @staticmethod
    async def get_user_by_whatsapp(phone: str) -> Optional[dict]:
        """The user record for this WhatsApp number, or None if never seen."""
        key = _normalize_phone(phone)
        if not key:
            return None
        user = _load()["users"].get(key)
        if not user:
            return None
        # A number that linked an account AFTER its record was created adopts the
        # real auth id, so the two channels stop being two people.
        uid = await _supabase_user_id(key)
        if uid and user.get("id") != uid:
            user = await DatabaseService._set_id(key, uid)
        return user

    @staticmethod
    async def _set_id(key: str, uid: str) -> dict:
        data = _load()
        user = data["users"].get(key) or {}
        user["id"] = uid
        user["updated_at"] = _now()
        data["users"][key] = user
        _save(data)
        _identity_changed()
        logger.info("whatsapp %s now resolves to auth user %s", key[-4:], uid[:8])
        return user

    @staticmethod
    async def get_user_by_id(user_id: str) -> Optional[dict]:
        """User record by id — the personality handoff resolve path."""
        for user in _load()["users"].values():
            if str(user.get("id")) == str(user_id):
                return user
        return None

    @staticmethod
    async def set_mbti(user_id: str, mbti_type: str, confidence: float = 0.4) -> None:
        """Store a quiz result (4-letter type) — called by /personality/complete."""
        data = _load()
        for key, user in data["users"].items():
            if str(user.get("id")) == str(user_id):
                user["mbti_type"] = mbti_type
                user["mbti_confidence"] = confidence
                user["updated_at"] = _now()
                data["users"][key] = user
                _save(data)
                return

    @staticmethod
    async def set_push_token_by_phone(phone: str, push_token: str) -> bool:
        """Store the app's Expo push token against this WhatsApp number.

        This is the call that has been failing since the server shipped, which
        is why reminders never reached the phone. Returns False only when the
        number has never messaged Lumi.
        """
        key = _normalize_phone(phone)
        data = _load()
        user = data["users"].get(key)
        if not user:
            return False
        user["push_token"] = push_token
        # WHEN the app last announced itself. The reminder loop stands down on
        # departure reminders for phones that run the app (it schedules its own,
        # better alert) — but a token from an app that was uninstalled months ago
        # would silence the WhatsApp reminder with nothing to replace it. The app
        # re-registers on every launch, so a fresh stamp means it is still there.
        user["push_token_at"] = _now()
        data["users"][key] = user
        _save(data)
        # The write whose failure is the whole reason this module stopped being
        # a Postgres client: with no row, the reminder loop had no token and the
        # phone was never notified. It now lands in BOTH places.
        database_service.shadow_write(database_service.save_user_record(key, {
            "phone": key, "pushToken": push_token,
            "name": user.get("name"), "language": user.get("language"),
            "mbtiType": user.get("mbti_type"),
        }))
        return True

    @staticmethod
    async def get_push_token_by_phone(phone: str) -> Optional[str]:
        """Expo push token for this phone (reminders._push_if_registered), or None."""
        user = _load()["users"].get(_normalize_phone(phone))
        return (user or {}).get("push_token") or None

    @staticmethod
    async def push_token_age_days(phone: str) -> Optional[float]:
        """Days since the app last registered its push token, or None if never.

        Read by reminders._app_owns_departures to tell a live app from a stale
        token. Returns None (== "unknown") rather than raising, and None when the
        stamp predates this field — callers treat unknown as "deliver anyway"."""
        user = _load()["users"].get(_normalize_phone(phone)) or {}
        stamp = user.get("push_token_at")
        if not stamp or not user.get("push_token"):
            return None
        try:
            when = datetime.fromisoformat(str(stamp))
        except (ValueError, TypeError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - when).total_seconds() / 86400

    @staticmethod
    async def create_user_from_whatsapp(phone: str, name: str = "User",
                                        language: str = "en") -> dict:
        """Upsert a record for this number; always returns it."""
        key = _normalize_phone(phone)
        data = _load()
        user = data["users"].get(key)
        uid = await _supabase_user_id(key) or (user or {}).get("id") or _local_id(key)
        if user:
            user["id"] = uid
            user["updated_at"] = _now()
        else:
            user = {
                "id": uid,
                "name": name,
                "whatsapp_phone": key,
                "whatsapp_connected": True,
                "language": language,
                "mbti_type": None,
                "mbti_confidence": 0.4,
                "push_token": None,
                "created_at": _now(),
                "updated_at": _now(),
            }
        data["users"][key] = user
        _save(data)
        _identity_changed()
        return user

    @staticmethod
    async def save_incoming_message(user_id: str, wa_message_id: str, phone: str,
                                    content: str, message_type: str = "text") -> None:
        """Record an inbound message; idempotent on wa_message_id (Meta retries)."""
        data = _load()
        msgs = data["messages"]
        if wa_message_id in msgs:
            return
        msgs[wa_message_id] = {
            "user_id": str(user_id),
            "from_phone": _normalize_phone(phone),
            "content": content,
            "message_type": message_type,
            "is_from_user": True,
            "at": _now(),
        }
        if len(msgs) > _MAX_MESSAGES:
            for stale in sorted(msgs, key=lambda k: msgs[k].get("at", ""))[:len(msgs) - _MAX_MESSAGES]:
                msgs.pop(stale, None)
        _save(data)


# ── personality signals (was the personality_signals table) ─────────────────

def add_signal(user_id: str, signal_type: str, dichotomy: str, confidence: float) -> None:
    """Append one behavioral signal for this user."""
    data = _load()
    data["signals"].append({
        "user_id": str(user_id),
        "signal_type": signal_type,
        "dichotomy": dichotomy,
        "confidence": confidence,
        "at": _now(),
    })
    if len(data["signals"]) > _MAX_SIGNALS:
        data["signals"] = data["signals"][-_MAX_SIGNALS:]
    _save(data)


def signals_for(user_id: str) -> list:
    """[(signal_type, confidence)] for this user, oldest first."""
    return [(s["signal_type"], float(s.get("confidence", 0.4)))
            for s in _load()["signals"] if str(s.get("user_id")) == str(user_id)]


# ── handoff tokens (was the handoff_token table) ────────────────────────────

def put_handoff(token: str, user_id: str, expires_at: str) -> None:
    """Store a one-time personality-quiz handoff token."""
    data = _load()
    # Used and expired tokens are worthless — prune before adding, so the store
    # cannot grow on a feature nobody uses twice a year.
    now = _now()
    data["handoff_tokens"] = {
        t: v for t, v in data["handoff_tokens"].items()
        if not v.get("used") and str(v.get("expires_at", "")) > now
    }
    data["handoff_tokens"][token] = {
        "user_id": str(user_id), "expires_at": expires_at, "used": False,
    }
    _save(data)


def take_handoff(token: str) -> Optional[dict]:
    """Read a handoff token and mark it used, atomically. None if unknown."""
    data = _load()
    row = data["handoff_tokens"].get(token)
    if not row:
        return None
    was = dict(row)
    row["used"] = True
    _save(data)
    return was
