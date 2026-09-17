"""Speech-to-text for inbound WhatsApp voice notes.

One call to Groq's OpenAI-compatible /audio/transcriptions endpoint (Whisper
large v3). Hebrew + English are both handled by the model, including mixed
speech. Best-effort: None on any failure — the webhook then asks the user to
type instead.

Why Groq and not the main LLM provider: this used to POST to Nebius's
/audio/transcriptions, which does not exist. Every voice note logged
"404 Not Found" and the user got "couldn't hear that" — for as long as the
feature has shipped. Nebius documents no audio endpoint and does not list a
Whisper model; Groq does, with the identical multipart request shape, so only
the base URL and auth changed.

Dependencies: config (GROQ_API_KEY / GROQ_BASE_URL / STT_MODEL), httpx,
llm_usage (cost visibility). Consumed by main.whatsapp_webhook (audio branch).
"""
import logging

import httpx

import config
import llm_usage

logger = logging.getLogger(__name__)


def is_configured() -> bool:
    """False when no STT key is set — the caller falls back to asking for text."""
    return bool(config.GROQ_API_KEY)


async def transcribe(audio: bytes, mime: str = "audio/ogg") -> str | None:
    """Voice note bytes → text. None on failure, empty result, or no key."""
    if not config.GROQ_API_KEY:
        logger.warning("STT skipped: GROQ_API_KEY not set")
        return None
    base = (config.GROQ_BASE_URL or "").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{base}/audio/transcriptions",
                headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
                # `language` is deliberately unset: the user mixes Hebrew and
                # English mid-sentence, and pinning one hurts the other.
                data={"model": config.STT_MODEL, "response_format": "json"},
                files={"file": ("voice.ogg", audio, mime)},
            )
            if r.status_code != 200:
                logger.error("transcription failed (HTTP %s): %s", r.status_code, r.text[:200])
                return None
            text = (r.json().get("text") or "").strip()
            if text:
                # Whisper bills by audio duration, not tokens; record the call so
                # GET /usage still shows that speech is costing something.
                llm_usage.record("stt_groq", 0, 0)
            return text or None
    except (httpx.HTTPError, ValueError) as exc:
        logger.error("transcription failed: %s", exc)
        return None
