"""task_shape — is this an appointment, or is it work?

Python port of `src/utils/taskShape.ts` (`classifyShape`).

On 2026-09-30 the server reported "business plan × meetup overlap by 90 min"
while the phone, which files a placeless piece of work as flexible, said
nothing at all. Two brains, two answers about the same evening. Both sides now
ask the same question in the same order:

  somewhere she must BE        → time-bound ('has-place')
  a kind of thing that is an
  appointment                  → time-bound ('appointment-kind')
  a diary entry someone else
  made (calendar, email)       → time-bound ('external')
  anything else                → flexible  ('no-anchor')

An hour written on the task is deliberately NOT an anchor — half the creation
paths set one, and Lumi's own optimiser writes an hour when it parks work in a
slot. See the TypeScript for the full argument.

Pure: no I/O. Parity is pinned by the clash golden
(`tests/fixtures/clash-golden.json`), whose `kind` depends on this.
"""
from __future__ import annotations

import re

APPOINTMENT_CATEGORIES = frozenset({
    "interview", "meeting", "call", "doctor", "class", "course",
    "conference", "zoom", "hobby_class",
})

EXTERNAL_SOURCES = frozenset({"calendar", "gcal", "email", "gmail"})


def place_of(task: dict) -> str:
    """The place this task requires her to be, as text. '' when it needs none."""
    loc = task.get("location")
    if not loc:
        return ""
    if isinstance(loc, str):
        return loc.strip()
    if isinstance(loc, dict):
        return str(loc.get("address") or loc.get("displayName") or "").strip()
    return ""


_PREP_ID_RE = re.compile(r"^prep-\d+d-")
_STUDY_RE = re.compile(r"(^|\s)(ללמוד|לימוד|לחזור על|שיעורי בית|study|homework|revise)(\s|$)", re.IGNORECASE)
_GAPFILL_PREP_RE = re.compile(r"^\s*(?:prepare for|להתכונן ל)\s*:", re.IGNORECASE)


def is_prep_block(task: dict) -> bool:
    """Her preparation FOR an appointment (interviewPrep.isPrepBlock) — desk work."""
    return bool(task.get("prepForTaskId") or _PREP_ID_RE.match(str(task.get("id") or ""))
                or _GAPFILL_PREP_RE.match(str(task.get("text") or "")))


def classify_shape(task: dict) -> dict:
    """{'shape': 'time-bound' | 'flexible', 'reason': …} — same order as the TS."""
    if place_of(task):
        return {"shape": "time-bound", "reason": "has-place"}
    if is_prep_block(task):
        return {"shape": "flexible", "reason": "prep"}
    if _STUDY_RE.search(str(task.get("text") or "")):
        return {"shape": "flexible", "reason": "study"}
    if str(task.get("category") or "") in APPOINTMENT_CATEGORIES:
        return {"shape": "time-bound", "reason": "appointment-kind"}
    if str(task.get("source") or "") in EXTERNAL_SOURCES:
        return {"shape": "time-bound", "reason": "external"}
    return {"shape": "flexible", "reason": "no-anchor"}


def is_flexible(task: dict) -> bool:
    return classify_shape(task)["shape"] == "flexible"


if __name__ == "__main__":   # self-check: python server/task_shape.py
    assert is_flexible({"text": "לעשות תכנית עסקית", "category": "general"})
    assert not is_flexible({"text": "meetup", "category": "call",
                            "location": {"address": "Sarona Market"}})
    assert classify_shape({"category": "doctor"})["reason"] == "appointment-kind"
    assert classify_shape({"category": "general", "source": "calendar"})["reason"] == "external"
    print("task_shape self-check OK")
