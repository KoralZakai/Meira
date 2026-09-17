"""The profile store, keyed by the user's WhatsApp phone.

Holds the parameters Lumi needs to compute wake/leave times (home address,
transport, morning routine) plus the routines and constraints a calendar never
shows.

The JSON file is still the authoritative write — it is what every reader here
uses today — but every update is now ALSO shadowed into Postgres
(lumi_profiles, migration 0007) through database_service. That shadow is the
migration: once the table has the rows and the readers move, the file becomes
the offline mirror instead of the only copy. It matters more than it sounds —
user_profiles held zero rows for months, and an empty homeAddress is why routes
silently stopped being computed at all.

Dependencies: config (DATA_DIR). Consumed by lumi_agent (save_profile tool,
plan_departure origin/transport defaults, onboarding prompt) and main.py
(shared-location updates via currentAddress/currentLat/currentLng).
"""
import json
import logging
import os
from typing import Optional

import config
import database_service
import secure_store

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "profiles.json")

_DEFAULTS = {
    "name": "there",
    "language": "en",
    "homeAddress": "",
    "transportType": "car",
    "morningRoutineMinutes": 45,
    "wakeBufferMinutes": 10,
    "hobbies": "",
    # Constraints and habits in her own words — "kids 16:00 every day", "gym
    # Mon/Wed 18:00". The app has collected these since onboarding; the server
    # had nowhere to put them, so WhatsApp planned as if the week were empty
    # around the tasks it could see.
    "routinesNotes": "",
    "mbtiType": "",
    "onboarded": False,
    "routineVerified": False,
    "currentAddress": "",
    "currentLat": None,
    "currentLng": None,
}

# Values that are never a real answer. A model filling save_profile(...) from
# a half-formed thought has written all of these into a field at some point;
# the live store still holds name="save_profile" for one user, which is worse
# than an empty field because missing_fields() then considers the name KNOWN
# and Lumi never asks again. Rejected on write, and treated as missing on read
# so an already-poisoned profile repairs itself the next time she says her name.
_JUNK_VALUES = {
    "save_profile", "infer_task_details", "update_task", "none", "null",
    "n/a", "na", "unknown", "undefined", "string", "true", "false",
}


def _is_junk(key: str, value) -> bool:
    """True when `value` is a model artefact rather than something the user said."""
    if not isinstance(value, str):
        return False
    probe = value.strip().lower()
    # A field whose value is its own name ("name": "name") is the same artefact.
    return probe in _JUNK_VALUES or probe == key.strip().lower()


# Fields we want collected during onboarding, with friendly labels.
ONBOARDING_FIELDS = {
    "name": "your name",
    "homeAddress": "your home address",
    "transportType": "how you get around (car/bus/walk/bike)",
    "morningRoutineMinutes": "how long your morning routine takes",
    "hobbies": "a few hobbies / things you love",
}


def missing_fields(phone: str) -> list:
    """Which onboarding fields are still empty/default for this user."""
    prof = get_profile(phone)
    missing = []
    for key, label in ONBOARDING_FIELDS.items():
        val = prof.get(key)
        if _is_junk(key, val):
            missing.append(label)
        elif key == "name" and val in ("", "there", None):
            missing.append(label)
        elif not val:
            missing.append(label)
    return missing


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: home address, name, phone. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


def get_profile(phone: str) -> dict:
    """Profile for a phone with _DEFAULTS filled in — never returns None."""
    prof = {**_DEFAULTS, **_load().get(phone, {})}
    return prof


def update_profile(phone: str, **fields) -> dict:
    """Merge non-None fields into the stored profile and return the result.
    None values are skipped so callers can pass every kwarg unconditionally.
    Junk values (tool names, "null", the field's own name) are skipped too —
    they used to overwrite good data and then look like a completed field."""
    data = _load()
    prof = {**_DEFAULTS, **data.get(phone, {})}
    for k, v in fields.items():
        if v is None:
            continue
        if _is_junk(k, v):
            logger.warning("profile %s: refusing junk value for %s: %r", phone[-4:], k, v)
            continue
        prof[k] = v
    data[phone] = prof
    _save(data)
    # Shadow into Postgres. Never awaited: the file write above is what this
    # function promises, and a slow database must not make saving a profile slow.
    database_service.shadow_write(
        database_service.update_profile(phone, {k: prof.get(k) for k in
                                                database_service.PROFILE_FIELDS}))
    return prof


def has_home(phone: str) -> bool:
    """True if this user has a saved home address (route planning can start)."""
    return bool(get_profile(phone).get("homeAddress"))
