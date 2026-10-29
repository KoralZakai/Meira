"""day_plan — the day as Meira states it.

Every event in order, ONE wake time, a leave time (or the reason there is none)
for each event, and the problems — overlaps and places too far apart.

Before this, `get_my_day` echoed whatever the phone had synced into `location`.
On the evening of 29.9 the phone had routed nothing for the next day yet, so
Meira gave a leave time for the dentist only, said nothing about the other five
events, and missed that the Nebius meeting ends at 12:00 at Azrieli with coffee
in Herzliya at 12:15: an unrouted leg was assumed to take 15 minutes, which was
exactly the gap. The next morning the same question found a 39-minute shortfall,
only because the phone had synced its routes overnight. Same day, two answers,
and the wrong one came first.

Now the chain is walked here (`daychain`: each trip starts where the previous
one was) and any leg the phone has not routed is routed on the spot through the
injected `plan_leg`. Nothing is persisted — this is a read path, and the phone's
live plan still wins wherever it exists.

It also answers "wake up" ONCE. `get_my_day` used to pass each task's own
`wakeUpBy` through, which told her to wake at 17:27 for an 18:30 meetup.

Dependencies: clashes, daychain, day_schedule, task_shape. `plan_leg` is
injected so the tests run without Google; `agent_plan_leg` builds the real one.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Awaitable, Callable, Optional

import clashes as _clashes
import day_schedule as _ds
import daychain
import name_skeleton
import task_shape

logger = logging.getLogger(__name__)

#: (destination, arrive_by HH:MM, date, start_address or None = her default
#: start, transport or None = her usual) → the agent tool's result shape:
#: {"plan": {...}} on success, {"ok": False, "need": …, "message": …} otherwise.
PlanLeg = Callable[[str, str, str, Optional[str], Optional[str]], Awaitable[dict]]

_DONE = ("complete", "moved", "deleted", "cancelled")
_CACHE: dict = {}
_TTL_S = 20 * 60
_CONCURRENCY = 3


def _hhmm(minutes: int) -> str:
    minutes = max(0, min(int(minutes), 23 * 60 + 59))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _mins(hhmm: str) -> int:
    return _ds.time_to_minutes(hhmm)


def _brief(task: dict) -> dict:
    out = {"id": task.get("id"), "text": task.get("text"),
           "time": _clashes.start_of(task), "end": _clashes.end_of(task)}
    place = daychain.address_of(task)
    if place:
        out["place"] = place
    return out


def _stored_leg(task: dict) -> Optional[dict]:
    """The leg the phone already routed, if it did."""
    loc = task.get("location")
    if not isinstance(loc, dict):
        return None
    plan = loc.get("transitPlan") if isinstance(loc.get("transitPlan"), dict) else {}
    leave = loc.get("leaveHomeBy") or plan.get("leaveHomeAt")
    minutes = loc.get("travelMinutes") or plan.get("totalDurationMinutes")
    if not leave and not minutes:
        return None
    route = " → ".join(f"{leg.get('type')} {leg.get('lineNumber') or ''}".strip()
                       for leg in plan.get("legs") or [] if leg.get("type") != "walk")
    return {
        "leave_by": str(leave)[:5] if leave else None,
        "travel_minutes": int(minutes) if isinstance(minutes, (int, float)) and minutes > 0 else None,
        "mode": loc.get("transportType") or None,
        "route": route or None,
        # The phone's own wake time for this trip — used only if this is the
        # day's FIRST trip; every other trip's wake time is meaningless.
        "wake_by": str(loc["wakeUpBy"])[:5] if loc.get("wakeUpBy") else None,
        "source": "phone",
    }


_EXTERNAL_ID = re.compile(r"^(gcal|dcal|ocal)-")


def _external(t: dict) -> bool:
    return bool(_EXTERNAL_ID.match(str(t.get("id") or ""))) or t.get("source") in ("calendar", "email")


def _norm_title(text) -> str:
    return re.sub(r"[\W_]+", " ", str(text or "").lower()).strip()


def same_meeting(a: dict, b: dict) -> bool:
    """calendarEventTask.isSameMeeting: same day, same minute, same words — or the
    same person in two scripts ("שיחה עם סגית" / "Sagit/Koral- intro", 1.10)."""
    if str(a.get("date") or "")[:10] != str(b.get("date") or "")[:10]:
        return False
    at = str(a.get("fixed_time") or "")[:5]
    if not at or at != str(b.get("fixed_time") or "")[:5]:
        return False
    ta, tb = _norm_title(a.get("text")), _norm_title(b.get("text"))
    return bool(ta) and (ta == tb or (len(ta) >= 6 and len(tb) >= 6 and (ta in tb or tb in ta))
                         or name_skeleton.shares_a_name(a.get("text"), b.get("text")))


def collapse_same_meetings(rows: list) -> list:
    """One event per meeting (collapseSameMeetings): her own row wins and borrows
    the calendar's end time and link; the twin is named in `twin_ids`."""
    out: list = []
    for t in rows:
        i = next((k for k, x in enumerate(out) if same_meeting(x, t)), None)
        if i is None:
            out.append(t)
            continue
        mine, theirs = (t, out[i]) if _external(out[i]) and not _external(t) else (out[i], t)
        merged = dict(mine)
        if _external(theirs) and theirs.get("duration_minutes"):
            merged["duration_minutes"] = theirs["duration_minutes"]
        for k in ("meetingUrl", "attendees"):
            if not merged.get(k) and theirs.get(k):
                merged[k] = theirs[k]
        merged["twin_ids"] = list(mine.get("twin_ids") or []) + [theirs.get("id")]
        out[i] = merged
    return out


def _task_mode(task: dict) -> Optional[str]:
    """The mode this task already carries — the phone writes it with its route."""
    loc = task.get("location") if isinstance(task.get("location"), dict) else {}
    mode = loc.get("transportType") or task.get("transport")
    return str(mode) if mode in ("bus", "train", "car", "walk", "bike") else None


def unrouted(rows: list) -> list:
    """Trips the phone has not routed — the legs `plan_day` would route. Lets a
    caller skip resolving who she is at all when there is nothing to route."""
    return [r for r in rows
            if str(r.get("status") or "pending") not in _DONE and _clashes.start_of(r)
            and daychain.address_of(r) and not task_shape.is_flexible(r)
            and not _clashes.is_remote_task(r) and not _stored_leg(r)]


async def _route(plan_leg: PlanLeg, dest: str, arrive: str, date: str,
                 start: Optional[str], transport: Optional[str] = None) -> dict:
    """One leg from Google via `plan_leg`, cached briefly. A failure is a reason,
    never an empty answer — rule 1 of the silent-state rule."""
    key = (dest, arrive, date, start or "", transport or "")
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < _TTL_S:
        return hit[1]
    try:
        res = await plan_leg(dest, arrive, date, start, transport)
    except Exception as exc:  # noqa: BLE001 — one leg never sinks the day
        logger.warning("day_plan: leg to %s failed: %s", dest, exc)
        return {"reason": f"route_failed: {exc}"}
    plan = res.get("plan") if isinstance(res, dict) else None
    if isinstance(plan, dict) and (plan.get("travelMinutes") or plan.get("leaveHomeBy") or plan.get("leaveBy")):
        leave = plan.get("leaveHomeBy") or plan.get("leaveBy")
        out = {
            "leave_by": str(leave)[:5] if leave else None,
            "travel_minutes": plan.get("travelMinutes"),
            "mode": plan.get("transport") or transport,
            "source": "meira",
        }
        _CACHE[key] = (time.monotonic(), out)
        return out
    reason = (res or {}).get("need") or (res or {}).get("message") or "no route"
    logger.warning("day_plan: no route to %s: %s", dest, reason)
    return {"reason": f"route_failed: {reason}"}


#: Longest reasonable trip on her own legs / bike, minutes — the phone's ladder (≤ 35 min ride).
_OWN_LEGS = {"bike": 35, "walk": 25}


def _minutes_of(res) -> int:
    plan = (res or {}).get("plan") if isinstance(res, dict) else None
    try:
        return int((plan or {}).get("travelMinutes") or 0)
    except (TypeError, ValueError):
        return 0


def _leaves(res) -> Optional[str]:
    plan = (res or {}).get("plan") if isinstance(res, dict) else None
    return (plan or {}).get("leaveHomeBy")


def agent_plan_leg(plan_departure_tool, profile: dict) -> PlanLeg:
    """The real `plan_leg`: the agent's own plan_departure (her learned mode, her
    live position for today's first trip), and a raw geo call for probes.

    A probe — "how long by car?" — goes straight to geo on purpose: the agent
    tool REMEMBERS a transport it is handed as her choice for that place, and a
    what-if must never teach Meira that she drives to Herzliya."""
    import geo

    async def plan_leg(dest: str, arrive: str, date: str,
                       start: Optional[str], transport: Optional[str]) -> dict:
        # The phone's rule, so the two never disagree about how she goes (1.10:
        # yoga by bike 7 min on the phone, "train 15 min" from Meira — the
        # agent's mode is learned from the CONVERSATION, which a day read has
        # none of): the task's own mode, else her profile's, else the ladder.
        transport = transport or profile.get("transportType")
        if transport:
            async def leg(mode: str) -> dict:
                r = await geo.plan_departure(
                    destination=dest, arrival_hhmm=arrive,
                    home_address=profile.get("homeAddress"), transport=mode,
                    routine_minutes=profile.get("morningRoutineMinutes", 45),
                    buffer_minutes=profile.get("wakeBufferMinutes", 10),
                    start_address=start)
                if isinstance(r, dict) and isinstance(r.get("plan"), dict):
                    r["plan"]["transport"] = mode
                return r

            res = await leg(transport)
            # The phone's ladder, here too (13.10: a Haifa interview planned as
            # 147 minutes BY BIKE from Tel Aviv): a ride or a walk past what is
            # reasonable is not a plan — the train, then the bus, is.
            if transport in _OWN_LEGS and _minutes_of(res) > _OWN_LEGS[transport]:
                for mode in ("train", "bus"):
                    alt = await leg(mode)
                    if _minutes_of(alt) and _leaves(alt):
                        logger.warning("day_plan: %s %s min is not a plan — %s instead",
                                       transport, _minutes_of(res), mode)
                        return alt
            return res
        args = {"destination": dest, "arrival_time": arrive, "task_date": date}
        if start:
            args["start_address"] = start
        return await plan_departure_tool.ainvoke(args)

    return plan_leg


def _ceil_quarter(minutes: int) -> int:
    return ((minutes + 14) // 15) * 15


async def plan_day(rows: list, *, date: str, home: Optional[str],
                   plan_leg: Optional[PlanLeg] = None, routine_minutes: int = 45,
                   now: Optional[str] = None, day_start: str = "08:00",
                   day_end: str = "23:00") -> dict:
    """The day, stated. `now` (HH:MM) only for today; it hides a wake time
    that has already gone and starts the "moves to" search from now."""
    home = home or ""
    rows = collapse_same_meetings(rows)
    live = [r for r in rows if str(r.get("status") or "pending") not in _DONE]
    timed = sorted((r for r in live if _clashes.start_of(r)),
                   key=lambda r: _mins(_clashes.start_of(r)))

    # ── The chain: each trip starts where the previous one was. ──────────────
    trips = [{**r, "date": date, "status": "pending", "fixed_time": _clashes.start_of(r)}
             for r in timed
             if not task_shape.is_flexible(r) and not _clashes.is_remote_task(r)]
    chain = daychain.day_chain(trips, home, date)
    origin_of = {str(t.get("id")): origin for t, origin in chain}
    came_from = {str(t.get("id")): (chain[k - 1][0].get("text") if k else None)
                 for k, (t, _) in enumerate(chain)}

    gate = asyncio.Semaphore(_CONCURRENCY)

    def left_behind(k: int) -> Optional[str]:
        """'bus' when her bike / car stayed somewhere else: the previous trip of
        the chain went by bus, train or on foot (13.10: '5 min by bike' from a
        Haifa interview she reached by train). Her own choice on a task wins."""
        if k == 0 or _task_mode(chain[k][0]):
            return None
        prev = _task_mode(chain[k - 1][0])
        return "bus" if prev in ("bus", "train", "walk") else None

    async def leg_for(task: dict, origin: str, k: int = 0) -> dict:
        stored = _stored_leg(task)
        # The phone's live plan wins — unless it was computed from a place the
        # day no longer starts this trip from.
        if stored and daychain.recorded_origin(task) in (None, origin):
            return stored
        if plan_leg is None:
            return stored or {"reason": "not_routed"}
        async with gate:
            fresh = await _route(plan_leg, daychain.address_of(task), task["fixed_time"], date,
                                 None if (not home or origin == home) else origin,
                                 _task_mode(task) or left_behind(k))
        return fresh if ("reason" not in fresh or not stored) else stored

    results = await asyncio.gather(*(leg_for(t, o, k) for k, (t, o) in enumerate(chain)))
    legs = {str(t.get("id")): leg for (t, _), leg in zip(chain, results)}

    # ── Events ────────────────────────────────────────────────────────────────
    events = []
    for r in timed:
        rid = str(r.get("id"))
        ev = {"id": r.get("id"), "text": r.get("text"),
              "time": _clashes.start_of(r), "end": _clashes.end_of(r),
              "minutes": _ds.duration_of(r), "category": r.get("category"),
              "priority": r.get("priority"), "status": r.get("status") or "pending"}
        loc = r.get("location")
        place = daychain.address_of(r)
        if place:
            ev["place"] = (loc.get("displayName") if isinstance(loc, dict) else None) or place
        if task_shape.is_flexible(r):
            ev["flexible"] = True        # her own work: no hour holds it, no journey
        elif _clashes.is_remote_task(r):
            ev["no_leave_reason"] = "online"
        elif not place:
            ev["no_leave_reason"] = "no_place"
        else:
            leg = legs.get(rid) or {}
            if leg.get("leave_by") or leg.get("travel_minutes"):
                ev.update({k: leg[k] for k in ("leave_by", "travel_minutes", "mode", "route", "source")
                           if leg.get(k)})
                ev["from"] = "home" if origin_of.get(rid) == home and home else (came_from.get(rid) or "here")
            else:
                ev["no_leave_reason"] = leg.get("reason") or "not_routed"
        events.append(ev)

    # ── One wake time: the first trip, less the morning. ─────────────────────
    wake_by = None
    wake_reason = None
    if chain:
        first_leg = legs.get(str(chain[0][0].get("id"))) or {}
        if first_leg.get("wake_by") or first_leg.get("leave_by"):
            # The phone's wake time wins — it knows her learned morning.
            wake = (_mins(first_leg["wake_by"]) if first_leg.get("wake_by")
                    else _mins(first_leg["leave_by"]) - int(routine_minutes or 45))
            if now is None or wake > _mins(now):
                wake_by = _hhmm(wake)
        else:
            wake_reason = first_leg.get("reason") or "not_routed"
    # …or the first thing with an hour, less the morning: a task at home at
    # 08:40 needs her up as surely as a train does (3.10, "I added a task for
    # tomorrow at 8:40 — why no alarm?"). Same rule as the phone's
    # utils/alarmPlan.plannedAlarmTime.
    if timed:
        first = _mins(_clashes.start_of(timed[0])) - int(routine_minutes or 45)
        if first >= 0 and (wake_by is None or first < _mins(wake_by)) and (now is None or first > _mins(now)):
            wake_by, wake_reason = _hhmm(first), None

    # ── Problems, judged with the real legs. ─────────────────────────────────
    minutes_to = {rid: leg["travel_minutes"] for rid, leg in legs.items() if leg.get("travel_minutes")}

    def leg_lookup(first: dict, second: dict) -> Optional[int]:
        sid = str(second.get("id"))
        if origin_of.get(sid) and origin_of[sid] == daychain.address_of(first):
            return minutes_to.get(sid)
        return None

    found = _clashes.resolve_clashes(live, day_end=day_end, leg_lookup=leg_lookup, now=now)
    problems = []
    for c in found:
        if c.get("kind") == "parallel":
            continue
        a, b = c["a"], c["b"]
        first, second = (a, b) if _mins(_clashes.start_of(a)) <= _mins(_clashes.start_of(b)) else (b, a)
        p = {"kind": c["kind"], "first": _brief(first), "second": _brief(second),
             "overlap_minutes": c["overlapMinutes"],
             "travel_shortfall_minutes": c["travelShortfall"],
             "question_en": c["questionEn"], "question_he": c["questionHe"],
             "options": [{k: o.get(k) for k in ("kind", "taskId", "newTime", "labelEn", "labelHe")}
                         for o in c["options"]]}
        if c["kind"] == "travel":
            travel = _clashes.travel_minutes_between(first, second, leg_lookup)
            arrive = _mins(_clashes.end_of(first)) + travel
            p.update({"travel_minutes": travel, "arrive_at": _hhmm(arrive),
                      "late_by": max(0, arrive - _mins(_clashes.start_of(second))),
                      "ask_for": _hhmm(_ceil_quarter(arrive))})
            leg = legs.get(str(second.get("id"))) or {}
            if plan_leg is not None and leg.get("mode") != "car":
                car = await _route(plan_leg, daychain.address_of(second) or "", _clashes.start_of(second),
                                   date, daychain.address_of(first), transport="car")
                car_minutes = car.get("travel_minutes")
                if isinstance(car_minutes, (int, float)) and 0 < car_minutes < travel:
                    by_car = _mins(_clashes.end_of(first)) + int(car_minutes)
                    p["faster"] = {"mode": "car", "travel_minutes": int(car_minutes),
                                   "arrive_at": _hhmm(by_car),
                                   "late_by": max(0, by_car - _mins(_clashes.start_of(second)))}
        elif c["kind"] == "overlap":
            work, fixed = (a, b) if task_shape.is_flexible(a) or not daychain.address_of(a) else (b, a)
            p["work"] = _brief(work)
            p["fixed"] = _brief(fixed)
            p["moves_to"] = _slot_for(work, timed, legs, not_before=now or day_start,
                                      day_end=day_end) or "tomorrow"
        problems.append(p)

    return {"date": date, "wake_by": wake_by, "wake_reason": wake_reason,
            "events": events, "problems": problems}


def _slot_for(work: dict, timed: list, legs: dict, *, not_before: str, day_end: str) -> Optional[str]:
    """The first free window that fits the whole block, counting each trip from
    the minute she has to LEAVE — an hour that is really ten minutes because the
    bike leaves at 15:03 must not be offered as an hour."""
    busy = []
    for r in timed:
        if r is work or r.get("id") == work.get("id") or task_shape.is_flexible(r):
            continue
        leave = (legs.get(str(r.get("id"))) or {}).get("leave_by")
        start = leave or _clashes.start_of(r)
        end = _clashes.end_of(r)
        busy.append({"id": r.get("id"), "fixed_time": start,
                     "duration_minutes": max(1, _mins(end) - _mins(start))})
    return _clashes.first_free_slot(busy, _ds.duration_of(work), not_before, day_end)
