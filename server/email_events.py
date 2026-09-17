"""email_events — real appointments out of a Gmail scan.

The last model call that ran on the phone. Gmail subjects and snippets went
straight from the device to Nebius with the bundled key; this moves that one
call to the server and leaves the mailbox itself where it is — the app reads
Gmail with the user's own Google token and sends only what it found, so no
mailbox access moves to the server.

Extraction is the model's job (an email is prose). The DATE is not: relative
expressions are resolved by tz.resolve_date, the same parser the WhatsApp path
uses, and anything the model dates in the past is dropped rather than
hopefully corrected — a fabricated appointment is worse than a missed one.

Dependencies: config, llm_usage, tz. Consumed by
routes_app.POST /app/email/events.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date as _date
from typing import Optional

from openai import AsyncOpenAI

import config
import model_router
import llm_usage
import tz as _tz

logger = logging.getLogger(__name__)

_client: Optional[AsyncOpenAI] = None

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


#: Invariant part of the extraction prompt, emitted FIRST so the provider can
#: cache it. Only the date below it changes per call.
_STATIC = (
    "You extract real upcoming events (appointments, interviews, reservations, "
    "meetings) from emails.\n"
    'Output ONLY strict JSON: {"events":[{"title":str,"date":"YYYY-MM-DD",'
    '"time":"HH:MM"|null,"location":str|null,"prep":str|null,"sourceIndex":int}]}\n'
    '"prep" = what the user must prepare, bring or complete for it (documents, '
    "forms, payment, study topics…), one short sentence, or null.\n"
    "Rules: only events ON or AFTER today; resolve relative dates from today; "
    "skip ads, newsletters and anything without a concrete date. Hebrew and "
    "English emails both. No prose.\n"
)


def _system(today: str) -> str:
    return f"{_STATIC}Today is {today}."


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    return _client


def clean(events: list, today: _date) -> list:
    """Keep only what is real: a title, a parseable date, and that date not in
    the past. An email-shaped hallucination becomes a phantom appointment with
    an alarm attached, so the filter is deliberately unforgiving."""
    today_iso = today.isoformat()
    out = []
    for event in events:
        if not isinstance(event, dict) or not event.get("title"):
            continue
        raw_date = str(event.get("date") or "")
        if not _DATE_RE.match(raw_date):
            resolved = _tz.resolve_date(raw_date, today) if raw_date else None
            if not resolved:
                continue
            raw_date = resolved.isoformat()
        if raw_date < today_iso:
            continue
        time_match = _TIME_RE.match(str(event.get("time") or ""))
        hour_minute = None
        if time_match:
            hour, minute = int(time_match.group(1)), int(time_match.group(2))
            if hour <= 23 and minute <= 59:
                hour_minute = f"{hour:02d}:{minute:02d}"
        out.append({
            "title": str(event["title"]),
            "date": raw_date,
            "time": hour_minute,
            "location": str(event["location"]) if event.get("location") else None,
            "prep": str(event["prep"]) if event.get("prep") else None,
            "sourceIndex": int(event["sourceIndex"]) if str(event.get("sourceIndex", "")).isdigit() else 0,
        })
    return out


async def extract(emails: list, today: Optional[_date] = None) -> list:
    """Emails ([{subject, sender, snippet}]) → upcoming events. [] on failure:
    a missed suggestion is recoverable, an invented appointment is not."""
    if not emails:
        return []
    today = today or _tz.today_il()
    listing = "\n---\n".join(
        f"{i}. FROM: {e.get('sender', '')}\nSUBJECT: {e.get('subject', '')}\n"
        f"SNIPPET: {e.get('snippet', '')}"
        for i, e in enumerate(emails) if isinstance(e, dict)
    )
    _model = config.LLM_MODEL_CHEAP or model_router.pick(
        "email_events", prompt_chars=len(listing))
    try:
        response = await _get_client().chat.completions.create(
            model=_model,
            messages=[{"role": "system", "content": _system(today.isoformat())},
                      {"role": "user", "content": listing}],
            temperature=0.1,
            max_tokens=600,
            response_format={"type": "json_object"},
            timeout=30,
        )
        usage = response.usage
        if usage:
            llm_usage.record("email_events", usage.prompt_tokens or 0,
                             usage.completion_tokens or 0, _model)
        payload = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("email_events failed: %s", exc)
        return []
    return clean(payload.get("events") or [], today)


if __name__ == "__main__":   # self-check: python server/email_events.py
    today = _date(2026, 9, 6)
    kept = clean([
        {"title": "Dentist", "date": "2026-09-10", "time": "9:30", "sourceIndex": "2"},
        {"title": "Old thing", "date": "2026-09-01"},          # in the past
        {"title": "No date"},                                   # unusable
        {"title": "Interview", "date": "מחר"},                  # relative, resolved
    ], today)
    assert [e["title"] for e in kept] == ["Dentist", "Interview"]
    assert kept[0]["time"] == "09:30" and kept[0]["sourceIndex"] == 2
    assert kept[1]["date"] == "2026-09-07"
    print("email_events self-check OK")
