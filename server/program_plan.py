"""program_plan — "I want to improve my self-confidence, build me a program" (29.10).

Live, 29.10: the agent asked "what area feels shakiest?" AND saved five tasks
all titled "Improve my self confident build me a program" at random hours.
A program is two jobs, and they are split the way this codebase splits them:

  the model   writes the STEPS — 4-6 concrete, small actions with a title, a
              length and a part of the day (JSON, one call, `advice` tier:
              this is judgment about her). It never picks a date.
  code        dates them: one step per day from tomorrow, in that part of the
              day's free time (day_slots), never on a closed day (constraints),
              and saves them as ONE group (subgroup = the program's name).

`steps_from` / `schedule` are pure and tested; `build` makes the one call.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta
from typing import Optional

import llm_usage
import model_router

logger = logging.getLogger(__name__)

PROGRAM_RE = re.compile(
    r"(\bbuild\s+me\s+a\s+(?:program|plan|routine)|\bmake\s+me\s+a\s+(?:program|plan)|"
    r"\b(?:program|plan)\s+(?:to|for)\s+(?:improve|build|get|become|learn)|"
    r"תבני\s+לי\s+(?:תוכנית|תכנית)|תכיני\s+לי\s+(?:תוכנית|תכנית)|(?:תוכנית|תכנית)\s+ל(?:שפר|בנות|חיזוק|להיות))",
    re.I)

_SYSTEM = (
    "You are Meira, a warm, practical personal coach. She asked for a program. "
    "Write 5 concrete, SMALL steps for the next week (10-45 minutes each), in HER language, "
    "progressive (easy → harder), each one an action she can tick, not advice. "
    "Use what is known about her. Reply JSON only: "
    '{"name":"2-4 word program name","steps":[{"title":"short imperative action","minutes":20,'
    '"part":"morning|noon|afternoon|evening","why":"one short line"}]}')

_WINDOWS = {"morning": ("08:00", "12:00"), "noon": ("12:00", "14:30"),
            "afternoon": ("14:00", "18:00"), "evening": ("18:00", "22:00")}


def steps_from(payload: Optional[dict]) -> tuple:
    """(name, [steps]) from the model's JSON, cleaned; ('', []) when unusable."""
    if not isinstance(payload, dict):
        return "", []
    out = []
    for s in payload.get("steps") or []:
        if not isinstance(s, dict) or not str(s.get("title") or "").strip():
            continue
        try:
            minutes = max(5, min(int(s.get("minutes") or 20), 90))
        except (TypeError, ValueError):
            minutes = 20
        part = str(s.get("part") or "evening").lower()
        out.append({"title": str(s["title"]).strip()[:80], "minutes": minutes,
                    "part": part if part in _WINDOWS else "evening", "why": str(s.get("why") or "")[:120]})
    return str(payload.get("name") or "").strip()[:40], out[:6]


def schedule(steps: list, day_tasks: list, start: date, closed, slot_finder) -> list:
    """Each step on its own day from `start`, in its part of the day's free time,
    skipping days `closed(iso)` says are closed. -> [(step, iso, HH:MM)]."""
    out, d = [], start
    for step in steps:
        for _ in range(21):
            iso = d.isoformat()
            d += timedelta(days=1)
            if closed(iso):
                continue
            at = slot_finder(day_tasks, iso, step["minutes"], _WINDOWS[step["part"]])
            if at:
                out.append((step, iso, at))
                break
    return out


async def build(content: str, about: str) -> Optional[dict]:
    """The model's steps for this request, or None (the caller says it could not)."""
    import understand
    context = f"ABOUT HER:\n{about or '(little known)'}\n\nHER REQUEST: {content}"
    model = model_router.pick("program", prompt_chars=len(_SYSTEM) + len(context))
    try:
        resp = await understand._client().chat.completions.create(
            model=model, temperature=0.4, response_format={"type": "json_object"}, timeout=40, max_tokens=600,
            messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": context}])
        if resp.usage:
            llm_usage.record("program", resp.usage.prompt_tokens or 0, resp.usage.completion_tokens or 0, model)
        return json.loads(resp.choices[0].message.content or "{}")
    except Exception as exc:  # noqa: BLE001 — said, never a fake program
        logger.warning("program: steps not written: %s", type(exc).__name__)
        return None
