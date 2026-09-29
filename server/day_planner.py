"""day_planner — put the day's flexible tasks into time that is really free.

`day_schedule.build_day_schedule` sorts a day and walks a cursor through it. It
never looks at the gaps: a 3-hour study block placed at 13:00 runs straight
through a 14:30 interview, and nothing accounts for the hour spent getting
there. That is fine for "what order", and wrong for "when". This module answers
"when".

    "I must work on Meira today, and also study for the next Ceva interview."

Two flexible tasks and a day that already holds an interview with a train to
catch. The plan has to put the work somewhere that does not collide with the
journey, and the study somewhere that ENDS before she has to leave.

HOW

1. Busy time is not the event, it is the event plus getting there and back.
   A task with a stored route is busy from `leaveHomeBy` (or start minus its
   travel minutes) until it ends plus the trip home. A video call is not.
2. Free windows are [max(wake, now), sleep] minus busy time, with a buffer on
   both sides of every busy block.
3. Flexible tasks — no fixed time, no still-valid slot — are placed in order of
   priority (must first), then kind:
     focus  (work, study, courses)   → the earliest window that holds it: mornings
     active (gym, leisure, hobbies)  → after the last focus block
     calls                           → the latest window, at its end
     other                           → the earliest window that holds it
   Bigger blocks go first within a tier, so the small ones fill the gaps.
4. Constraints: a deadline today ends the task by its time; a prep block tied
   to an event (prepForTaskId / parentId) ends before that event's busy time;
   `latestStartBy` bounds the start.
5. When nothing holds the whole task, study shrinks to the largest window worth
   having (25 min+) and says so; everything else is returned UNPLACED with the
   reason. Never silently dropped (silent-state rule 1).

A slot a task already holds, still ahead of now, is kept — hers or an earlier
plan's — so a re-plan does not reshuffle a day she has seen.

Reasons are codes, not sentences: the app words them in both languages.

Pure: no I/O, no clock unless `now` is passed. Dependencies: day_schedule
helpers only. Consumed by routes_app (/app/schedule/build, mode "plan").
"""
from __future__ import annotations

from typing import Any, Iterable, Optional

from day_schedule import (
    MIN_STUDY_BLOCK_MINUTES,
    PRIORITY_ORDER,
    _get,
    duration_of,
    hhmm,
    is_study,
    round_up_quarter,
)

BUFFER_MINUTES = 10
MIN_USEFUL_BLOCK_MINUTES = 25
DAY = 24 * 60

FOCUS_CATEGORIES = {"work", "course", "class", "aspiration"}
ACTIVE_CATEGORIES = {"gym", "leisure", "hobby_class"}
CALL_CATEGORIES = {"call"}
REMOTE_CATEGORIES = {"zoom", "call"}
NOT_BUSY = {"complete", "moved", "missed", "cancelled", "archived", "deleted"}
MOVABLE = {None, "", "pending", "partial"}

KIND_ORDER = {"focus": 0, "other": 1, "active": 2, "calls": 3}


def _m(value: Any) -> Optional[int]:
    t = hhmm(value)
    if not t:
        return None
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _t(minutes: int) -> str:
    minutes = int(minutes) % DAY
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _loc(task: dict) -> dict:
    loc = _get(task, "location", default=None)
    return loc if isinstance(loc, dict) else {}


def _is_remote(task: dict) -> bool:
    if str(_get(task, "category", default="")) in REMOTE_CATEGORIES:
        return True
    raw = _get(task, "location", default=None)
    text = raw if isinstance(raw, str) else str(_loc(task).get("address") or "")
    return text.strip().lower().startswith(("http://", "https://"))


def travel_minutes(task: dict) -> int:
    """One-way minutes to this task's place, from what the task already knows."""
    if _is_remote(task):
        return 0
    loc = _loc(task)
    for key in ("travelMinutes", "travel_minutes"):
        try:
            if loc.get(key) is not None:
                return max(0, int(loc[key]))
        except (TypeError, ValueError):
            pass
    plan = loc.get("transitPlan") or loc.get("transit_plan") or {}
    try:
        return max(0, int(plan.get("totalDurationMinutes") or 0))
    except (TypeError, ValueError, AttributeError):
        return 0


def kind_of(task: dict) -> str:
    category = str(_get(task, "category", default="general"))
    if category in CALL_CATEGORIES:
        return "calls"
    if category in ACTIVE_CATEGORIES:
        return "active"
    if category in FOCUS_CATEGORIES or is_study(task):
        return "focus"
    return "other"


def _task_id(task: dict, index: int) -> str:
    return str(_get(task, "id", default=f"#{index}"))


def _busy_block(task: dict) -> Optional[tuple[int, int]]:
    """[start, end) in minutes that this task takes out of the day, travel included."""
    start = _m(_get(task, "fixed_time", "fixedTime")) \
        or _m(_get(task, "scheduled_time", "scheduledTime"))
    if start is None:
        return None
    end = start + duration_of(task)
    travel = travel_minutes(task)
    loc = _loc(task)
    leave = _m(loc.get("leaveHomeBy") or loc.get("leave_home_by")
               or (loc.get("transitPlan") or {}).get("leaveHomeAt"))
    if leave is not None and leave <= start:
        busy_start = leave
    else:
        busy_start = start - travel
    return max(0, busy_start), end + travel


def _subtract(windows: list[tuple[int, int]], block: tuple[int, int]) -> list[tuple[int, int]]:
    out = []
    b0, b1 = block
    for w0, w1 in windows:
        if b1 <= w0 or b0 >= w1:
            out.append((w0, w1))
            continue
        if b0 > w0:
            out.append((w0, b0))
        if b1 < w1:
            out.append((b1, w1))
    return [w for w in out if w[1] - w[0] > 0]


def plan_day(
    tasks: Iterable[dict],
    *,
    wake_time: str = "08:00",
    sleep_time: str = "22:00",
    now: Optional[str] = None,
    buffer_minutes: int = BUFFER_MINUTES,
) -> dict:
    """Place the flexible tasks. Returns {placed, unplaced, windows}.

    placed:   [{id, text, start, end, why, shortened_from?}]
    unplaced: [{id, text, why, need, largest}]
    windows:  the free time left afterwards, [{start, end}]
    """
    tasks = list(tasks)
    wake = _m(wake_time) if _m(wake_time) is not None else 8 * 60
    sleep = _m(sleep_time) if _m(sleep_time) is not None else 22 * 60
    if sleep <= wake:
        sleep += DAY               # "sleep at 00:30" is tonight, not this morning
    earliest = wake
    now_m = _m(now) if now else None
    if now_m is not None:
        earliest = max(earliest, _m(round_up_quarter(_t(now_m))) or now_m)

    movable: list[tuple[str, dict]] = []
    busy: dict[str, tuple[int, int]] = {}
    for i, task in enumerate(tasks):
        tid = _task_id(task, i)
        status = _get(task, "status", default=None)
        if status in NOT_BUSY:
            continue
        fixed = _m(_get(task, "fixed_time", "fixedTime"))
        slot = _m(_get(task, "scheduled_time", "scheduledTime"))
        if fixed is None and (slot is None or (now_m is not None and slot < now_m)):
            # No clock time, or a slot that has already gone: hers to place.
            if status in MOVABLE:
                movable.append((tid, task))
            continue
        block = _busy_block(task)
        if block:
            busy[tid] = block

    # Free time, with a buffer either side of everything already spoken for.
    windows = [(earliest, sleep)] if sleep - earliest > 0 else []
    for b0, b1 in sorted(busy.values()):
        windows = _subtract(windows, (b0 - buffer_minutes, b1 + buffer_minutes))

    def latest_end_for(task: dict) -> Optional[int]:
        bounds = []
        deadline_time = _m(_get(task, "deadlineTime", "deadline_time"))
        task_date = str(_get(task, "date", default=""))[:10]
        deadline = str(_get(task, "deadline", default=""))[:10]
        if deadline_time is not None and (not deadline or deadline == task_date):
            bounds.append(deadline_time)
        parent = _get(task, "prepForTaskId", "prep_for_task_id", "parentId", "parent_id")
        if parent and str(parent) in busy:
            bounds.append(busy[str(parent)][0] - buffer_minutes)
        latest_start = _m(_get(task, "latestStartBy", "latest_start_by"))
        if latest_start is not None:
            bounds.append(latest_start + duration_of(task))
        return min(bounds) if bounds else None

    order = sorted(
        movable,
        key=lambda item: (
            PRIORITY_ORDER.get(_get(item[1], "priority", default=""), 4),
            KIND_ORDER[kind_of(item[1])],
            -duration_of(item[1]),
        ),
    )

    placed: list[dict] = []
    unplaced: list[dict] = []
    focus_end: Optional[int] = None

    for tid, task in order:
        kind = kind_of(task)
        base = duration_of(task)
        wanted = max(base, MIN_STUDY_BLOCK_MINUTES) if is_study(task) else base
        travel = travel_minutes(task)
        cap = latest_end_for(task)

        def usable(w: tuple[int, int]) -> tuple[int, int]:
            w0, w1 = w
            if cap is not None:
                w1 = min(w1, cap + travel)
            if kind == "active" and focus_end is not None:
                w0 = max(w0, focus_end + buffer_minutes)
            return w0, w1

        candidates = [usable(w) for w in windows]
        candidates = [w for w in candidates if w[1] - w[0] > 0]

        def fits(need: int) -> list[tuple[int, int]]:
            return [w for w in candidates if w[1] - w[0] >= need + 2 * travel]

        chosen: Optional[tuple[int, int]] = None
        length = wanted
        why = {"focus": "focus_morning", "active": "after_work_block",
               "calls": "end_of_day", "other": "first_free"}[kind]
        shortened_from = None
        for need in dict.fromkeys((wanted, base)):   # try the study block, then her own estimate
            pool = fits(need)
            if pool:
                chosen = pool[-1] if kind == "calls" else pool[0]
                length = need
                break
        if chosen is None and kind == "active" and focus_end is not None:
            # Nothing after the work block: any time beats no time.
            focus_end_saved, focus_end = focus_end, None
            candidates = [w for w in (usable(w) for w in windows) if w[1] - w[0] > 0]
            pool = fits(base)
            focus_end = focus_end_saved
            if pool:
                chosen, length, why = pool[0], base, "first_free"
        if chosen is None and (kind == "focus" or _get(task, "priority") == "must"):
            best = max(candidates, key=lambda w: w[1] - w[0], default=None)
            room = (best[1] - best[0] - 2 * travel) if best else 0
            if best and room >= MIN_USEFUL_BLOCK_MINUTES:
                chosen, length, shortened_from, why = best, room, wanted, "shortened"

        if chosen is None:
            largest = max((w[1] - w[0] - 2 * travel for w in candidates), default=0)
            reason = "no_window"
            if cap is not None and cap <= earliest:
                reason = "past_deadline"
            elif earliest >= sleep:
                # Only when the day really has ended. At 14:02 with a full
                # afternoon this said "the day is over, tomorrow?".
                reason = "day_over"
            unplaced.append({"id": tid, "text": _get(task, "text", "title", default=""),
                             "why": reason, "need": wanted, "largest": max(0, largest)})
            continue

        w0, w1 = chosen
        if kind == "calls":
            start = w1 - travel - length
        else:
            start = w0 + travel
        end = start + length
        if cap is not None and why != "shortened" and end <= cap and kind != "calls":
            why = "before_deadline"
        entry = {"id": tid, "text": _get(task, "text", "title", default=""),
                 "start": _t(start), "end": _t(end), "why": why}
        if shortened_from:
            entry["shortened_from"] = shortened_from
        placed.append(entry)
        busy[tid] = (start - travel, end + travel)
        windows = _subtract(windows, (start - travel - buffer_minutes, end + travel + buffer_minutes))
        if kind == "focus":
            focus_end = max(focus_end or 0, end)

    placed.sort(key=lambda p: _m(p["start"]) or 0)
    return {
        "placed": placed,
        "unplaced": unplaced,
        "windows": [{"start": _t(a), "end": _t(b)} for a, b in windows
                    if b - a >= MIN_USEFUL_BLOCK_MINUTES],
    }
