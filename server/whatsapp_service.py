"""WhatsApp Cloud API client (send messages, mark read) via Meta Graph API.

Dependencies: config (WHATSAPP_* creds). Consumed by main.py (webhook replies,
mark-as-read) and reminders.py (firing scheduled reminders). All methods are
best-effort: they log and return instead of raising, so a Meta outage never
crashes the webhook or the reminder poller.
"""
import logging

import httpx

import config

logger = logging.getLogger(__name__)


def _graph_url() -> str:
    """Graph API /messages endpoint for the configured business phone."""
    return (
        f"https://graph.facebook.com/{config.WHATSAPP_GRAPH_VERSION}"
        f"/{config.WHATSAPP_BUSINESS_PHONE_ID}/messages"
    )


def _headers() -> dict:
    """Bearer-token headers for every Graph API call."""
    return {
        "Authorization": f"Bearer {config.WHATSAPP_API_TOKEN}",
        "Content-Type": "application/json",
    }


class WhatsAppService:
    """Outbound WhatsApp actions. Stateless — safe to call from any task/loop."""

    @staticmethod
    async def send_message(to_phone: str, text: str) -> bool:
        """Send a text (truncated to WhatsApp's 4096-char cap). False on any failure."""
        if not config.WHATSAPP_API_TOKEN or not config.WHATSAPP_BUSINESS_PHONE_ID:
            logger.warning("WhatsApp not configured; would send to %s: %s", to_phone, text)
            return False
        payload = {
            "messaging_product": "whatsapp",
            "to": to_phone,
            "type": "text",
            "text": {"body": text[:4096]},
        }
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(_graph_url(), headers=_headers(), json=payload)
                resp.raise_for_status()
                return True
        except httpx.HTTPError as exc:
            logger.error("WhatsApp send failed: %s", exc)
            return False

    @staticmethod
    async def send_options(to_phone: str, body: str, options: list,
                           footer: str = "") -> bool:
        """Send `body` with TAPPABLE choices instead of "reply with a number".

        Typing "2" was never reliable: the reply has to survive a regex, a
        pending-choice lookup and a language-agnostic owner check, and when any
        of that missed, the pick fell through to the model — which answered
        "לא הבנתי" and asked the whole question again. A button reply comes
        back with the id WE set, so there is nothing to parse and nothing to
        guess.

        `options` is a list of {id, title} (title is trimmed to WhatsApp's
        20-char button limit). Up to three become buttons; more become a list
        picker (10 rows max). Returns False if WhatsApp refused it — the caller
        must then fall back to send_message with the numbered text, so a chat
        where interactive messages are unavailable still works exactly as
        before.
        """
        if not config.WHATSAPP_API_TOKEN or not config.WHATSAPP_BUSINESS_PHONE_ID:
            logger.warning("WhatsApp not configured; would offer %d options to %s",
                           len(options or []), to_phone)
            return False
        if not options:
            return False

        base = {"messaging_product": "whatsapp", "to": to_phone, "type": "interactive"}
        if len(options) <= 3:
            interactive = {
                "type": "button",
                "body": {"text": body[:1024]},
                "action": {"buttons": [
                    {"type": "reply", "reply": {"id": str(o["id"])[:256],
                                                "title": str(o["title"])[:20]}}
                    for o in options[:3]
                ]},
            }
        else:
            interactive = {
                "type": "list",
                "body": {"text": body[:1024]},
                "action": {
                    "button": "בחרי" if any("\u05d0" <= c <= "\u05ea" for c in body) else "Choose",
                    "sections": [{"rows": [
                        {"id": str(o["id"])[:200], "title": str(o["title"])[:24],
                         "description": str(o.get("description", ""))[:72]}
                        for o in options[:10]
                    ]}],
                },
            }
        if footer:
            interactive["footer"] = {"text": footer[:60]}
        payload = {**base, "interactive": interactive}

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(_graph_url(), headers=_headers(), json=payload)
                resp.raise_for_status()
                return True
        except httpx.HTTPError as exc:
            # Not fatal: the caller sends the plain numbered text instead.
            logger.warning("WhatsApp interactive send failed (%s) — falling back to text", exc)
            return False

    @staticmethod
    async def download_media(media_id: str) -> bytes | None:
        """Fetch inbound media (voice notes, images) by id: GET /{media_id} for
        the ephemeral URL, then GET it with the bearer token. None on failure."""
        if not config.WHATSAPP_API_TOKEN:
            return None
        auth = {"Authorization": f"Bearer {config.WHATSAPP_API_TOKEN}"}
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                meta = await client.get(
                    f"https://graph.facebook.com/{config.WHATSAPP_GRAPH_VERSION}/{media_id}",
                    headers=auth,
                )
                meta.raise_for_status()
                url = meta.json().get("url")
                if not url:
                    return None
                blob = await client.get(url, headers=auth)
                blob.raise_for_status()
                return blob.content
        except httpx.HTTPError as exc:
            logger.error("media download failed: %s", exc)
            return None

    @staticmethod
    async def send_image_bytes(to_phone: str, image: bytes, caption: str = "",
                               mime: str = "image/png") -> bool:
        """Upload an image to WhatsApp media storage and send it (route maps).
        Two Graph calls: POST /media (multipart) → media id → POST /messages.
        False on any failure — callers treat the map as optional garnish."""
        if not config.WHATSAPP_API_TOKEN or not config.WHATSAPP_BUSINESS_PHONE_ID:
            logger.warning("WhatsApp not configured; would send image to %s", to_phone)
            return False
        media_url = (
            f"https://graph.facebook.com/{config.WHATSAPP_GRAPH_VERSION}"
            f"/{config.WHATSAPP_BUSINESS_PHONE_ID}/media"
        )
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                up = await client.post(
                    media_url,
                    headers={"Authorization": f"Bearer {config.WHATSAPP_API_TOKEN}"},
                    data={"messaging_product": "whatsapp"},
                    files={"file": ("route.png", image, mime)},
                )
                up.raise_for_status()
                media_id = up.json().get("id")
                if not media_id:
                    logger.error("media upload returned no id: %s", up.text[:200])
                    return False
                payload = {
                    "messaging_product": "whatsapp",
                    "to": to_phone,
                    "type": "image",
                    "image": {"id": media_id, **({"caption": caption[:1024]} if caption else {})},
                }
                resp = await client.post(_graph_url(), headers=_headers(), json=payload)
                resp.raise_for_status()
                return True
        except httpx.HTTPError as exc:
            logger.error("WhatsApp image send failed: %s", exc)
            return False

    @staticmethod
    async def send_document(to_phone: str, data: bytes, filename: str = "document.pdf",
                            caption: str = "", mime: str = "application/pdf") -> bool:
        """Upload a document (a tailored-CV PDF) and send it. Same two-call flow
        as send_image_bytes: POST /media → id → POST /messages (type=document).
        False on any failure so the caller can fall back to a text reply."""
        if not config.WHATSAPP_API_TOKEN or not config.WHATSAPP_BUSINESS_PHONE_ID:
            logger.warning("WhatsApp not configured; would send document to %s", to_phone)
            return False
        media_url = (
            f"https://graph.facebook.com/{config.WHATSAPP_GRAPH_VERSION}"
            f"/{config.WHATSAPP_BUSINESS_PHONE_ID}/media"
        )
        try:
            async with httpx.AsyncClient(timeout=45) as client:
                up = await client.post(
                    media_url,
                    headers={"Authorization": f"Bearer {config.WHATSAPP_API_TOKEN}"},
                    data={"messaging_product": "whatsapp"},
                    files={"file": (filename, data, mime)},
                )
                up.raise_for_status()
                media_id = up.json().get("id")
                if not media_id:
                    logger.error("document upload returned no id: %s", up.text[:200])
                    return False
                payload = {
                    "messaging_product": "whatsapp",
                    "to": to_phone,
                    "type": "document",
                    "document": {"id": media_id, "filename": filename,
                                 **({"caption": caption[:1024]} if caption else {})},
                }
                resp = await client.post(_graph_url(), headers=_headers(), json=payload)
                resp.raise_for_status()
                return True
        except httpx.HTTPError as exc:
            logger.error("WhatsApp document send failed: %s", exc)
            return False

    @staticmethod
    async def mark_as_read(message_id: str) -> None:
        """Show the blue ticks for an inbound message. Fire-and-forget."""
        if not config.WHATSAPP_API_TOKEN:
            return
        payload = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
        }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(_graph_url(), headers=_headers(), json=payload)
        except httpx.HTTPError as exc:
            logger.warning("WhatsApp mark_as_read failed: %s", exc)
