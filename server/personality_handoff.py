"""WhatsApp -> app handoff for the personality quiz.

The token is a pointer, not a payload: it maps to a user_id, single-use, with
a 10-minute TTL. No quiz state travels inside it.

Dependencies: user_store (the handoff_token table it used lives there now —
there was never a Postgres to hold it, so every link Lumi sent was dead).
issue_handoff is called by lumi_agent's send_app_link tool; resolve_handoff by
main.py GET /personality/resolve when the app opens the lumi:// deep link.
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import user_store

TTL_MINUTES = 10


def _is_valid(expires_at: datetime, used: bool, now: Optional[datetime] = None) -> bool:
    """Pure validity check, isolated from the DB so it's unit-testable."""
    now = now or datetime.now(timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return not used and now <= expires_at


async def issue_handoff(user_id: str) -> dict:
    """Mint a one-time token for this user and return the app deep link."""
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=TTL_MINUTES)
    user_store.put_handoff(token, user_id, expires_at.isoformat())
    return {
        "token": token,
        "deep_link": f"lumi://personality?token={token}",
        "expires_at": expires_at.isoformat(),
    }


async def resolve_handoff(token: str) -> Optional[str]:
    """Single-use, TTL-checked resolve. Returns user_id, or None if invalid/expired/used."""
    row = user_store.take_handoff(token)   # marks it used in the same step
    if not row:
        return None
    try:
        expires_at = datetime.fromisoformat(str(row["expires_at"]))
    except (ValueError, KeyError):
        return None
    if not _is_valid(expires_at, bool(row.get("used"))):
        return None
    return str(row["user_id"])
