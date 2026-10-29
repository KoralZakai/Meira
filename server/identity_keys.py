"""identity_keys — the ONE key the brain keeps a person under.

6.10: one person could sit under three keys on this server, and its readers
did not agree which one was hers.

  the account id (uid)   what the agent reads and writes. WhatsApp and the app
                         chat both resolve the user record's `id`, which is the
                         Supabase auth id once the number is linked.
  her phone number       what every /app/* route used (app_auth's caller
                         "key"), and what the WhatsApp webhook hands the stores
                         it touches itself (language, home, current place).
  uuid5(phone)           the id a number had BEFORE it linked an account.
                         user_store._set_id moves the person to the uid and
                         leaves the data behind.

So the routine she told Meira in the chat was saved under the uid, and the
phone asked for it under her number. The answer was empty, which looks exactly
like "she told Meira nothing" (CLAUDE.md silent-state rule 1). Her 👍/👎 never
reached the agent's memory for the same reason, and "delete my account" deleted
one record of three.

One resolver instead of three call-site patches:

  brain_key(caller)  the key for a verified app/MCP caller: the auth id.
  canonical(key)     any key a store is handed → the person's brain key
                     (a phone, or an old uuid5 → the id its user record holds).
  aliases_of(key)    every other key the same person's data may sit under,
                     for read-time unions and for deletion.

Read-time union, not a migration. A store asked for the brain key also reads
what its aliases hold, and the next write lands it under the brain key.
Nothing is moved or deleted behind her back, so a wrong mapping cannot lose
data. The worst case is a field read from the older record.

The map comes from user_store's records plus every verified caller seen by this
process (app_auth.identify notes phone → uid). It is cached briefly: the
webhook is a hot path and the map changes only when a number links an account.

Consumed by app_auth, user_profile, feedback_store, account_deletion,
routes_app, main and mcp_server. Tested by tests/test_identity_keys.py.
"""
from __future__ import annotations

import logging
import time
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

_TTL = 60.0
_cache: dict = {"at": 0.0, "to_brain": {}, "aliases": {}}
# phone → uid from verified callers. A verified token outranks a stored record:
# the record can still hold a pre-link uuid5 when a Supabase lookup failed.
_seen: dict[str, str] = {}


def _digits(value: object) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _looks_like_phone(key: str) -> bool:
    bare = key.replace("+", "").replace("-", "").replace(" ", "")
    return bare.isdigit() and 8 <= len(bare) <= 15


def invalidate() -> None:
    """Forget the cached map — user_store calls this when a number links."""
    _cache["at"] = 0.0


def note_caller(user_id: Optional[str], phone: Optional[str]) -> None:
    """Remember that this verified account owns this phone (app_auth.identify)."""
    uid, digits = str(user_id or ""), _digits(phone)
    if not uid or not digits or _seen.get(digits) == uid:
        return
    _seen[digits] = uid
    try:
        import user_store
        _seen[user_store._local_id(digits)] = uid   # noqa: SLF001 — same identity scheme
    except Exception as exc:  # noqa: BLE001 — the phone mapping still holds
        logger.warning("identity: no local id for a caller's phone: %s", exc)


def _maps() -> tuple[dict, dict]:
    now = time.time()
    if now - _cache["at"] < _TTL:
        return _cache["to_brain"], _cache["aliases"]
    to_brain: dict[str, str] = {}
    try:
        import user_store
        users = (user_store._load() or {}).get("users", {})   # noqa: SLF001
        for phone, rec in users.items():
            uid = str((rec or {}).get("id") or "")
            if not phone or not uid:
                continue
            for alias in (phone, user_store._local_id(phone)):   # noqa: SLF001
                if alias != uid:
                    to_brain[alias] = uid
    except Exception as exc:  # noqa: BLE001 — keep answering from what we had
        logger.warning("identity map unavailable, using the last one: %s", exc)
        return _cache["to_brain"], _cache["aliases"]
    aliases: dict[str, list[str]] = {}
    for alias, uid in to_brain.items():
        aliases.setdefault(uid, []).append(alias)
    _cache.update(at=now, to_brain=to_brain, aliases=aliases)
    return to_brain, aliases


def looks_like_phone(key: object) -> bool:
    """Public form of the phone test, for callers that must treat a phone key
    differently (task_store: a phone resolves only through phone_links)."""
    return _looks_like_phone(str(key or ""))


def canonical(key: object) -> str:
    """The brain key for whatever key a store was handed. Unknown keys pass through."""
    k = str(key or "")
    if not k:
        return k
    if k in _seen:
        return _seen[k]
    digits = _digits(k) if _looks_like_phone(k) else ""
    if digits and digits in _seen:
        return _seen[digits]
    to_brain, _ = _maps()
    return to_brain.get(k) or (to_brain.get(digits) if digits else None) or k


def aliases_of(key: object) -> list[str]:
    """Every other key this person's data may be stored under (never the brain key)."""
    brain = canonical(key)
    _, aliases = _maps()
    out = list(aliases.get(brain, []))
    out += [k for k, uid in _seen.items() if uid == brain]
    if str(key or "") and str(key) != brain:
        out.append(str(key))
    return [k for k in dict.fromkeys(out) if k and k != brain]


def keys_of(key: object) -> list[str]:
    """The brain key first, then its aliases — the order a read-time union wants."""
    brain = canonical(key)
    return [brain, *aliases_of(brain)] if brain else []


def brain_key(caller: dict) -> str:
    """The key a verified app/MCP caller's brain lives under: the auth id."""
    return str(caller.get("userId") or canonical(caller.get("key")) or "")


def all_keys(caller: dict, extra: Iterable[str] = ()) -> list[str]:
    """Every key this caller's data may be under — what deletion must purge."""
    brain = brain_key(caller)
    keys = [brain, *aliases_of(brain), str(caller.get("key") or ""), *extra]
    phone = _digits(caller.get("phone"))
    if phone:
        keys.append(phone)
        try:
            import user_store
            keys.append(user_store._local_id(phone))   # noqa: SLF001
        except Exception as exc:  # noqa: BLE001
            logger.warning("identity: no local id for deletion: %s", exc)
    return [k for k in dict.fromkeys(keys) if k]


# ── What is still split (logged once per person per process) ─────────────────
# The profile and the feedback are read as unions. Other stores (memory,
# conversation, places…) still read only the key they are handed, so this says
# whether any of her data sits under an alias there — a number to read in the
# Fly log before deciding whether those stores need a merge too.
_reported: set = set()
_SPLIT_STORES = ("user_memory", "conversation", "known_places", "travel_prefs",
                 "session", "provenance", "task_prep", "meeting_brief")


def report_split(brain: str) -> dict:
    """{store: [masked alias keys holding data]} for this person; logged once."""
    if not brain or brain in _reported:
        return {}
    _reported.add(brain)
    aliases = aliases_of(brain)
    found: dict = {}
    if not aliases:
        return found
    import importlib
    for name in _SPLIT_STORES:
        try:
            data = importlib.import_module(name)._load()   # noqa: SLF001 — read-only census
        except Exception as exc:  # noqa: BLE001 — a census, never a failure
            found[name] = [f"unreadable: {type(exc).__name__}"]
            continue
        hit = [a for a in aliases if isinstance(data, dict) and data.get(a)]
        if hit:
            found[name] = [f"…{a[-4:]}" for a in hit]
    if found:
        logger.warning("identity split for …%s: %s", brain[-4:], found)
    else:
        logger.info("identity: no split data for …%s", brain[-4:])
    return found
