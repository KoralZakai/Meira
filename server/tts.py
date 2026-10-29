"""tts — Meira's voice, Google Cloud Text-to-Speech (Chirp 3 HD).

8.10, Koral: the first meeting must "sound native". The phone's own engine
(expo-speech) reads Hebrew like a timetable. Her pick: Google Chirp 3 HD, in
the Google Cloud project the server's Maps key already belongs to.

A voice is tried in order — Chirp 3 HD, then WaveNet, then Standard — so a
voice Google does not serve for a language costs one 400, never silence; the
one that answered is remembered. The same sentence twice (every new user
hears the same greeting) is answered from memory.

synthesize() never returns empty bytes as success: it returns (mp3, None) or
(None, reason) with reason in not_configured | refused | provider_failed
(silent-state rule 1). The fix differs: set the key / enable the
Text-to-Speech API on the key's project / try again.
"""
from __future__ import annotations

import base64
import hashlib
import logging
from collections import OrderedDict
from typing import Optional

import httpx

import config

logger = logging.getLogger(__name__)

_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
MAX_CHARS = 600            # Meira speaks SHORT (CLAUDE.md); a paragraph is a bug upstream
_CACHE_MAX = 200

VOICES = {
    "he": ("he-IL-Chirp3-HD-Aoede", "he-IL-Wavenet-A", "he-IL-Standard-A"),
    "en": ("en-US-Chirp3-HD-Aoede", "en-US-Wavenet-F", "en-US-Standard-F"),
}
_working: dict[str, str] = {}
_cache: "OrderedDict[tuple[str, str], bytes]" = OrderedDict()
# The phone's player loads GET /app/tts/<id>: the sentence travels in a POST
# body, never in a URL (a routine's name is hers), and the id points here.
_by_id: "OrderedDict[str, bytes]" = OrderedDict()


def clip_id(lang: str, text: str) -> str:
    return hashlib.sha256(f"{lang}|{text}".encode()).hexdigest()[:24]


def clip(clip_id_: str) -> Optional[bytes]:
    return _by_id.get(clip_id_)


def _keep(lang: str, text: str, audio: bytes) -> None:
    _cache[(lang, text)] = audio
    _by_id[clip_id(lang, text)] = audio
    while len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)
    while len(_by_id) > _CACHE_MAX:
        _by_id.popitem(last=False)


async def synthesize_id(text: str, lang: str = "") -> tuple[Optional[str], Optional[str]]:
    """(id for GET /app/tts/<id>, None) or (None, reason)."""
    text_ = (text or "").strip()[:MAX_CHARS]
    audio, why = await synthesize(text_, lang)
    if not audio:
        return None, why
    lang_ = language_of(text_, lang)
    _keep(lang_, text_, audio)
    return clip_id(lang_, text_), None


def _key() -> Optional[str]:
    return getattr(config, "GOOGLE_TTS_API_KEY", None) or config.GOOGLE_MAPS_API_KEY


def language_of(text: str, hint: str = "") -> str:
    """'he' when the sentence is mostly Hebrew letters, else the hint, else 'en'."""
    heb = sum(1 for c in text if "֐" <= c <= "׿")
    lat = sum(1 for c in text if c.isascii() and c.isalpha())
    if heb or lat:
        return "he" if heb >= lat else "en"
    return "he" if hint == "he" else "en"


async def synthesize(text: str, lang: str = "") -> tuple[Optional[bytes], Optional[str]]:
    text = (text or "").strip()[:MAX_CHARS]
    if not text:
        return None, "empty"
    key = _key()
    if not key:
        return None, "not_configured"
    lang = language_of(text, lang)
    hit = _cache.get((lang, text))
    if hit:
        _cache.move_to_end((lang, text))
        return hit, None

    voices = VOICES[lang]
    if lang in _working:
        voices = (_working[lang],) + tuple(v for v in voices if v != _working[lang])
    reason = "provider_failed"
    async with httpx.AsyncClient(timeout=15) as client:
        for voice in voices:
            body = {
                "input": {"text": text},
                "voice": {"languageCode": voice[:5], "name": voice},
                "audioConfig": {"audioEncoding": "MP3", "speakingRate": 1.0},
            }
            try:
                r = await client.post(_URL, params={"key": key}, json=body)
            except httpx.HTTPError as exc:
                logger.warning("tts: %s unreachable: %s", voice, type(exc).__name__)
                return None, "provider_failed"
            if r.status_code == 200:
                audio = base64.b64decode((r.json() or {}).get("audioContent") or "")
                if not audio:
                    return None, "provider_failed"
                if _working.get(lang) != voice:
                    logger.warning("tts: speaking %s with %s", lang, voice)
                    _working[lang] = voice
                _keep(lang, text, audio)
                return audio, None
            detail = r.text[:160].replace("\n", " ")
            if r.status_code in (401, 403):
                # The API is off on the key's project, or the key is restricted
                # to other APIs: no voice will answer — say which fix.
                logger.error("tts refused (%s): %s — enable Text-to-Speech on the key's project",
                             r.status_code, detail)
                return None, "refused"
            # 400: this voice is not served for this language — try the next.
            logger.warning("tts: %s → %s %s", voice, r.status_code, detail)
            reason = "provider_failed"
    return None, reason
