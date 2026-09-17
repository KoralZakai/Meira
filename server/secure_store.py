"""secure_store — encrypted-at-rest JSON for the /data volume.

WHAT THIS PROTECTS AGAINST. Everything Lumi knows about a person lives as
plaintext JSON on a Fly volume: home address, phone number, the contents of
every task, distilled behavioural notes, conversation excerpts, uploaded CVs.
Anyone who reaches the filesystem — a snapshot, a mis-scoped `fly ssh`, a
restored backup, a future bug that serves a file path — reads all of it. Volume
encryption at the provider does not help here: the volume is mounted, so a
process that can read the path can read the data.

DESIGN

  AES-256-GCM, one random 96-bit nonce per write, key from the environment.
  GCM is authenticated: it detects tampering as well as hiding content, so a
  modified file fails loudly instead of feeding forged memory into a prompt.

  The filename is bound in as associated data (AAD). A ciphertext therefore
  cannot be moved between stores — dropping `conversations.json` in place of
  `user_memory.json` fails to authenticate rather than silently loading.

  Envelope is self-describing JSON, so plaintext and ciphertext are trivially
  distinguishable and migration needs no flag day:

      {"__lumi_enc__": 1, "alg": "AES-256-GCM", "n": "<b64>", "ct": "<b64>"}

THREE BEHAVIOURS, CHOSEN DELIBERATELY

  1. No key configured -> read and write plaintext, exactly as before, and warn
     once. Encryption that bricks a running server on deploy is not a security
     improvement; this keeps the door open for a staged rollout.

  2. Key configured, file is plaintext -> decrypt-nothing, load it, and the next
     write encrypts it. Migration is a side effect of normal use.

  3. Key configured, file is encrypted, decryption FAILS -> raise. Never return
     {}. This is the important one: `user_memory._load` used to swallow a
     JSONDecodeError and return an empty dict, so a corrupt file silently became
     an empty store and the next save overwrote the real data with nothing. A
     wrong or rotated key must not be able to trigger that. Loud beats empty.

WRITES ARE ATOMIC. Every store here did `open(path, "w")` then `json.dump`,
which truncates first: a crash or an OOM kill mid-write left a truncated file,
and that file then parsed as corrupt and (see above) became {}. Writing to a
temp file in the same directory and `os.replace`-ing it is atomic on POSIX, so
a reader sees either the old file or the new one, never a half-written one.

KEY MANAGEMENT
    fly secrets set LUMI_DATA_KEY=$(openssl rand -base64 32)
Losing the key loses the data — it is not recoverable, by construction. Rotation
is: decrypt-all with the old key, set the new one, re-write (see rotate()).

Dependencies: cryptography (AESGCM), config (DATA_DIR / LUMI_DATA_KEY).
Consumed by user_memory, conversation, user_profile, user_store, known_places,
travel_prefs, provenance, bug_reports, agents_store, reminders.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import tempfile
from typing import Any, Optional

import config

logger = logging.getLogger(__name__)

_MAGIC = "__lumi_enc__"
_VERSION = 1
_NONCE_BYTES = 12          # 96-bit, the GCM standard
_KEY_BYTES = 32            # AES-256

_warned_no_key = False
_cached_key: Optional[bytes] = None
_key_resolved = False


class DecryptionError(RuntimeError):
    """The file is encrypted and this key cannot open it. Never swallowed."""


def _load_key() -> Optional[bytes]:
    """The 32-byte data key, or None when encryption is not configured.

    Accepts base64 (the documented form) or hex, so an operator who generated
    the key either way is not silently running unencrypted.
    """
    global _cached_key, _key_resolved, _warned_no_key
    if _key_resolved:
        return _cached_key
    _key_resolved = True

    raw = (os.getenv("LUMI_DATA_KEY") or getattr(config, "LUMI_DATA_KEY", "") or "").strip()
    if not raw:
        if not _warned_no_key:
            _warned_no_key = True
            logger.warning(
                "LUMI_DATA_KEY is not set — personal data on %s is being stored "
                "UNENCRYPTED. Set it with: fly secrets set LUMI_DATA_KEY=$(openssl rand -base64 32)",
                config.DATA_DIR,
            )
        _cached_key = None
        return None

    for decoder in (base64.b64decode, lambda v: binascii.unhexlify(v)):
        try:
            key = decoder(raw)
            if len(key) == _KEY_BYTES:
                _cached_key = key
                return key
        except (binascii.Error, ValueError):
            continue

    # A key that is present but malformed is an operator error, not a reason to
    # quietly write plaintext — that would look configured while protecting nothing.
    raise ValueError(
        f"LUMI_DATA_KEY must decode to exactly {_KEY_BYTES} bytes "
        "(base64 or hex). Generate one: openssl rand -base64 32"
    )


def is_enabled() -> bool:
    """True when a usable key is configured."""
    return _load_key() is not None


def _aesgcm(key: bytes):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # local: ~5 MB
    return AESGCM(key)


def _is_envelope(obj: Any) -> bool:
    return isinstance(obj, dict) and obj.get(_MAGIC) == _VERSION


def read_json(path: str, fallback: Any) -> Any:
    """Load JSON from `path`, decrypting when needed.

    Returns `fallback` only for genuine absence or plaintext corruption — the
    same contract the callers already had. A file that IS encrypted but will not
    decrypt raises DecryptionError instead, so a key problem can never be
    mistaken for an empty store.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        return fallback
    except OSError as exc:
        logger.error("read failed for %s: %s", path, exc)
        return fallback

    if not raw.strip():
        return fallback

    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("%s is not valid JSON — treating as empty", path)
        return fallback

    if not _is_envelope(obj):
        return obj      # plaintext: legacy file, or encryption not enabled

    key = _load_key()
    if key is None:
        raise DecryptionError(
            f"{os.path.basename(path)} is encrypted but LUMI_DATA_KEY is not set. "
            "Refusing to continue — starting empty here would overwrite real data "
            "on the next write."
        )

    try:
        nonce = base64.b64decode(obj["n"])
        ct = base64.b64decode(obj["ct"])
        plain = _aesgcm(key).decrypt(nonce, ct, os.path.basename(path).encode())
    except Exception as exc:  # noqa: BLE001 — InvalidTag, KeyError, binascii…
        raise DecryptionError(
            f"could not decrypt {os.path.basename(path)}: {exc}. "
            "Wrong LUMI_DATA_KEY, or the file was tampered with."
        ) from exc

    return json.loads(plain.decode("utf-8"))


def write_json(path: str, data: Any) -> None:
    """Serialise `data` to `path`, encrypted when a key is configured.

    Atomic: written to a sibling temp file and renamed, so a crash mid-write
    cannot leave a truncated store behind.
    """
    payload = json.dumps(data, ensure_ascii=False)

    key = _load_key()
    if key is not None:
        nonce = os.urandom(_NONCE_BYTES)
        ct = _aesgcm(key).encrypt(nonce, payload.encode("utf-8"),
                                  os.path.basename(path).encode())
        payload = json.dumps({
            _MAGIC: _VERSION,
            "alg": "AES-256-GCM",
            "n": base64.b64encode(nonce).decode(),
            "ct": base64.b64encode(ct).decode(),
        })

    directory = os.path.dirname(path) or "."
    try:
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())          # survive an OOM kill
            os.replace(tmp, path)             # atomic on POSIX
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as exc:
        logger.error("write failed for %s: %s", path, exc)


def is_plaintext(path: str) -> bool:
    """True when this store exists and is NOT encrypted yet.

    Cheap: reads the head of the file and looks for the envelope marker, rather
    than parsing megabytes of JSON to answer a yes/no question.
    """
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            head = f.read(64)
    except OSError:
        return False
    return _MAGIC not in head


def migrate_plaintext(paths: "list[str]") -> int:
    """Encrypt every store still sitting in plaintext. Returns how many moved.

    WHY THIS EXISTS. The migration strategy in this module's header is "key
    configured, file is plaintext -> load it, and the next write encrypts it.
    Migration is a side effect of normal use." That is a good strategy for a
    store that is written often, and it quietly does nothing for one that is
    not: on 2026-09-17, with LUMI_DATA_KEY deployed, /data/known_places.json
    was still plaintext and world-readable (0644) from 31 August, containing a
    phone number and home/work/gym addresses. profiles.json, cv_master.json and
    hr_pending.json were in the same state. Nothing had written to them, so
    nothing had encrypted them, and nothing ever would.

    `rotate()` was written for exactly this and was never called from anywhere.

    Also fixes the permissions as a side effect: write_json goes through
    tempfile.mkstemp, which creates at 0600, and os.replace carries that mode
    over — the 0644 files are all legacy `open(path, "w")` writes.

    Best-effort per file: one unreadable store must not stop the others, and
    must never stop the server from booting.
    """
    if not is_enabled():
        return 0
    moved = 0
    for path in paths:
        if not is_plaintext(path):
            continue
        try:
            if rotate(path):
                moved += 1
                # The NAME only. The contents are the thing being protected.
                logger.warning("secure_store: encrypted legacy plaintext store %s",
                               os.path.basename(path))
        except Exception as exc:  # noqa: BLE001 — never block a boot
            logger.error("secure_store: could not migrate %s: %s",
                         os.path.basename(path), exc)
    return moved


def rotate(path: str) -> bool:
    """Re-write `path` under the current key. Returns False if nothing to do.

    Also the migration primitive: with a key newly set, this converts a legacy
    plaintext file in place without waiting for the next natural write.
    """
    if not os.path.exists(path):
        return False
    data = read_json(path, None)
    if data is None:
        return False
    write_json(path, data)
    return True
