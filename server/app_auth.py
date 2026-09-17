"""app_auth — who is calling from the APP, proved rather than claimed.

The WhatsApp channel authenticates by transport: Twilio signs the webhook and
the sender's number comes from Twilio, not from the message. The app has no such
envelope, so an endpoint that simply believed a phone number in the body would
let anyone who knows that number read her tasks and speak as her.

Instead the app sends the Supabase access token it already holds from sign-in,
and Supabase itself validates it: `GET /auth/v1/user` with the token returns the
user, or 401. No JWT secret to store on this server, no signature code to get
wrong, and revocation and expiry are handled where the session actually lives.

The verified auth user id is then mapped to the phone the rest of the brain is
keyed on (app_settings."whatsAppPhone"), so the app and WhatsApp are ONE user
with one memory — the whole point of the exercise. A user with no linked phone
falls back to their user id as the key, which keeps the app usable on its own.

Dependencies: config (SUPABASE_URL / SERVICE_ROLE_KEY), supabase_tasks.
Consumed by main.py's app endpoints.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

import httpx
from fastapi import HTTPException, Request

import config
import supabase_tasks

logger = logging.getLogger(__name__)

_TIMEOUT = 8.0
# Verified tokens, briefly. A chat turn makes several calls and re-verifying each
# one adds a round-trip to Supabase for no security gain — the token's own expiry
# still governs, this only bounds how stale a revocation can be.
_CACHE_TTL = 300.0
_cache: dict[str, tuple[float, dict]] = {}


class AuthError(Exception):
    """The caller is not who they say they are (or did not say)."""


def _bearer(header: Optional[str]) -> str:
    if not header or not header.lower().startswith("bearer "):
        raise AuthError("missing bearer token")
    token = header.split(" ", 1)[1].strip()
    if not token:
        raise AuthError("empty bearer token")
    return token


async def verify(authorization: Optional[str]) -> dict:
    """Verify an Authorization header -> {'userId', 'email'}. Raises AuthError.

    Supabase is the authority: a token it does not accept is not a user here.
    """
    token = _bearer(authorization)

    hit = _cache.get(token)
    if hit and hit[0] > time.time():
        return hit[1]

    if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY):
        raise AuthError("supabase not configured on this server")

    base = config.SUPABASE_URL.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"{base}/auth/v1/user",
                headers={
                    "apikey": config.SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {token}",
                },
            )
    except Exception as exc:  # noqa: BLE001
        # A network failure is NOT an authorization: fail closed.
        raise AuthError(f"could not reach Supabase to verify: {exc}") from exc

    if r.status_code != 200:
        raise AuthError(f"token rejected by Supabase (http {r.status_code})")

    body = r.json() or {}
    user_id = body.get("id")
    if not user_id:
        raise AuthError("no user id in Supabase response")

    identity = {"userId": str(user_id), "email": body.get("email")}
    _cache[token] = (time.time() + _CACHE_TTL, identity)
    return identity


async def phone_for_user_id(user_id: str) -> Optional[str]:
    """The WhatsApp number linked to this account, from app_settings.

    The reverse of supabase_tasks.user_id_for_phone. This is the join that makes
    one person out of two channels: without it the app would build a separate
    memory, separate tasks and a separate conversation under a different key.
    """
    if not supabase_tasks._enabled():   # noqa: SLF001 — same package, one config
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                supabase_tasks._rest("app_settings"),   # noqa: SLF001
                headers=supabase_tasks._headers(),      # noqa: SLF001
                params={"select": "whatsAppPhone", "userId": f"eq.{user_id}", "limit": "1"},
            )
            rows = r.json() if r.status_code == 200 else []
            phone = (rows[0].get("whatsAppPhone") if rows else None) or None
            return supabase_tasks._digits(phone) if phone else None   # noqa: SLF001
    except Exception as exc:  # noqa: BLE001 — best effort, never blocks a turn
        logger.warning("phone_for_user_id failed: %s", exc)
        return None


async def identify(authorization: Optional[str]) -> dict:
    """Verified caller -> {'userId', 'email', 'phone', 'key'}.

    `key` is what the brain is keyed on everywhere: the linked phone when there
    is one, else the account id. One person, one memory, whichever channel they
    happen to be speaking through.
    """
    identity = await verify(authorization)
    phone = await phone_for_user_id(identity["userId"])
    return {**identity, "phone": phone, "key": phone or identity["userId"]}


# ── FastAPI wiring ───────────────────────────────────────────────────────────


async def require_caller(request: Request) -> dict:
    """FastAPI dependency: the verified caller, or 401.

    Same verification path as `POST /agent/chat` has always used — this only
    packages it as a dependency so every route can share one implementation
    instead of each re-deriving identity from whatever the body happened to say.

    Fails CLOSED: `verify` raises AuthError when Supabase is unreachable or
    unconfigured, and that becomes a 401 here rather than an accidental allow.
    """
    try:
        return await identify(request.headers.get("authorization"))
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def storage_key_for(caller: dict, path_phone: Optional[str]) -> str:
    """The key this caller may read/write — never the one they asked for.

    THE POINT OF THIS FUNCTION. Every `/tasks/{phone}` and `/agents/{phone}`
    route takes the phone from the URL, which is a value the client chooses.
    Requiring a token but still trusting that path segment would fix
    authentication and leave authorization wide open: any signed-in user could
    read, edit and delete another user's tasks simply by typing their number.
    That is the same vulnerability as before, behind a login.

    So the storage key comes from the VERIFIED identity (`caller['key']`, set by
    Supabase), and the path segment is treated as an assertion to check rather
    than an instruction to obey:

      * names someone else's number  -> 403
      * names a number when the caller has none linked -> 403
      * matches, or is absent        -> the caller's own key

    Callers that still want the URL shape (the mobile app does) keep working
    unchanged; callers pointing at a stranger get told, loudly.
    """
    requested = supabase_tasks._digits(path_phone or "")   # noqa: SLF001
    own_phone = caller.get("phone")

    if requested:
        if not own_phone or requested != own_phone:
            raise HTTPException(
                status_code=403,
                detail="that phone number is not linked to your account",
            )
    return caller["key"]
