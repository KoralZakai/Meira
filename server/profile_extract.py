"""profile_extract — onboarding answers → profile fields, server-side.

The onboarding agent ran on the phone with the API key in the bundle, and its
prompt was the app's alone: the server had its own `save_profile` tool with
different field names and its own idea of what "morning routine" meant, so the
two halves of one product learned different things about the same person. This
moves the extraction to the server and, in the same motion, writes what it
learns into the profile the WhatsApp brain already reads.

The reply shape is exactly what OnboardingScreen already renders — camelCase,
`missingFields`, `followUpQuestion`, `isComplete` — because the screen's job is
now to render an answer, not to compute one. Required fields are decided here,
in code, rather than trusted from the model: `isComplete` was a field the model
could simply assert, and a model in a hurry ended an onboarding that had
collected nothing.

Dependencies: config, llm_usage, user_profile. Consumed by
routes_app.POST /app/profile/extract.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from openai import AsyncOpenAI

import config
import model_router
import llm_usage
import user_profile

logger = logging.getLogger(__name__)

_client: Optional[AsyncOpenAI] = None

REQUIRED = ("name", "transportMode", "workStartTime", "sleepTime")

_SYSTEM = "\n".join([
    "You are Lumi, a warm and friendly AI time assistant doing a first-time onboarding conversation.",
    "",
    "The user just answered one of your onboarding questions.",
    "",
    "Extract as much profile information as you can from their answer. Return ONLY valid JSON:",
    "{",
    '  "name": string or null,',
    '  "transportMode": "car" | "foot" | "bicycle" | "transit" | null,',
    '  "homeAddress": string or null,',
    '  "workAddress": string or null,',
    '  "morningHabits": [ { "habit": string, "estimatedMinutes": number } ] or [],',
    '  "totalMorningMinutesEstimate": number or null,',
    '  "workStartTime": string (HH:MM) or null,',
    '  "sleepTime": string (HH:MM) or null,',
    '  "routinesNotes": string or null,',
    '  "followUpQuestion": "your next warm question for what is still missing, or empty string"',
    "}",
    "",
    "routinesNotes: constraints and habits IN THEIR WORDS — a school pickup, a",
    "standing class, an hour that is never free, 'I cannot do mornings'. These",
    "never appear on a calendar and they are the reason a technically valid plan",
    "is still wrong.",
    "",
    "If they give a rough total for their morning ('about an hour') and no specific",
    "habits, set totalMorningMinutesEstimate and leave morningHabits empty.",
    "",
    "One question at a time, warm and short. The opening question asked for",
    "everything at once, so most people answer several fields in one breath: read",
    "the WHOLE answer before deciding what is missing. Asking again for something",
    "they just said is the fastest way to lose them.",
    "Answer in the language the user wrote in.",
])


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    return _client


def _clean_time(value) -> Optional[str]:
    import re
    if not isinstance(value, str):
        return None
    match = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", value)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    return f"{hour:02d}:{minute:02d}" if hour <= 23 and minute <= 59 else None


def missing_fields(merged: dict) -> list:
    """What onboarding still needs. Decided HERE, never taken from the model —
    `isComplete` used to be something the model could simply assert."""
    missing = [f for f in REQUIRED if not merged.get(f)]
    habits = merged.get("morningHabits") or []
    if len(habits) < 2 and not merged.get("totalMorningMinutesEstimate"):
        missing.append("morningHabitsOrTotal")
    return missing


def merge(known: dict, extracted: dict) -> dict:
    """Known profile + what this answer added. A null never erases what we have."""
    merged = dict(known or {})
    for key in ("name", "transportMode", "homeAddress", "workAddress",
                "routinesNotes", "morningHabits", "totalMorningMinutesEstimate"):
        value = extracted.get(key)
        if value not in (None, "", []):
            merged[key] = value
    for key in ("workStartTime", "sleepTime"):
        value = _clean_time(extracted.get(key))
        if value:
            merged[key] = value
    return merged


async def extract(transcript: str, known: Optional[dict] = None,
                  phone: Optional[str] = None) -> dict:
    """One onboarding answer → the fields it carried, plus what is still missing."""
    known = known or {}
    extracted: dict = {}
    follow_up = ""
    _model = config.LLM_MODEL_CHEAP or model_router.pick(
        "profile_extract", prompt_chars=len(_SYSTEM) + len(transcript))
    try:
        response = await _get_client().chat.completions.create(
            model=_model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user",
                 "content": f"Current known profile fields: {json.dumps(known, ensure_ascii=False)}"
                            f"\n\nUser answer: {transcript}"},
            ],
            temperature=0.2,
            response_format={"type": "json_object"},
            timeout=25,
        )
        usage = response.usage
        if usage:
            llm_usage.record("profile_extract", usage.prompt_tokens or 0,
                             usage.completion_tokens or 0, _model)
        extracted = json.loads(response.choices[0].message.content or "{}")
        follow_up = str(extracted.get("followUpQuestion") or "")
    except Exception as exc:  # noqa: BLE001 — the client keeps its local fallback
        logger.warning("profile_extract failed: %s", exc)
        raise

    merged = merge(known, extracted)
    missing = missing_fields(merged)

    # Write it where the WhatsApp brain reads it, so onboarding done in the app
    # is onboarding the whole product knows about — the divergence this
    # consolidation exists to end.
    if phone:
        try:
            user_profile.update_profile(
                phone,
                name=merged.get("name"),
                homeAddress=merged.get("homeAddress"),
                transportType={"transit": "bus", "foot": "walk"}.get(
                    merged.get("transportMode"), merged.get("transportMode")),
                morningRoutineMinutes=merged.get("totalMorningMinutesEstimate"),
                routinesNotes=merged.get("routinesNotes"),
                onboarded=not missing or None,
            )
        except Exception as exc:  # noqa: BLE001 — never fail onboarding on a write
            logger.warning("profile write skipped: %s", exc)

    return {**merged, "missingFields": missing, "followUpQuestion": follow_up,
            "isComplete": not missing}


if __name__ == "__main__":   # self-check: python server/profile_extract.py
    known = {"name": "קורל"}
    merged = merge(known, {"transportMode": "transit", "name": None,
                           "workStartTime": "9:00", "sleepTime": "24:30"})
    assert merged["name"] == "קורל", "a null must never erase what we know"
    assert merged["transportMode"] == "transit"
    assert merged["workStartTime"] == "09:00"
    assert "sleepTime" not in merged, "24:30 is not a time"
    assert "sleepTime" in missing_fields(merged)
    assert missing_fields({"name": "x", "transportMode": "car", "workStartTime": "09:00",
                           "sleepTime": "23:00", "totalMorningMinutesEstimate": 45}) == []
    print("profile_extract self-check OK")
