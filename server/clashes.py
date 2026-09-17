"""clashes — "these two collide" turned into "here is what you could do".

The last piece of real scheduling arithmetic that lived only on the phone.
`src/utils/resolveClashes.ts` decides what to offer when two tasks collide, and
until now the server could not answer the same question — so a day that the app
called impossible was a day WhatsApp had no opinion about. This is that file,
ported rule for rule.

Deliberately pure: no storage, no network, no model. Every option is derived
from facts already on the task (does it need a place? did somebody else set its
time?), so the options are always true and always explainable. The agent phrases
them; it never invents them.

Two ideas carry most of the logic, and both are easy to get wrong:

  `isFixed` is NOT "can this move" — in this codebase it only means "has a
  clock time", which is true of nearly every task. The real question is who set
  the time, which is what canStartLater/canLeaveEarly answer.

  Back-to-back is not the same as compatible. A gym ending at 20:00 and a beach
  starting at 20:00 overlap by zero minutes and are still impossible if the two
  are 25 minutes apart. Both an overlap AND a travel shortfall count as a clash.

Parity with the TypeScript is the point, so the rules, the option kinds and the
option ORDER are identical; `server/tests/test_clashes.py` mirrors the fixtures
in `tests/run-clash-resolution.ts`.

Dependencies: day_schedule (time helpers, snake_case/camelCase tolerance).
Consumed by lumi_agent's clash tooling and the app's schedule endpoints.
"""
from __future__ import annotations

import re
from typing import Callable, Optional

import day_schedule as _ds

# Someone else is in the room, so the END of the slot is not hers to pick. You
# cannot tell an interviewer or a doctor you are leaving at half time.
# Everything else — a conference, a class, a course, the gym — you can walk out
# of early; that is the ordinary way a person makes two things fit.
HELD_WITH_HER = ("interview", "doctor", "meeting", "call", "zoom")

# …and these START when they start, whatever she does. A conference does not
# begin later because she is running late; she just misses the opening.
EXTERNALLY_TIMED = HELD_WITH_HER + ("conference", "class", "course")

#: Anything that is a web address rather than somewhere you can stand.
_URL_RE = re.compile(r"(https?://|www\.)\S+", re.IGNORECASE)

#: Two places we know nothing about are still not the same place, so an unknown
#: gap falls back to a deliberately small non-zero number rather than pretending
#: teleportation.
UNKNOWN_TRAVEL_MINUTES = 15


def _get(task: dict, *names, default=None):
    return _ds._get(task, *names, default=default)


def start_of(task: dict) -> Optional[str]:
    return _ds.hhmm(_get(task, "fixed_time", "fixedTime")) or \
        _ds.hhmm(_get(task, "scheduled_time", "scheduledTime"))


def end_of(task: dict) -> str:
    return _ds.add_minutes(start_of(task), _ds.duration_of(task))


def is_meeting_link(text) -> bool:
    """True when `text` is a link, not a place. A bare "zoom" is a hint, not a
    link — someone may genuinely be going to a room called that."""
    return bool(text) and bool(_URL_RE.search(str(text).strip()))


def is_remote_task(task: dict) -> bool:
    """Can this be done from anywhere? A task with a video link needs no travel,
    which is what makes it the flexible half of a clash: the call can happen on
    the way to the thing that does need a place."""
    if _get(task, "meeting_url", "meetingUrl"):
        return True
    location = _get(task, "location")
    if isinstance(location, str) and is_meeting_link(location):
        return True
    return str(_get(task, "category", default="")) in ("zoom", "call")


def can_leave_early(task: dict) -> bool:
    return str(_get(task, "category", default="")) not in HELD_WITH_HER


def can_start_later(task: dict) -> bool:
    if str(_get(task, "category", default="")) in EXTERNALLY_TIMED:
        return False
    # A calendar invite is somebody else's arrangement too.
    return str(_get(task, "source", default="")) not in ("calendar", "gcal")


def _place(task: dict) -> str:
    location = _get(task, "location")
    if isinstance(location, str):
        return location.strip().lower()
    if isinstance(location, dict):
        return str(location.get("address") or location.get("displayName") or "").strip().lower()
    return ""


def travel_minutes_between(first: dict, second: dict,
                           leg_lookup: Optional[Callable[[dict, dict], Optional[int]]] = None) -> int:
    """Minutes of travel needed to get from `first`'s place to `second`'s.

    Same-place is zero; different places always need SOME time. The number is
    read off the route already computed for `second`, which is a route from
    HOME — right whenever both places are near home and wrong otherwise. That
    is a known limitation carried over from the TypeScript, and `leg_lookup` is
    the seam for fixing it: pass a real origin→destination estimator and it
    wins, with this heuristic as the fallback it always was.
    """
    a, b = _place(first), _place(second)
    if not a or not b or a == b:
        return 0
    if leg_lookup:
        try:
            real = leg_lookup(first, second)
            if isinstance(real, (int, float)) and real > 0:
                return int(real)
        except Exception:  # noqa: BLE001 — an estimate must never break a plan
            pass
    location = _get(second, "location")
    known = None
    if isinstance(location, dict):
        known = location.get("travelMinutes")
        if not known:
            plan = location.get("transitPlan") or {}
            known = plan.get("totalDurationMinutes") if isinstance(plan, dict) else None
    return int(known) if isinstance(known, (int, float)) and known > 0 else UNKNOWN_TRAVEL_MINUTES


def timed(tasks) -> list:
    """Tasks with a clock time, earliest first."""
    return sorted(
        [t for t in tasks if _get(t, "status") != "complete" and start_of(t)],
        key=lambda t: _ds.time_to_minutes(start_of(t)))


def first_free_slot(tasks, minutes: int, not_before: str,
                    day_end: str = "23:00") -> Optional[str]:
    """The earliest start at or after `not_before` where `minutes` fits without
    touching anything else. None when the day has no room left."""
    busy = [(_ds.time_to_minutes(start_of(t)), _ds.time_to_minutes(end_of(t)))
            for t in timed(tasks)]
    cursor = _ds.time_to_minutes(not_before)
    limit = _ds.time_to_minutes(day_end)
    for _ in range(100):     # walk forward past anything we land inside
        clash = next(((s, e) for s, e in busy if cursor < e and cursor + minutes > s), None)
        if not clash:
            break
        cursor = clash[1]
    if cursor + minutes > limit:
        return None
    return f"{cursor // 60:02d}:{cursor % 60:02d}"


def overlap_minutes(a: dict, b: dict) -> int:
    """How many minutes two tasks genuinely share. 0 means no overlap."""
    a_start, a_end = _ds.time_to_minutes(start_of(a)), _ds.time_to_minutes(end_of(a))
    b_start, b_end = _ds.time_to_minutes(start_of(b)), _ds.time_to_minutes(end_of(b))
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def resolve_clashes(tasks, day_end: str = "23:00",
                    leg_lookup: Optional[Callable[[dict, dict], Optional[int]]] = None) -> list:
    """Every genuine collision in the day, each with what could be done about it.

    Options are ordered best-first: attend-remotely (one side needs no place),
    move (one side has no fixed time and the day has room), keep-both (leave the
    first earlier or start the second later), shorten, and finally choose —
    which is not a suggestion but a question, asked rather than decided.
    """
    day = timed(tasks)
    out = []

    for i in range(len(day)):
        for j in range(i + 1, len(day)):
            a, b = day[i], day[j]
            mins = overlap_minutes(a, b)
            first, second = (a, b) if _ds.time_to_minutes(start_of(a)) <= _ds.time_to_minutes(start_of(b)) else (b, a)
            travel_needed = travel_minutes_between(first, second, leg_lookup)
            gap = _ds.time_to_minutes(start_of(second)) - _ds.time_to_minutes(end_of(first))
            shortfall = max(0, travel_needed - gap) if travel_needed > 0 else 0
            if mins <= 0 and shortfall <= 0:
                continue

            options = []

            # 1. A call needs no place — it can ride along to the one that does.
            for remote, fixed_place in ((a, b), (b, a)):
                if is_remote_task(remote) and not is_remote_task(fixed_place):
                    options.append({
                        "kind": "attend-remotely",
                        "taskId": _get(remote, "id"),
                        "labelEn": f'Join "{_get(remote, "text")}" on the way to "{_get(fixed_place, "text")}"',
                        "labelHe": f'להצטרף ל"{_get(remote, "text")}" בדרך ל"{_get(fixed_place, "text")}"',
                    })

            # 2. Whichever side is not pinned to a clock can move, if there is room.
            for flexible, other in ((a, b), (b, a)):
                if _get(flexible, "is_fixed", "isFixed"):
                    continue
                slot = first_free_slot(day, _ds.duration_of(flexible), end_of(other), day_end)
                if slot:
                    options.append({
                        "kind": "move",
                        "taskId": _get(flexible, "id"),
                        "newTime": slot,
                        "labelEn": f'Move "{_get(flexible, "text")}" to {slot}',
                        "labelHe": f'להזיז את "{_get(flexible, "text")}" ל-{slot}',
                    })

            # 2b. Keep BOTH — what a person actually does with a long day that
            # swallows an evening: go to the conference, leave early enough to
            # cross town, still make the second thing. There are exactly two
            # honest versions, and which is right depends on what matters to her
            # today, so offer both and never choose silently.
            must_end_by = _ds.time_to_minutes(start_of(second)) - travel_needed
            if can_leave_early(first) and must_end_by - _ds.time_to_minutes(start_of(first)) >= 15:
                trip = (f' — {travel_needed} min to "{_get(second, "text")}"',
                        f' — {travel_needed} דק\' ל"{_get(second, "text")}"') if travel_needed > 0 else \
                       (f' — in time for "{_get(second, "text")}"',
                        f' — בזמן ל"{_get(second, "text")}"')
                options.append({
                    "kind": "end-earlier",
                    "taskId": _get(first, "id"),
                    "newTime": _hhmm(must_end_by),
                    "labelEn": f'Keep both — leave "{_get(first, "text")}" at {_hhmm(must_end_by)}{trip[0]}',
                    "labelHe": f'להספיק את שתיהן — לצאת מ"{_get(first, "text")}" ב-{_hhmm(must_end_by)}{trip[1]}',
                })
            new_start = _ds.time_to_minutes(end_of(first)) + travel_needed
            if can_start_later(second) and new_start < _ds.time_to_minutes(day_end):
                options.append({
                    "kind": "delay-next",
                    "taskId": _get(second, "id"),
                    "newTime": _hhmm(new_start),
                    "labelEn": f'Start "{_get(second, "text")}" at {_hhmm(new_start)} instead — after "{_get(first, "text")}"',
                    "labelHe": f'להתחיל את "{_get(second, "text")}" ב-{_hhmm(new_start)} — אחרי "{_get(first, "text")}"',
                })

            # 3. It does not FIT anywhere, but it could still happen — shorter.
            for flexible, other in ((a, b), (b, a)):
                if _get(flexible, "is_fixed", "isFixed"):
                    continue
                if any(o["kind"] == "move" and o["taskId"] == _get(flexible, "id") for o in options):
                    continue
                start = end_of(other)
                left = _ds.time_to_minutes(day_end) - _ds.time_to_minutes(start)
                if left >= 30 and left < _ds.duration_of(flexible):
                    options.append({
                        "kind": "shorten",
                        "taskId": _get(flexible, "id"),
                        "newTime": start,
                        "labelEn": f'Start "{_get(flexible, "text")}" at {start} instead — {left} min rather than {_ds.duration_of(flexible)}',
                        "labelHe": f'להתחיל את "{_get(flexible, "text")}" ב-{start} — {left} דק\' במקום {_ds.duration_of(flexible)}',
                    })

            # 4. Nothing tidy is available. Do not pick for her — ask, and say
            # plainly what the choice costs. That sentence is the difference
            # between a decision and a surprise.
            if not options:
                options = [
                    {"kind": "choose", "taskId": _get(a, "id"),
                     "labelEn": f'Keep "{_get(a, "text")}" · let go of "{_get(b, "text")}"',
                     "labelHe": f'להשאיר את "{_get(a, "text")}" · לוותר על "{_get(b, "text")}"'},
                    {"kind": "choose", "taskId": _get(b, "id"),
                     "labelEn": f'Keep "{_get(b, "text")}" · let go of "{_get(a, "text")}"',
                     "labelHe": f'להשאיר את "{_get(b, "text")}" · לוותר על "{_get(a, "text")}"'},
                ]

            both = f'"{_get(a, "text")}" & "{_get(b, "text")}"'
            if options[0]["kind"] == "choose":
                question_en = f"{both} overlap by {mins} min and neither can move. Which matters more today?"
                question_he = f"{both} חופפות ב-{mins} דק' ואי אפשר להזיז אף אחת. מה יותר חשוב לך היום?"
            elif mins <= 0:
                question_en = f'"{_get(first, "text")}" ends when "{_get(second, "text")}" starts, but they are {travel_needed} min apart. Which gives?'
                question_he = f'"{_get(first, "text")}" נגמרת כש"{_get(second, "text")}" מתחילה, אבל יש ביניהן {travel_needed} דק\' נסיעה. מה מוותר?'
            else:
                question_en = f"{both} overlap by {mins} min."
                question_he = f"{both} חופפות ב-{mins} דק'."

            out.append({
                "a": a, "b": b,
                "overlapMinutes": mins,
                "travelShortfall": shortfall or None,
                "options": options,
                "questionEn": question_en,
                "questionHe": question_he,
            })
    return out


if __name__ == "__main__":   # self-check: python server/clashes.py
    day = [
        {"id": "conf", "text": "conference", "category": "conference",
         "fixed_time": "09:00", "duration_minutes": 780, "is_fixed": True,
         "location": "Expo Tel Aviv"},
        {"id": "class", "text": "pilates", "category": "hobby_class",
         "fixed_time": "18:00", "duration_minutes": 60, "is_fixed": True,
         "location": {"address": "Space Gym", "travelMinutes": 30}},
    ]
    clashes = resolve_clashes(day)
    assert len(clashes) == 1, clashes
    kinds = [o["kind"] for o in clashes[0]["options"]]
    assert "end-earlier" in kinds, kinds
    leave = next(o for o in clashes[0]["options"] if o["kind"] == "end-earlier")
    assert leave["newTime"] == "17:30", leave      # 18:00 minus 30 min of travel
    assert clashes[0]["overlapMinutes"] == 60
    print("clashes self-check OK:", kinds)
