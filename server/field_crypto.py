"""field_crypto — personal columns in Supabase are ciphertext (7.10 audit).

The /data files were encrypted (secure_store); their Supabase shadows were not.
Anyone with the dashboard, a backup, a leaked service-role key or a Supabase-side
incident read her addresses, places, conversations, memories and reminders.

Now every personal column the server writes is AES-256-GCM, with a key DERIVED
per person: HKDF-SHA256(LUMI_DATA_KEY, info=scope). One person's key opens one
person's rows; the master never leaves Fly.

  "enc1:" + base64(nonce ‖ ciphertext ‖ tag)       in a text column
  {"enc1": "<the same>"}                            in a jsonb column

AAD binds each value to its table and column, so a value copied into another
column fails to open instead of being believed.

Deterministic mode (nonce = HMAC(key, aad‖value)[:12]) is used ONLY where the
database must compare values — a unique index or a conflict target
(lumi_memories.content, lumi_travel_prefs.route, lumi_known_places.name). It
reveals that two rows are equal, nothing more.

Reads accept plaintext (rows written before this) and decrypt the rest. With no
LUMI_DATA_KEY configured everything passes through, like secure_store.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
from functools import lru_cache
from typing import Any, Optional

import secure_store

logger = logging.getLogger(__name__)

PREFIX = "enc1:"
_NONCE = 12

# table → {column: mode}. Modes: rand, det (string), json (any JSON value),
# place (address+lat+lng sealed together into `address`; lat/lng nulled).
SPEC: dict[str, dict[str, str]] = {
    "lumi_memories": {"content": "det", "meta": "json"},
    "lumi_profiles": {"name": "rand", "homeAddress": "rand", "workAddress": "rand",
                      "hobbies": "rand", "routinesNotes": "rand"},
    "lumi_conversations": {"text": "rand"},
    "lumi_reminders": {"text": "rand", "payload": "json"},
    "lumi_known_places": {"name": "det", "address": "place"},
    "lumi_travel_prefs": {"route": "det"},
    "lumi_sessions": {"payload": "json"},
    "lumi_agents": {"name": "rand", "soul": "rand", "config": "json"},
    "lumi_user_records": {"name": "rand", "phone": "det", "pushToken": "rand"},
    "lumi_bug_reports": {"text": "rand", "fields": "json"},
    "lumi_judge_log": {"verdict": "json"},
    "lumi_history": {"text": "rand", "data": "json"},
    "lumi_groups": {"title": "rand"},
    "lumi_group_members": {"displayName": "rand"},
}


def enabled() -> bool:
    try:
        return secure_store.is_enabled()
    except Exception:  # noqa: BLE001 — a malformed key is reported by secure_store
        return False


@lru_cache(maxsize=4096)
def key_for(scope: str) -> bytes:
    """HKDF-SHA256(master, salt, info=scope) → 32 bytes. Pure stdlib, RFC 5869."""
    master = secure_store._load_key()   # noqa: SLF001 — one key, one loader
    if not master:
        raise RuntimeError("LUMI_DATA_KEY not configured")
    prk = hmac.new(b"meira-field-v1", master, hashlib.sha256).digest()
    return hmac.new(prk, scope.encode() + b"\x01", hashlib.sha256).digest()


def _aes(key: bytes):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(key)


def seal_text(value: str, scope: str, aad: str, deterministic: bool = False) -> str:
    key = key_for(scope)
    data = value.encode()
    if deterministic:
        nonce = hmac.new(key, aad.encode() + b"\x00" + data, hashlib.sha256).digest()[:_NONCE]
    else:
        nonce = os.urandom(_NONCE)
    ct = _aes(key).encrypt(nonce, data, aad.encode())
    return PREFIX + base64.b64encode(nonce + ct).decode()


def open_text(value: Any, scope: str, aad: str) -> Any:
    """Plaintext passes through (old rows); ciphertext must open or it raises."""
    if not isinstance(value, str) or not value.startswith(PREFIX):
        return value
    raw = base64.b64decode(value[len(PREFIX):])
    return _aes(key_for(scope)).decrypt(raw[:_NONCE], raw[_NONCE:], aad.encode()).decode()


def is_sealed(value: Any) -> bool:
    return (isinstance(value, str) and value.startswith(PREFIX)) or (
        isinstance(value, dict) and isinstance(value.get("enc1"), str))


def seal_json(value: Any, scope: str, aad: str) -> dict:
    return {"enc1": seal_text(json.dumps(value, ensure_ascii=False), scope, aad)}


def open_json(value: Any, scope: str, aad: str) -> Any:
    if isinstance(value, dict) and isinstance(value.get("enc1"), str):
        return json.loads(open_text(value["enc1"], scope, aad))
    return value


def _scope(row: dict) -> str:
    return "lumi:" + str(row.get("userKey") or "")


def seal_row(table: str, row: dict) -> dict:
    spec = SPEC.get(table)
    if not spec or not enabled() or not isinstance(row, dict):
        return row
    out = dict(row)
    scope = _scope(row)
    for col, mode in spec.items():
        if mode == "place":
            if is_sealed(out.get(col)) or all(out.get(k) is None for k in (col, "lat", "lng")):
                continue
        elif col not in out or out[col] is None or is_sealed(out[col]):
            continue
        aad = f"{table}:{col}"
        if mode == "json":
            out[col] = seal_json(out[col], scope, aad)
        elif mode == "place":
            out[col] = seal_text(json.dumps({"address": out.get("address"), "lat": out.get("lat"),
                                             "lng": out.get("lng")}, ensure_ascii=False), scope, aad)
            out["lat"] = out["lng"] = None
        elif mode == "det":
            v = str(out[col])
            out[col] = seal_text(v.lower() if table == "lumi_known_places" else v, scope, aad, True)
        else:
            out[col] = seal_text(str(out[col]), scope, aad)
    return out


def open_row(table: str, row: dict) -> dict:
    """Decrypt what this module sealed. A value that will not open is reported
    and replaced by None — never shown as ciphertext, never silently believed."""
    spec = SPEC.get(table)
    if not spec or not isinstance(row, dict):
        return row
    out = dict(row)
    scope = _scope(row)
    for col, mode in spec.items():
        if col not in out or not is_sealed(out[col]):
            continue
        aad = f"{table}:{col}"
        try:
            if mode == "json":
                out[col] = open_json(out[col], scope, aad)
            elif mode == "place":
                place = json.loads(open_text(out[col], scope, aad))
                out.update(address=place.get("address"), lat=place.get("lat"), lng=place.get("lng"))
            else:
                out[col] = open_text(out[col], scope, aad)
        except Exception as exc:  # noqa: BLE001
            logger.warning("field_crypto: %s.%s did not open (%s)", table, col, type(exc).__name__)
            out[col] = None
    return out


def lookup_value(table: str, col: str, value: str, user_key: str) -> str:
    """The stored form of a deterministic column, for an equality filter."""
    if not enabled() or SPEC.get(table, {}).get(col) != "det":
        return value
    return seal_text(value.lower() if table == "lumi_known_places" else value,
                     "lumi:" + str(user_key), f"{table}:{col}", True)


# ── the per-person key the APP uses for its own rows (tasks, user_profiles) ──

def user_key_b64(user_id: str) -> Optional[str]:
    """The data key for one account's app rows — served only to that account."""
    if not enabled() or not user_id:
        return None
    return base64.b64encode(key_for("user:" + str(user_id))).decode()


# ── one-time: seal the rows written before this module existed ──────────────

_PK = {
    "lumi_memories": ("id",), "lumi_profiles": ("userKey",), "lumi_conversations": ("id",),
    "lumi_reminders": ("id",), "lumi_known_places": ("id",), "lumi_travel_prefs": ("userKey", "route"),
    "lumi_sessions": ("id",), "lumi_agents": ("id",), "lumi_user_records": ("userKey",),
    "lumi_bug_reports": ("id",), "lumi_judge_log": ("id",),
}
_MARKER = ".field_crypto_resealed_v1"


async def reseal_existing(page: int = 500) -> dict:
    """Seal, in place, every old plaintext value in the server's tables.

    In place (PATCH by primary key), not delete-and-rewrite: lumi_memories rows
    carry embeddings the recall search depends on. Runs once per volume (a
    marker file in DATA_DIR); safe to re-run — sealed values are skipped."""
    import config
    import httpx
    import supabase_tasks
    marker = os.path.join(config.DATA_DIR, _MARKER)
    if os.path.exists(marker):
        return {"skipped": "already done"}
    if not enabled() or not supabase_tasks._enabled():   # noqa: SLF001
        return {"skipped": "no key or no supabase"}
    out: dict = {}
    headers = {**supabase_tasks._headers(), "Prefer": "return=minimal"}   # noqa: SLF001
    async with httpx.AsyncClient(timeout=30) as client:
        for table, spec in SPEC.items():
            sealed = 0
            offset = 0
            pk = _PK[table]
            cols = ",".join(dict.fromkeys([*pk, "userKey", *spec, *(["lat", "lng"] if "address" in spec else [])]))
            while True:
                r = await client.get(supabase_tasks._rest(table), headers=headers,   # noqa: SLF001
                                     params={"select": cols, "limit": str(page), "offset": str(offset),
                                             "order": ",".join(f"{k}.asc" for k in pk)})
                if r.status_code != 200:
                    out[table] = f"read HTTP {r.status_code}"
                    break
                rows = r.json()
                for row in rows:
                    if all(row.get(c) is None or is_sealed(row.get(c)) for c in spec):
                        continue
                    new = seal_row(table, row)
                    patch = {c: new[c] for c in new if c in spec or c in ("lat", "lng")}
                    params = {k: f"eq.{row[k]}" for k in pk}
                    p = await client.patch(supabase_tasks._rest(table), headers=headers,   # noqa: SLF001
                                           params=params, json=patch)
                    if p.status_code < 300:
                        sealed += 1
                    else:
                        logger.warning("reseal %s: HTTP %s", table, p.status_code)
                if len(rows) < page:
                    out.setdefault(table, sealed)
                    break
                offset += page
    if all(isinstance(v, int) for v in out.values()):
        with open(marker, "w", encoding="utf-8") as f:
            f.write(json.dumps(out))
    logger.warning("field_crypto: resealed existing rows %s", out)
    return out
