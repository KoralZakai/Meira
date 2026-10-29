"""privacy — where she IS is used, never kept; old words do not live forever.

7.10, Koral: "there must be no malicious tracking of where a person is now and
where they will be". Her choices: live location is used for the one request and
then gone; history is not kept indefinitely.

  strip_location(text)   removes the live-fix prefix ("[נמצאת עכשיו ב-…]"), a
                         shared WhatsApp pin's sentence, and any bare coordinate
                         pair, BEFORE a turn is written to history. History is
                         replayed to the model on later turns and shadowed to
                         lumi_conversations — the fix must never reach either.
  current_is_fresh(p)    a WhatsApp-shared pin (profile.currentAddress) counts
                         for CURRENT_TTL_S, then reads as unknown.
  scrub_note(note, …)    a judge note goes into EVERY user's system prompt, so
                         one that names her people or places is dropped.
  run_retention_loop()   daily: conversation + provenance rows older than
                         RETENTION_DAYS deleted in Supabase; stale pins wiped.
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

CURRENT_TTL_S = 30 * 60
RETENTION_DAYS = 30

_HERE_RE = re.compile(r"\[נמצאת עכשיו ב-[^\]]*\]\s*")
_PIN_RE = re.compile(r"\(I'm sharing my current location:[^)]*\)\s*", re.IGNORECASE)
_COORDS_RE = re.compile(r"\(?-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\)?")


def strip_location(text: str) -> str:
    if not text:
        return text
    out = _HERE_RE.sub("", text)
    out = _PIN_RE.sub("", out)
    out = _COORDS_RE.sub("", out)
    return out.strip()


def current_is_fresh(prof: dict, now: Optional[float] = None) -> bool:
    at = prof.get("currentAt") if isinstance(prof, dict) else None
    try:
        ts = float(at)
    except (TypeError, ValueError):
        return False
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    return 0 <= now - ts <= CURRENT_TTL_S


def without_stale_current(prof: dict) -> dict:
    """The profile with a shared pin blanked once it is older than the TTL."""
    if prof.get("currentAddress") or prof.get("currentLat") is not None:
        if not current_is_fresh(prof):
            prof = {**prof, "currentAddress": "", "currentLat": None,
                    "currentLng": None, "currentAt": None}
    return prof


_STOP = {"the", "and", "for", "you", "your", "with", "that", "this", "not", "but",
         "are", "was", "she", "her", "his", "him", "they", "them", "task", "time"}
_WORD_RE = re.compile(r"[A-Za-z֐-׿]{3,}")


def scrub_note(note: str, user_msg: str = "", task: Optional[dict] = None) -> str:
    """'' when the note could identify her (digits, or a word taken from her
    message or task that is a name — Hebrew, or Capitalised); else the note."""
    note = (note or "").strip()
    if not note or re.search(r"\d", note):
        return ""
    task = task or {}
    loc = task.get("location") if isinstance(task.get("location"), dict) else {}
    contact = task.get("contact") if isinstance(task.get("contact"), dict) else {}
    source = " ".join(str(x or "") for x in (
        user_msg, task.get("text"), loc.get("address"), loc.get("displayName"),
        contact.get("name")))
    risky = {w.lower() for w in _WORD_RE.findall(source)
             if (w[0].isupper() or "֐" <= w[0] <= "׿") and w.lower() not in _STOP}
    if any(w.lower() in risky for w in _WORD_RE.findall(note)):
        return ""
    return note[:160]


# ── retention ───────────────────────────────────────────────────────────────

async def prune_once() -> dict:
    out: dict = {}
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).isoformat()
    import supabase_tasks
    if supabase_tasks._enabled():   # noqa: SLF001
        import httpx
        async with httpx.AsyncClient(timeout=20) as client:
            for table in ("lumi_conversations", "lumi_sessions"):
                try:
                    r = await client.delete(
                        supabase_tasks._rest(table),            # noqa: SLF001
                        headers={**supabase_tasks._headers(),   # noqa: SLF001
                                 "Prefer": "return=minimal"},
                        params={"createdAt": f"lt.{cutoff}"})
                    out[table] = r.status_code
                except Exception as exc:  # noqa: BLE001 — retried tomorrow
                    out[table] = f"error: {exc}"
    try:
        import user_profile
        data = user_profile._load()   # noqa: SLF001
        wiped = 0
        for rec in data.values():
            if isinstance(rec, dict) and (rec.get("currentAddress") or rec.get("currentLat") is not None) \
                    and not current_is_fresh(rec):
                rec.update(currentAddress="", currentLat=None, currentLng=None, currentAt=None)
                wiped += 1
        if wiped:
            user_profile._save(data)   # noqa: SLF001
        out["stale_pins_wiped"] = wiped
    except Exception as exc:  # noqa: BLE001
        out["stale_pins_wiped"] = f"error: {exc}"
    try:
        import conversation
        data = conversation._load()   # noqa: SLF001
        touched = 0
        for turns in data.values():
            for t in turns if isinstance(turns, list) else []:
                if t.get("role") == "user" and isinstance(t.get("content"), str):
                    clean = strip_location(t["content"])
                    if clean != t["content"]:
                        t["content"], touched = clean, touched + 1
        if touched:
            conversation._save(data)   # noqa: SLF001
        out["history_fixes_stripped"] = touched
    except Exception as exc:  # noqa: BLE001
        out["history_fixes_stripped"] = f"error: {exc}"
    logger.warning("privacy retention: %s", out)
    return out


async def run_retention_loop() -> None:
    await asyncio.sleep(60)
    try:
        import field_crypto   # once per volume: seal rows written before 7.10
        await field_crypto.reseal_existing()
    except Exception as exc:  # noqa: BLE001 — retried next boot
        logger.error("field_crypto reseal failed: %s", exc)
    while True:
        try:
            await prune_once()
        except Exception as exc:  # noqa: BLE001 — never kill the loop
            logger.error("privacy retention failed: %s", exc)
        await asyncio.sleep(24 * 3600)
