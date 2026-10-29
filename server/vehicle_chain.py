"""Her bike (or car) is somewhere else, and she has to be somewhere: the ways to do it.

Koral, 19.10: "My bike is on Florentin and I need to be at the Baot meetup —
what do I do?" Meira asked where the meetup was (it was on her calendar) and
had nothing to offer: the ranker answers ONE trip, A to B, and this is a chain.

Three chains, timed BACKWARDS from the event's start, each leg a real Google
route (geo.directions_detailed), never an estimate pretending to be one:

  fetch_first   here → (walk | bus) → the bike → ride → the event; ride home after
  fetch_after   here → (walk | bus) → the event; after it → (walk | bus) → the
                bike → ride home
  leave_it      here → (walk | bus) → the event → (walk | bus) home; the bike
                stays where it is

Ranked: on time first, then the whole evening's minutes (there and back), then
the chain that ends with the bike at home. Up to three are said, best first.

A leg that cannot be routed is not dropped in silence (silent-state rule 1):
the chain carries `failed` with which leg and why, and is ranked last.
Read-only: nothing is saved, no reminder is set.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

Route = Callable[[dict, dict, str, Optional[str]], Awaitable[tuple]]

_UNLOCK_MIN = 2           # take the lock off / find the bike
_LOCK_MIN = 2             # lock it at the other end
_BUFFER_MIN = 5           # arrive a little before it starts
_WALK_PREFERRED_MAX = 15  # a walk this short beats waiting for a bus
_DEFAULT_EVENT_MIN = 60
_BIKE_HOME_BONUS = 15     # minutes a chain may cost more and still win for ending with the bike at home


def _min(hhmm: Optional[str]) -> Optional[int]:
    try:
        h, m = str(hhmm)[:5].split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def _hhmm(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _line(r: dict, a: dict, b: dict) -> dict:
    """What the app's map draws for a leg: Google's encoded line and both ends."""
    out = {"from_pt": {"lat": a.get("lat"), "lng": a.get("lng")},
           "to_pt": {"lat": b.get("lat"), "lng": b.get("lng")}}
    if r.get("overviewPolyline"):
        out["polyline"] = r["overviewPolyline"]
    return out


async def _get_there(route: Route, a: dict, b: dict, arrive_by: Optional[int],
                     timed: bool = True) -> dict:
    """Walk or bus from a to b, whichever is better: a short walk always wins;
    otherwise the bus when it is faster door to door. -> {mode, minutes, leave_at?,
    line?, board_at?, from_stop?} or {failed: reason}."""
    arrive = _hhmm(arrive_by) if arrive_by is not None else None
    (walk, walk_why), (bus, bus_why) = await asyncio.gather(
        route(a, b, "walk", None), route(a, b, "bus", arrive))
    options = []
    if walk:
        options.append({"mode": "walk", "minutes": int(walk["minutes"]),
                        **_line(walk, a, b)})
    if bus:
        leg = {"mode": "bus", "minutes": int(bus["minutes"]), **_line(bus, a, b)}
        t = bus.get("transit") or {}
        if t.get("line"):
            leg["line"] = t["line"]
            leg["vehicle"] = t.get("vehicle")
            leg["from_stop"] = t.get("departStop")
            leg["board_at"] = t.get("departTime")
        if bus.get("departAt"):
            leg["leave_at"] = bus["departAt"]
        if bus.get("arriveAtReal"):
            leg["arrive_at"] = bus["arriveAtReal"]
        options.append(leg)
    if not options:
        return {"failed": walk_why or bus_why or "no_route"}
    if not timed:
        # A leg after the event: Google can only time it from NOW, so a
        # "44 at 15:31" for a ride home at 21:00 was a time that never exists
        # (live, 19.10). The line and the minutes hold; the clock does not.
        for o in options:
            for k in ("leave_at", "board_at", "arrive_at"):
                o.pop(k, None)
    walk_opt = next((o for o in options if o["mode"] == "walk"), None)
    if walk_opt and walk_opt["minutes"] <= _WALK_PREFERRED_MAX:
        return walk_opt
    return min(options, key=lambda o: o["minutes"])


async def _ride(route: Route, a: dict, b: dict, vehicle: str) -> dict:
    r, why = await route(a, b, vehicle, None)
    if not r:
        return {"failed": why or "no_route"}
    return {"mode": vehicle, "minutes": int(r["minutes"]), **_line(r, a, b)}


def _leave_for(leg: dict, arrive_by: int) -> int:
    """When to leave for a leg that must arrive by `arrive_by` (minutes)."""
    if leg.get("leave_at") and _min(leg["leave_at"]) is not None:
        return _min(leg["leave_at"])
    return arrive_by - int(leg["minutes"])


async def plan(*, route: Route, here: dict, vehicle_at: dict, event: dict, home: Optional[dict],
               start: str, end: Optional[str] = None, now: Optional[str] = None,
               vehicle: str = "bike", event_name: str = "") -> dict:
    """-> {ok, start, end, options: [...best first], now} or {ok: False, reason}.

    here / vehicle_at / event / home: {lat, lng, name?}. start/end/now: HH:MM.
    Each option: {kind, leave_at, arrive_at, on_time, total_min, steps: [...],
    vehicle_home: bool, failed?: {leg, reason}}."""
    s = _min(start)
    if s is None:
        return {"ok": False, "reason": "no_start_time"}
    e = _min(end) if end else None
    if e is None or e <= s:
        e = s + _DEFAULT_EVENT_MIN
    now_m = _min(now)
    target = s - _BUFFER_MIN

    async def fetch_first() -> dict:
        ride = await _ride(route, vehicle_at, event, vehicle)
        if ride.get("failed"):
            return {"kind": "fetch_first", "failed": {"leg": "vehicle_to_event", "reason": ride["failed"]}}
        at_vehicle_by = target - _LOCK_MIN - ride["minutes"] - _UNLOCK_MIN
        to_vehicle, back = await asyncio.gather(
            _get_there(route, here, vehicle_at, at_vehicle_by),
            _ride(route, event, home, vehicle) if home else asyncio.sleep(0, result={"failed": "no_home"}))
        if to_vehicle.get("failed"):
            return {"kind": "fetch_first", "failed": {"leg": "here_to_vehicle", "reason": to_vehicle["failed"]}}
        leave = _leave_for(to_vehicle, at_vehicle_by)
        steps = [{"from": "here", "to": "vehicle", **to_vehicle},
                 {"from": "vehicle", "to": "event", **ride}]
        after = 0
        if not back.get("failed"):
            steps.append({"from": "event", "to": "home", "after": True, **back})
            after = back["minutes"] + _UNLOCK_MIN
        before = (at_vehicle_by - leave) + _UNLOCK_MIN + ride["minutes"] + _LOCK_MIN
        return {"kind": "fetch_first", "leave_at": _hhmm(leave), "arrive_at": _hhmm(target),
                "total_min": before + after, "vehicle_home": not back.get("failed"), "steps": steps}

    async def fetch_after() -> dict:
        there, back_to_vehicle, ride_home = await asyncio.gather(
            _get_there(route, here, event, target),
            _get_there(route, event, vehicle_at, None, timed=False),
            _ride(route, vehicle_at, home, vehicle) if home else asyncio.sleep(0, result={"failed": "no_home"}))
        if there.get("failed"):
            return {"kind": "fetch_after", "failed": {"leg": "here_to_event", "reason": there["failed"]}}
        if back_to_vehicle.get("failed"):
            return {"kind": "fetch_after", "failed": {"leg": "event_to_vehicle", "reason": back_to_vehicle["failed"]}}
        leave = _leave_for(there, target)
        steps = [{"from": "here", "to": "event", **there},
                 {"from": "event", "to": "vehicle", "after": True, **back_to_vehicle}]
        after = back_to_vehicle["minutes"]
        if not ride_home.get("failed"):
            steps.append({"from": "vehicle", "to": "home", "after": True, **ride_home})
            after += _UNLOCK_MIN + ride_home["minutes"]
        return {"kind": "fetch_after", "leave_at": _hhmm(leave), "arrive_at": _hhmm(target),
                "total_min": (target - leave) + after, "vehicle_home": not ride_home.get("failed"),
                "steps": steps}

    async def leave_it() -> dict:
        there, home_leg = await asyncio.gather(
            _get_there(route, here, event, target),
            _get_there(route, event, home, None, timed=False) if home else asyncio.sleep(0, result={"failed": "no_home"}))
        if there.get("failed"):
            return {"kind": "leave_it", "failed": {"leg": "here_to_event", "reason": there["failed"]}}
        leave = _leave_for(there, target)
        steps = [{"from": "here", "to": "event", **there}]
        after = 0
        if not home_leg.get("failed"):
            steps.append({"from": "event", "to": "home", "after": True, **home_leg})
            after = home_leg["minutes"]
        return {"kind": "leave_it", "leave_at": _hhmm(leave), "arrive_at": _hhmm(target),
                "total_min": (target - leave) + after, "vehicle_home": False, "steps": steps}

    options = list(await asyncio.gather(fetch_first(), fetch_after(), leave_it()))
    for o in options:
        if o.get("failed"):
            o["on_time"] = None
            continue
        o["on_time"] = now_m is None or _min(o["leave_at"]) >= now_m
        if not o["on_time"]:
            late = now_m - _min(o["leave_at"])
            o["late_by"] = late
            o["arrive_at"] = _hhmm(_min(o["arrive_at"]) + late)

    def score(o: dict) -> tuple:
        if o.get("failed"):
            return (2, 0)
        cost = o["total_min"] - (_BIKE_HOME_BONUS if o["vehicle_home"] else 0)
        return (0 if o["on_time"] else 1, cost + o.get("late_by", 0) * 3)

    options.sort(key=score)
    if all(o.get("failed") for o in options):
        reasons = {o["failed"]["reason"] for o in options}
        reason = "directions_refused" if reasons & {"refused", "not_configured"} else "no_route"
        return {"ok": False, "reason": reason, "options": options}
    return {"ok": True, "kind": "vehicle_chain", "vehicle": vehicle, "start": _hhmm(s),
            "end": _hhmm(e), "now": now, "options": options[:3],
            # The map card names the event; without it a leg read "→ the event" (19.10).
            **({"event": event_name} if event_name else {})}


_MAX_EVENTS = 3            # the next few located events are the branches worth routing
_STANDALONE_MARGIN = 30    # a trip on its own must be home this long before the next event


async def plan_pickup(*, route: Route, here: dict, vehicle_at: dict, home: Optional[dict],
                      events: list, now: str, vehicle: str = "bike") -> dict:
    """"I need to pick up my bike from Florentin — plan it" (Koral, 19.10): no event
    named, so every way it fits into the day is a branch, searched and ranked.

    Branches: on the way TO each of the next located events (fetch_first), on
    the way back FROM each (fetch_after), or a trip of its own now. A branch is
    priced by what it ADDS to the day: the event's plain trip there and back
    (leave_it) is what she would travel anyway, so "+12 min" is the real cost,
    and a trip of its own costs all of its minutes. Branches that miss an
    event's start or run into the next one are ranked after those that fit.

    events: [{name, place: {lat, lng}, start: HH:MM, end?: HH:MM}] today, any order.
    -> {ok, kind: 'vehicle_pickup', options: [...best first, up to 3]} or {ok: False, reason}."""
    now_m = _min(now) or 0
    upcoming = sorted((e for e in events if e.get("place") and (_min(e.get("start")) or -1) > now_m),
                      key=lambda e: _min(e["start"]))[:_MAX_EVENTS]

    async def via(ev: dict) -> list:
        r = await plan(route=route, here=here, vehicle_at=vehicle_at, event=ev["place"], home=home,
                       start=ev["start"], end=ev.get("end"), now=now, vehicle=vehicle)
        opts = r.get("options") or []
        base = next((o for o in opts if o["kind"] == "leave_it" and not o.get("failed")), None)
        out = []
        for o in opts:
            if o["kind"] == "leave_it" or o.get("failed"):
                continue
            extra = o["total_min"] - base["total_min"] if base else o["total_min"]
            out.append({**o, "event": ev.get("name") or "", "event_start": ev["start"],
                        "extra_min": max(0, extra), "fits": bool(o["on_time"])})
        return out

    async def on_its_own() -> list:
        if not home:
            return []
        to_vehicle, ride = await asyncio.gather(_get_there(route, here, vehicle_at, None),
                                                _ride(route, vehicle_at, home, vehicle))
        if to_vehicle.get("failed") or ride.get("failed"):
            leg = "here_to_vehicle" if to_vehicle.get("failed") else "vehicle_to_home"
            return [{"kind": "on_its_own", "failed": {"leg": leg, "reason": (to_vehicle.get("failed")
                                                                            or ride.get("failed"))}}]
        leave = _min(to_vehicle.get("leave_at")) or now_m
        total = (leave - now_m) + to_vehicle["minutes"] + _UNLOCK_MIN + ride["minutes"]
        home_at = now_m + total
        nxt = _min(upcoming[0]["start"]) if upcoming else None
        return [{"kind": "on_its_own", "leave_at": _hhmm(leave), "arrive_at": _hhmm(home_at),
                 "total_min": total, "extra_min": total, "vehicle_home": True, "on_time": True,
                 "fits": nxt is None or home_at <= nxt - _STANDALONE_MARGIN,
                 "steps": [{"from": "here", "to": "vehicle", **to_vehicle},
                           {"from": "vehicle", "to": "home", **ride}]}]

    branches = await asyncio.gather(*(via(e) for e in upcoming), on_its_own())
    options = [o for b in branches for o in b]
    ok = [o for o in options if not o.get("failed")]
    if not ok:
        reasons = {o["failed"]["reason"] for o in options if o.get("failed")}
        reason = "directions_refused" if reasons & {"refused", "not_configured"} else "no_route"
        return {"ok": False, "reason": reason, "options": options}
    ok.sort(key=lambda o: (0 if o["fits"] else 1, o["extra_min"], o["leave_at"]))
    return {"ok": True, "kind": "vehicle_pickup", "vehicle": vehicle, "now": now, "options": ok[:3]}


def say_pickup(result: dict, he: bool) -> str:
    """"The best way to fetch the bike today", up to three, best first."""
    v_en, v_he = _VEHICLE.get(result.get("vehicle") or "bike", ("bike", "אופניים"))
    v = v_he if he else v_en
    lines = [f"הדרכים לאסוף את ה{v} היום, מהטובה:" if he else f"Ways to fetch the {v} today, best first:"]
    for i, o in enumerate(result["options"], 1):
        ev = o.get("event") or ""
        if o["kind"] == "fetch_first":
            title = (f"בדרך ל{ev} ({o['event_start']})" if he else f"on the way to {ev} ({o['event_start']})")
        elif o["kind"] == "fetch_after":
            title = (f"אחרי {ev}, בדרך הביתה" if he else f"after {ev}, on the way home")
        else:
            title = "נסיעה נפרדת, עכשיו" if he else "a trip of its own, now"
        cost = (f"+{o['extra_min']} דק׳ ליום" if he else f"+{o['extra_min']} min to your day")
        warn = "" if o["fits"] else (" — לא נכנס בלו״ז" if he else " — doesn't fit your day")
        lines.append(f"{i}. {title}: {'לצאת' if he else 'leave'} {o['leave_at']} · {cost}{warn}")
        lines.append("   " + " · ".join(_step(s, he, v, ev or ("האירוע" if he else "the event"))
                                       for s in o["steps"]))
    return "\n".join(lines)


# ── the words ────────────────────────────────────────────────────────────────

_WORD = {
    "walk": ("🚶", "walk", "ברגל"), "bus": ("🚌", "bus", "אוטובוס"),
    "bike": ("🚴", "bike", "אופניים"), "car": ("🚗", "car", "אוטו"),
}
_PLACE = {"here": ("here", "מכאן"), "vehicle": ("the {v}", "ה{v}"), "event": ("{e}", "{e}"),
          "home": ("home", "הביתה")}
_VEHICLE = {"bike": ("bike", "אופניים"), "car": ("car", "אוטו")}
_TITLE = {
    "fetch_first": ("Get the {v} first", "קודם לאסוף את ה{v}"),
    "fetch_after": ("Go now, get the {v} after", "לנסוע עכשיו, לאסוף את ה{v} אחרי"),
    "leave_it": ("Leave the {v} where it is", "להשאיר את ה{v} שם"),
}


def _step(st: dict, he: bool, v: str, event_name: str) -> str:
    icon, en, hw = _WORD.get(st["mode"], ("🧭", st["mode"], st["mode"]))
    if st["to"] == "stop":
        to = str(st.get("stop") or "")
    else:
        to_en, to_he = _PLACE.get(st["to"], (st["to"], st["to"]))
        to = (to_he if he else to_en).format(v=v, e=event_name)
    mins = f"{st['minutes']} דק׳" if he else f"{st['minutes']} min"
    if st["mode"] == "bus" and st.get("line"):
        when = f" ב-{st['board_at']}" if he and st.get("board_at") else (f" at {st['board_at']}" if st.get("board_at") else "")
        return f"{icon} {st['line']}{when} → {to} ({mins})" if not he else f"{icon} {st['line']}{when} ← {to} ({mins})"
    word = hw if he else en
    return f"{icon} {word} → {to} ({mins})" if not he else f"{icon} {word} ← {to} ({mins})"


def say(result: dict, he: bool, event_name: str = "") -> str:
    """Up to three ways, best first, each: leave time, the legs, what is left after."""
    v_en, v_he = _VEHICLE.get(result.get("vehicle") or "bike", ("bike", "אופניים"))
    v = v_he if he else v_en
    name = event_name or ("האירוע" if he else "the event")
    head = (f"{name} ב-{result['start']}. הדרכים, מהטובה:" if he
            else f"{name} at {result['start']}. The ways, best first:")
    lines = [head]
    for i, o in enumerate(result["options"], 1):
        title = _TITLE[o["kind"]][1 if he else 0].format(v=v)
        if o.get("failed"):
            why = o["failed"]["reason"]
            lines.append(f"{i}. {title} — " + (f"לא הצלחתי לחשב ({why})" if he else f"couldn't work it out ({why})"))
            continue
        when = (f"לצאת {o['leave_at']}, להגיע {o['arrive_at']}" if he
                else f"leave {o['leave_at']}, arrive {o['arrive_at']}")
        if not o["on_time"]:
            when += f" — {o['late_by']} דק׳ איחור" if he else f" — {o['late_by']} min late"
        before = [s for s in o["steps"] if not s.get("after")]
        after = [s for s in o["steps"] if s.get("after")]
        legs = " · ".join(_step(s, he, v, name) for s in before)
        lines.append(f"{i}. {title}: {when}\n   {legs}")
        if after:
            lines.append("   " + ("אחרי: " if he else "after: ") + " · ".join(_step(s, he, v, name) for s in after))
        if o["kind"] == "leave_it":
            stays = "נשארים" if result.get("vehicle", "bike") == "bike" else "נשאר"
            lines.append("   " + (f"ה{v} {stays} שם לאיסוף אחר כך" if he else f"the {v} stays there for later"))
    return "\n".join(lines)


# ── the whole evening: fixed events, a wish that may clash, and the bike ─────
#
# Koral, 19.10: "and I also want to train at 20 — what then?" Baot runs
# 18:00-21:00, so the wish clashes; the answer is either leave Baot early or
# train after it, and in each case the bike can be picked up at any point —
# before Baot, between, after the gym, or not today. Every combination is a
# path through the evening; each is walked forward leg by leg (DFS over the
# stops, the vehicle's position as state) and ranked.

_LEAVE_EARLY_WEIGHT = 0.5   # a minute of the event given up costs half a travel minute
_DEFAULT_WISH_MIN = 60


def _memo(route: Route) -> Route:
    """One Google call per (from, to, mode, arrive) in a search that asks many times."""
    seen: dict = {}

    async def cached(a: dict, b: dict, mode: str, arrive: Optional[str]):
        key = (round(a["lat"], 5), round(a["lng"], 5), round(b["lat"], 5), round(b["lng"], 5), mode, arrive)
        if key not in seen:
            seen[key] = await route(a, b, mode, arrive)
        return seen[key]
    return cached


async def _walk_path(route: Route, here: dict, vehicle_at: dict, home: dict, stops: list,
                     pickup: Optional[int], now_m: int, vehicle: str) -> dict:
    """Walk one path: stops in order, the vehicle fetched before stop `pickup`
    (len(stops) = on the way home, None = not today). -> the path or {failed}."""
    at, t, have = here, now_m, False
    steps, travel, starts = [], 0, []
    targets = stops + [{"name": "home", "place": home, "start": None, "end": None, "home": True}]
    for i, stop in enumerate(targets):
        pickup_leave = None
        if pickup == i and not have:
            arrive_vehicle = None
            if i == 0 and stop.get("start"):
                # Fetched before the FIRST stop: time the trip to the bike
                # back from that stop's start. From NOW it said "leave 17:12"
                # beside "bus 54 at 16:20" (live, 19.10).
                ride0 = await _ride(route, vehicle_at, stop["place"], vehicle)
                if not ride0.get("failed"):
                    arrive_vehicle = (_min(stop["start"]) - _BUFFER_MIN - _LOCK_MIN
                                      - ride0["minutes"] - _UNLOCK_MIN)
            leg = await _get_there(route, at, vehicle_at, arrive_vehicle,
                                   timed=(i == 0 and arrive_vehicle is not None))
            if arrive_vehicle is not None and not leg.get("failed"):
                pickup_leave = _leave_for(leg, arrive_vehicle)
            if leg.get("failed"):
                return {"failed": {"leg": f"to_{vehicle}", "reason": leg["failed"]}}
            steps.append({"from": "prev", "to": "vehicle", **leg})
            t += leg["minutes"] + _UNLOCK_MIN
            travel += leg["minutes"] + _UNLOCK_MIN
            at, have = vehicle_at, True
        if have:
            leg = await _ride(route, at, stop["place"], vehicle)
            extra = _LOCK_MIN if not stop.get("home") else 0
        else:
            arrive = _min(stop["start"]) - _BUFFER_MIN if stop.get("start") else None
            leg = await _get_there(route, at, stop["place"], arrive, timed=(i == 0 and pickup != 0))
            extra = 0
        if leg.get("failed"):
            return {"failed": {"leg": f"to_{stop['name']}", "reason": leg["failed"]}}
        steps.append({"from": "prev", "to": "home" if stop.get("home") else "stop",
                      "stop": stop["name"], **leg})
        if i == 0:
            if pickup_leave is not None:
                first_leave = pickup_leave
            elif stop.get("start"):
                first_leave = _leave_for(leg, _min(stop["start"]) - _BUFFER_MIN - extra) \
                    if pickup != 0 else (_min(stop["start"]) - _BUFFER_MIN - leg["minutes"] - extra
                                         - _UNLOCK_MIN - steps[0]["minutes"])
            else:
                first_leave = t
        t_arrive = t + leg["minutes"] + extra
        travel += leg["minutes"] + extra
        if stop.get("start"):
            s = _min(stop["start"])
            if i > 0 and t_arrive > s:
                return {"failed": {"leg": f"to_{stop['name']}", "reason": "too_late",
                                   "late_by": t_arrive - s}}
            t = _min(stop["end"]) if stop.get("end") else s + _DEFAULT_WISH_MIN
            starts.append(stop["start"])
        else:
            t = t_arrive
        at = stop["place"]
    return {"leave_at": _hhmm(first_leave), "home_at": _hhmm(t), "travel_min": travel,
            "vehicle_home": have, "steps": steps}


async def plan_evening(*, route: Route, here: dict, vehicle_at: dict, home: dict,
                       events: list, wish: dict, now: str, vehicle: str = "bike") -> dict:
    """events: the fixed ones [{name, place, start, end}]; wish: {name, place, start, minutes?}.

    -> {ok, clash: {with, start, end}|None, options: [...best first, up to 3]}.
    Each option: {kind: 'leave_early'|'after'|'as_is', pickup: 'before:<stop>'|'home'|None,
    leave_at, home_at, travel_min, gave_up_min, vehicle_home, steps, wish_at, leave_event_at?}."""
    route = _memo(route)
    now_m = _min(now) or 0
    w_start = _min(wish.get("start"))
    w_len = int(wish.get("minutes") or _DEFAULT_WISH_MIN)
    fixed = sorted((e for e in events if e.get("place") and _min(e.get("start")) is not None),
                   key=lambda e: _min(e["start"]))
    clash = next((e for e in fixed if w_start is not None
                  and _min(e["start"]) <= w_start < (_min(e.get("end")) or _min(e["start"]) + 60)), None)

    variants = []
    if clash and w_start is not None:
        # 1. Leave the event early: it ends when she must leave for the wish.
        to_wish, _ = await route(clash["place"], wish["place"], vehicle, None)
        ride_min = int(to_wish["minutes"]) if to_wish else 15
        leave_m = w_start - ride_min - _BUFFER_MIN - _UNLOCK_MIN
        cut = {**clash, "end": _hhmm(leave_m)}
        gave = (_min(clash["end"]) or leave_m) - leave_m
        variants.append(("leave_early", [cut if e is clash else e for e in fixed],
                         {**wish, "start": wish["start"], "end": _hhmm(w_start + w_len)}, gave,
                         _hhmm(leave_m)))
        # 2. The wish after the event.
        after_m = _min(clash["end"]) + ride_min + _BUFFER_MIN
        variants.append(("after", fixed, {**wish, "start": _hhmm(after_m), "end": _hhmm(after_m + w_len)},
                         0, None))
    elif w_start is not None:
        variants.append(("as_is", fixed, {**wish, "end": _hhmm(w_start + w_len)}, 0, None))
    else:
        return {"ok": False, "reason": "no_wish_time"}

    paths = []
    for kind, evs, w, gave, leave_event in variants:
        stops = sorted([e for e in evs if (_min(e["start"]) or 0) > now_m or e is clash] + [w],
                       key=lambda e: _min(e["start"]))
        for pickup in [*range(len(stops) + 1), None]:
            p = await _walk_path(route, here, vehicle_at, home, stops, pickup, now_m, vehicle)
            if p.get("failed"):
                continue
            where = None if pickup is None else ("home" if pickup == len(stops) else f"before:{stops[pickup]['name']}")
            paths.append({**p, "kind": kind, "pickup": where, "gave_up_min": gave,
                          "wish_at": w["start"], "leave_event_at": leave_event})
    if not paths:
        return {"ok": False, "reason": "no_route", "clash": _clash_of(clash)}

    def cost(p: dict) -> float:
        return p["travel_min"] + _LEAVE_EARLY_WEIGHT * p["gave_up_min"] - (_BIKE_HOME_BONUS if p["vehicle_home"] else 0)

    paths.sort(key=cost)
    best, seen = [], set()
    for p in paths:   # three DIFFERENT answers, not one plan three ways
        key = (p["kind"], p["pickup"] is None)
        if key in seen:
            continue
        seen.add(key)
        best.append(p)
        if len(best) == 3:
            break
    place = wish.get("place") or {}
    return {"ok": True, "kind": "vehicle_evening", "vehicle": vehicle, "clash": _clash_of(clash),
            "wish": wish.get("name"), "wish_place": place.get("formatted") or place.get("name"),
            "options": best}


def _clash_of(e: Optional[dict]) -> Optional[dict]:
    return {"with": e["name"], "start": e["start"], "end": e.get("end")} if e else None


def say_evening(result: dict, he: bool) -> str:
    v_en, v_he = _VEHICLE.get(result.get("vehicle") or "bike", ("bike", "אופניים"))
    v = v_he if he else v_en
    wish = result.get("wish") or ("האימון" if he else "the workout")
    c = result.get("clash")
    lines = []
    if c:
        lines.append(f"⚠️ {wish} נופל בתוך {c['with']} ({c['start']}–{c['end']})." if he
                     else f"⚠️ {wish} falls inside {c['with']} ({c['start']}–{c['end']}).")
    if result.get("wish_place"):
        # Which gym she is routed to — never a place picked in silence.
        lines.append(f"📍 {wish}: {result['wish_place']}")
    lines.append("הדרכים, מהטובה:" if he else "The ways, best first:")
    for i, o in enumerate(result["options"], 1):
        if o["kind"] == "leave_early":
            head = (f"לצאת מ{c['with']} ב-{o['leave_event_at']} ל{wish} ב-{o['wish_at']}" if he
                    else f"leave {c['with']} at {o['leave_event_at']} for {wish} at {o['wish_at']}")
        elif o["kind"] == "after":
            head = f"{wish} אחרי, ב-{o['wish_at']}" if he else f"{wish} after, at {o['wish_at']}"
        else:
            head = f"{wish} ב-{o['wish_at']}" if he else f"{wish} at {o['wish_at']}"
        pick = o["pickup"]
        if pick is None:
            bike = f"ה{v} נשארים לאיסוף אחר כך" if he else f"the {v} stays for later"
        elif pick == "home":
            bike = f"אוספת את ה{v} בדרך הביתה" if he else f"fetch the {v} on the way home"
        else:
            stop = pick.split(":", 1)[1]
            bike = f"אוספת את ה{v} לפני {stop}" if he else f"fetch the {v} before {stop}"
        lines.append(f"{i}. {head} · {bike} · {'יציאה' if he else 'leave'} {o['leave_at']}, "
                     + (f"בבית {o['home_at']} · {o['travel_min']} דק׳ בדרכים" if he
                        else f"home {o['home_at']} · {o['travel_min']} min travelling"))
        lines.append("   " + " · ".join(_step(st, he, v, "") for st in o["steps"]))
    return "\n".join(lines)
