"""Expo push notifications — send a push to the mobile app's Expo token.

Uses Expo's push HTTP API (no FCM server key needed in code; Expo holds the
Android credentials uploaded via `eas credentials`). httpx is already a dep.

Dependencies: none beyond httpx. Called by reminders._push_if_registered with
tokens the app registered through POST /push/register (src/services/PushService.ts).
"""
import logging

import httpx

logger = logging.getLogger(__name__)

_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


async def send_push(token: str, title: str, body: str) -> bool:
    """Best-effort single push. Returns True if Expo accepted it."""
    if not token or not token.startswith("ExponentPushToken"):
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                _EXPO_PUSH_URL,
                json={"to": token, "title": title, "body": body, "sound": "default"},
                headers={"Content-Type": "application/json"},
            )
            data = r.json()
        ok = (data.get("data") or {}).get("status") == "ok"
        if not ok:
            logger.warning("expo push not ok: %s", data)
        return ok
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("expo push failed: %s", exc)
        return False
