"""phone_links — which WhatsApp number belongs to which app account, PROVED.

THE HOLE THIS CLOSES (7.10 audit). The server used to learn "this account's
phone" from app_settings."whatsAppPhone" — a column the user writes herself,
from a free-text field, with no proof. A signed-in stranger who typed someone
else's number BECAME that person: /tasks/{phone} returned her tasks and places,
the agent loaded her memory, /push/register sent her alerts to the stranger's
phone, and her WhatsApp-made tasks were mirrored into the stranger's account.

Now a link exists only after the number itself proves it (reverse OTP):
  1. the app asks POST /app/link/start → a 6-digit code (10 min) and a wa.me
     link that opens WhatsApp with "קוד חיבור למאירה: 123456" prefilled;
  2. she sends it. Meta signs the webhook and tells US the sender — the number
     is a fact of the transport, not a claim in a body;
  3. confirm(sender, text) links userId ↔ that number. One number, one account.
No Meta template is needed: she messages us first.

Store (secure_store, encrypted): {userId: {"phone", "at", "via"},
"_pending": {sha256(code): {"userId", "exp"}}, "_fails": {phone: [ts…]},
"_meta": {"grandfathered_at", "conflicts"}}. Keyed by userId at the top level
so account_deletion's generic purge removes the link.

Existing app_settings pairs are grandfathered ONCE (grandfather()), so nobody
already connected is cut off; pairs where two accounts claim one number are
NOT linked and are listed for review in /admin/links.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
import time
from typing import Optional

import httpx

import config
import secure_store
from tz import now_il

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "phone_links.json")
CODE_TTL_S = 600
MAX_FAILS_PER_DAY = 5            # wrong codes one WhatsApp number may send a day
_CODE_RE = re.compile(r"(?:חיבור|link|connect)\D{0,30}(\d{6})\b", re.IGNORECASE)
_RESERVED = ("_pending", "_fails", "_meta")


def _digits(phone: object) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


def _hash(code: str) -> str:
    return hashlib.sha256(f"meira-link:{code}".encode()).hexdigest()


def _load() -> dict:
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def _links(data: dict) -> dict:
    return {k: v for k, v in data.items() if k not in _RESERVED and isinstance(v, dict)}


# ── reading ──────────────────────────────────────────────────────────────────

def phone_for(user_id: str) -> Optional[str]:
    """The VERIFIED WhatsApp number of this account, or None."""
    row = _load().get(str(user_id or ""))
    return _digits(row.get("phone")) or None if isinstance(row, dict) else None


def user_for(phone: str) -> Optional[str]:
    """The account this number is verifiably linked to — exact digits only."""
    want = _digits(phone)
    if not want:
        return None
    for uid, row in _links(_load()).items():
        if _digits(row.get("phone")) == want:
            return uid
    return None


def summary() -> dict:
    """For /admin/links: who is linked, how, and any pairs left for review."""
    data = _load()
    return {"links": [{"userId": uid, "phone_tail": _digits(r.get("phone"))[-3:],
                       "via": r.get("via"), "at": r.get("at")}
                      for uid, r in _links(data).items()],
            "meta": data.get("_meta") or {}}


# ── linking ──────────────────────────────────────────────────────────────────

def start(user_id: str) -> dict:
    """A fresh code for this account; any earlier code of hers is dropped."""
    data = _load()
    now = time.time()
    pending = {h: p for h, p in (data.get("_pending") or {}).items()
               if p.get("exp", 0) > now and p.get("userId") != user_id}
    while True:
        code = f"{secrets.randbelow(10**6):06d}"
        if _hash(code) not in pending:
            break
    pending[_hash(code)] = {"userId": str(user_id), "exp": now + CODE_TTL_S}
    data["_pending"] = pending
    _save(data)
    return {"code": code, "expires_in": CODE_TTL_S}


def looks_like_code(text: str) -> bool:
    return bool(_CODE_RE.search(text or "")) and len(text or "") <= 120


def confirm(sender: str, text: str) -> dict:
    """The webhook's half: {"ok": True, "userId"} or {"ok": False, "reason"}.

    `sender` MUST be the Meta-signed `from` of the message — never a body field."""
    phone = _digits(sender)
    m = _CODE_RE.search(text or "")
    if not phone or not m:
        return {"ok": False, "reason": "no_code"}
    data = _load()
    now = time.time()
    fails = [t for t in (data.get("_fails") or {}).get(phone, []) if t > now - 86400]
    if len(fails) >= MAX_FAILS_PER_DAY:
        return {"ok": False, "reason": "too_many_attempts"}
    pending = data.get("_pending") or {}
    hit = pending.get(_hash(m.group(1)))
    if not hit or hit.get("exp", 0) <= now:
        data.setdefault("_fails", {})[phone] = fails + [now]
        _save(data)
        return {"ok": False, "reason": "wrong_or_expired"}
    user_id = hit["userId"]
    pending.pop(_hash(m.group(1)), None)
    # One number, one account: proving the number moves it here.
    for uid, row in list(_links(data).items()):
        if _digits(row.get("phone")) == phone and uid != user_id:
            logger.warning("phone_links: number moved to a new account by proof")
            del data[uid]
    data[user_id] = {"phone": phone, "at": now_il().isoformat(), "via": "otp"}
    (data.get("_fails") or {}).pop(phone, None)
    _save(data)
    return {"ok": True, "userId": user_id}


async def write_display_phone(user_id: str, phone: str) -> None:
    """Mirror the PROVED number into app_settings so the app can show it.
    Display only — nothing on the server reads that column for identity."""
    import supabase_tasks
    if not supabase_tasks._enabled():   # noqa: SLF001
        return
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.post(
                supabase_tasks._rest("app_settings") + "?on_conflict=userId",   # noqa: SLF001
                headers={**supabase_tasks._headers(),                           # noqa: SLF001
                         "Prefer": "resolution=merge-duplicates,return=minimal"},
                json={"userId": user_id, "whatsAppPhone": phone})
            if r.status_code >= 300:
                logger.warning("phone_links: display phone write HTTP %s", r.status_code)
    except Exception as exc:  # noqa: BLE001 — the link itself is already saved
        logger.warning("phone_links: display phone write failed: %s", exc)


async def grandfather() -> dict:
    """Once: adopt the pairs app_settings held before proof was required.

    A number claimed by two accounts is adopted by neither — that is exactly the
    shape of the attack — and goes to _meta.conflicts for the owner to review."""
    data = _load()
    meta = data.get("_meta") or {}
    if meta.get("grandfathered_at"):
        return {"skipped": True}
    import supabase_tasks
    if not supabase_tasks._enabled():   # noqa: SLF001
        return {"skipped": True, "why": "supabase not configured"}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(supabase_tasks._rest("app_settings"),   # noqa: SLF001
                             headers=supabase_tasks._headers(),       # noqa: SLF001
                             params={"select": "userId,whatsAppPhone",
                                     "whatsAppPhone": "not.is.null", "limit": "1000"})
    if r.status_code != 200:
        raise RuntimeError(f"app_settings read HTTP {r.status_code}")
    by_phone: dict[str, list[str]] = {}
    for row in r.json():
        p = _digits(row.get("whatsAppPhone"))
        if len(p) >= 9 and row.get("userId"):
            by_phone.setdefault(p, []).append(str(row["userId"]))
    adopted, conflicts = 0, []
    for p, uids in by_phone.items():
        if len(set(uids)) > 1:
            conflicts.append({"phone_tail": p[-3:], "accounts": sorted(set(uids))})
            continue
        if uids[0] not in data:
            data[uids[0]] = {"phone": p, "at": now_il().isoformat(), "via": "grandfathered"}
            adopted += 1
    meta.update({"grandfathered_at": now_il().isoformat(), "conflicts": conflicts})
    data["_meta"] = meta
    _save(data)
    logger.warning("phone_links: grandfathered %d link(s), %d conflict(s) left for review",
                   adopted, len(conflicts))
    return {"adopted": adopted, "conflicts": len(conflicts)}


_display_number: Optional[str] = None


async def meira_number() -> Optional[str]:
    """Meira's own WhatsApp number (digits) for the wa.me link."""
    global _display_number
    if _display_number:
        return _display_number
    env = _digits(os.getenv("MEIRA_WHATSAPP_NUMBER"))
    if env:
        _display_number = env
        return env
    if not (config.WHATSAPP_API_TOKEN and config.WHATSAPP_BUSINESS_PHONE_ID):
        return None
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                f"https://graph.facebook.com/{config.WHATSAPP_GRAPH_VERSION}/"
                f"{config.WHATSAPP_BUSINESS_PHONE_ID}",
                headers={"Authorization": f"Bearer {config.WHATSAPP_API_TOKEN}"},
                params={"fields": "display_phone_number"})
        _display_number = _digits((r.json() or {}).get("display_phone_number")) or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("phone_links: Meira's number lookup failed: %s", exc)
    return _display_number
