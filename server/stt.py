"""Speech-to-text — WhatsApp voice notes AND the app's microphone.

One call to Groq's OpenAI-compatible /audio/transcriptions endpoint (Whisper
large v3). Hebrew + English are both handled by the model, including mixed
speech. Best-effort: never raises.

Why Groq and not the main LLM provider: this used to POST to Nebius's
/audio/transcriptions, which does not exist. Every voice note logged
"404 Not Found" and the user got "couldn't hear that" — for as long as the
feature has shipped. Nebius documents no audio endpoint and does not list a
Whisper model; Groq does, with the identical multipart request shape, so only
the base URL and auth changed.

Why the app uses this too: the app used Android's built-in recogniser, pinned to
ONE language (the UI language) and stopping at the first pause. Hebrew spoken
into an English UI came back as English-sounding nonsense. WhatsApp never had
that problem because the whole recording reaches Whisper with no language
pinned. `POST /app/stt` gives the app the same path.

`transcribe_detailed` says WHY it has no text (silent-state rule 1): "not
configured", "the provider refused" and "nobody spoke" are three different
fixes, and the old bare `None` made them one. `transcribe` keeps the old
signature for the WhatsApp webhook.

Dependencies: config (GROQ_API_KEY / GROQ_BASE_URL / STT_MODEL), httpx,
llm_usage (cost visibility). Consumed by main.whatsapp_webhook (audio branch)
and routes_app.POST /app/stt.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

import httpx

import config
import llm_usage

logger = logging.getLogger(__name__)

# Whisper reads at most 224 tokens of prompt. A vocabulary hint is a list of
# names, so a character cap is a close enough stand-in and needs no tokenizer.
MAX_PROMPT_CHARS = 400

# The request's file NAME is how the provider decides the container format, so
# it must match what was recorded: the app records AAC in an MPEG-4 container.
_EXT_BY_MIME = {
    "audio/ogg": "ogg", "audio/opus": "ogg",
    "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a",
    "audio/mpeg": "mp3", "audio/mp3": "mp3",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
    "audio/webm": "webm", "audio/flac": "flac",
}


@dataclass(frozen=True)
class SttResult:
    """Text, or the reason there is none.

    error: "stt_not_configured" | "provider_failed" | "no_speech" | None
    """
    text: Optional[str]
    error: Optional[str] = None
    detail: Optional[str] = None


def is_configured() -> bool:
    """False when no STT key is set — the caller falls back to asking for text."""
    return bool(config.GROQ_API_KEY)


def filename_for(mime: str) -> str:
    """voice.<ext> for a MIME type; unknown types are sent as m4a, the app's format."""
    base = (mime or "").split(";")[0].strip().lower()
    return f"voice.{_EXT_BY_MIME.get(base, 'm4a')}"


# Whisper reads the prompt as the words spoken just BEFORE the recording, and
# copies their language — and their sentences. On 2026-09-28 the app's hint
# held her task titles ("Final review for ראיון בטלפון עם אמזון — questions to
# ask, what to wear…"), and a Hebrew recording came back as English interview
# questions: "1. Why did you apply? 2. …". So: names only, and a Hebrew opening
# so that Hebrew speech stays Hebrew (English words inside it still come out
# in English — that is how she talks).
PRIMER = "מאירה, תרשמי לי:"
_MAX_TERMS = 12
_MAX_TERM_WORDS = 3


def clean_prompt(prompt: Optional[str]) -> str:
    """The prompt Whisper gets: the Hebrew primer plus a SHORT vocabulary list.

    The hint biases SPELLING (Meira, Ceva, a street name) — it is not an
    instruction. Anything longer than a name (a task title, a question, a
    sentence) is dropped: a long one is transcribed instead of the audio.
    """
    text = " ".join(str(prompt or "").split())
    terms: list = []
    seen: set = set()
    for piece in re.split(r"[,\n;|•·—–]+", text):
        piece = piece.strip(" .:-\"'")
        if (not piece or "?" in piece or len(piece.split()) > _MAX_TERM_WORDS
                or piece.lower() in seen):
            continue
        seen.add(piece.lower())
        terms.append(piece)
        if len(terms) >= _MAX_TERMS:
            break
    return f"{PRIMER} {', '.join(terms)}".strip()[:MAX_PROMPT_CHARS]


_UNSURE = -0.7


def confidence(body: dict) -> float:
    """Whisper's mean log-probability over the segments: near 0 is sure, below
    -1 is guessing. No segments (plain json) counts as sure — nothing to judge."""
    segs = body.get("segments") if isinstance(body, dict) else None
    probs = []
    for s in segs or []:
        try:
            probs.append(float(s.get("avg_logprob")))
        except (TypeError, ValueError):
            continue
    return sum(probs) / len(probs) if probs else 0.0


def needs_hebrew_retry(body: dict) -> bool:
    """Not Hebrew, and not sure of it either. A confident English sentence is
    left alone — she does speak English too."""
    lang = str((body or {}).get("language") or "").lower()
    return lang not in ("hebrew", "he", "iw") and confidence(body) < _UNSURE


def _without_primer(text: str) -> str:
    """Whisper sometimes echoes the prompt's opening; it was never said."""
    t = (text or "").strip()
    core = PRIMER.rstrip(":")
    return t[len(core):].lstrip(" :,.") if t.startswith(core) else t


# Whisper writes speech into silence and room noise. Tested on her phone
# 2026-09-28: five seconds of nobody talking came back as "Ckep, Pekka, and
# the rest of the team." — which the voice planner then tried to plan. The
# rule is Whisper's own (openai/whisper transcribe.py): a segment it thinks
# is probably not speech AND is unsure of its words was never said.
_NO_SPEECH_PROB = 0.6
_LOW_LOGPROB = -1.0
_SURELY_SILENT = 0.9
# The phrases it invents most, from subtitle training data, in both languages.
_KNOWN_PHANTOMS = re.compile(
    r"^\W*(thanks? (you )?for watching|thank you\.?|please subscribe|subtitles? by"
    r"|תודה שצפיתם|תודה רבה\.?|כתוביות)\W*$", re.IGNORECASE)


def heard_text(body: dict) -> str:
    """The words actually spoken, with Whisper's phantom segments dropped.

    Falls back to `text` when the provider sent no segments. Every dropped
    segment is logged with its numbers, so the threshold can be tuned from
    what she really said rather than guessed."""
    segments = body.get("segments") if isinstance(body, dict) else None
    if not isinstance(segments, list) or not segments:
        text = str((body or {}).get("text") or "").strip()
        return "" if _KNOWN_PHANTOMS.match(text) else text
    kept = []
    for seg in segments:
        words = str(seg.get("text") or "").strip()
        try:
            silent = float(seg.get("no_speech_prob") or 0.0)
            sure = float(seg.get("avg_logprob") or 0.0)
        except (TypeError, ValueError):
            silent, sure = 0.0, 0.0
        if (silent > _SURELY_SILENT or (silent > _NO_SPEECH_PROB and sure < _LOW_LOGPROB)
                or _KNOWN_PHANTOMS.match(words)):
            logger.warning("STT dropped a phantom segment %r (no_speech=%.2f logprob=%.2f)",
                           words[:60], silent, sure)
            continue
        kept.append(words)
    return " ".join(w for w in kept if w).strip()


async def transcribe_detailed(
    audio: bytes,
    mime: str = "audio/ogg",
    *,
    prompt: Optional[str] = None,
) -> SttResult:
    """Audio bytes → SttResult. Never raises."""
    if not config.GROQ_API_KEY:
        logger.warning("STT skipped: GROQ_API_KEY not set")
        return SttResult(None, "stt_not_configured", "GROQ_API_KEY is not set on the server")
    if not audio:
        return SttResult(None, "no_speech", "the recording was empty")

    base = (config.GROQ_BASE_URL or "").rstrip("/")
    # `language` is unset on the first pass: the user mixes Hebrew and English
    # mid-sentence, and pinning one hurts the other. Only an unsure non-Hebrew
    # answer is asked again with Hebrew pinned (needs_hebrew_retry).
    # verbose_json: every segment says how sure Whisper is that anyone spoke.
    data = {"model": config.STT_MODEL, "response_format": "verbose_json"}
    data["prompt"] = clean_prompt(prompt)
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            async def ask(extra: dict) -> httpx.Response:
                return await client.post(
                    f"{base}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
                    data={**data, **extra},
                    files={"file": (filename_for(mime), audio, mime or "audio/mp4")},
                )

            r = await ask({})
            if r.status_code != 200:
                logger.error("transcription failed (HTTP %s): %s", r.status_code, r.text[:200])
                return SttResult(None, "provider_failed", f"HTTP {r.status_code}")
            body = r.json()
            if needs_hebrew_retry(body):
                # She spoke Hebrew and Whisper, unsure, wrote English — twice on
                # her phone: "Madagascar, Khmer, Badawad…". Ask again with the
                # language pinned, and keep whichever answer it is surer of.
                again = await ask({"language": "he"})
                if again.status_code == 200:
                    other = again.json()
                    logger.warning("STT language retry: %s %.2f → he %.2f",
                                   body.get("language"), confidence(body), confidence(other))
                    if confidence(other) > confidence(body):
                        body = other
        text = _without_primer(heard_text(body))
    except (httpx.HTTPError, ValueError) as exc:
        logger.error("transcription failed: %s", exc)
        return SttResult(None, "provider_failed", type(exc).__name__)

    if not text:
        return SttResult(None, "no_speech", "the model heard no words")
    # Whisper bills by audio duration, not tokens; record the call so GET
    # /usage still shows that speech is costing something.
    llm_usage.record("stt_groq", 0, 0)
    return SttResult(text)


async def transcribe(audio: bytes, mime: str = "audio/ogg") -> str | None:
    """Voice note bytes → text. None on failure, empty result, or no key.

    The WhatsApp webhook's signature, unchanged: it only needs to know whether
    to reply or to ask for text.
    """
    return (await transcribe_detailed(audio, mime)).text
