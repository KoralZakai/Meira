"""place_ranker — "the closest X", "car, bike or bus?", "how do I get home from here?".

Koral, 7.10: she asked the mic for "the fastest beach to reach by car from
home" and Meira answered "which beach?", then "where do you live?". Then she
listed what a secretary is for: "where is the closest post office to me",
"which Clalit clinic is closest", "is it faster to the sea by car, bike or
bus?", "how do I get back home from here?". Each is a question whose answer
can be LOOKED UP, and every one of them was answered with a question.

The class of failure: choosing for her was treated as a missing detail. This
module is the part that chooses, and it is arithmetic and lookups, not the
model's job:

    candidates   Places Text Search biased to where she starts (geo.places_near)
    each mode    a real Google route per candidate per mode (geo.directions_detailed)
    door to door car   = drive + finding a space + walking from the lot
                 bus/train = waiting for it + the ride (Google's walks included)
                 bike  = ride + locking it
                 walk  = the walk
    rank         by that total; opening hours when she wants to go now

Parking is an ESTIMATE and says so: the nearest car park to the place (a
Places search) gives the walk, and the time to find a space is a fixed
allowance — short when a car park is close, longer when there is none.

Every failure has its own reason (silent-state rule 1): no origin, Places
refused the key, nothing found, Directions refused, no route. Never a bare [].

Read-only: no task, no reminder. Consumed by lumi_agent (find_best_place,
route_now).
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

import httpx

import config
import errands_along
import geo
import tz as _tz

logger = logging.getLogger(__name__)

MODES = ("car", "bike", "bus", "train", "walk", "taxi")

_SEARCH_RADIUS_M = 40_000
_CANDIDATES_ONE_MODE = 5
_CANDIDATES_MANY_MODES = 3
_MAX_COUNT = 5

# What Google is asked for when she names a bare word. "לים" searched as "ים"
# found a pet shop called "ים דגי נוי" and a swimwear store (8.10, live): Text
# Search matches business NAMES, so the sea has to be asked for as a beach.
_SEARCH_AS = {
    "ים": "חוף ים", "הים": "חוף ים", "לים": "חוף ים", "חוף": "חוף ים", "חופים": "חוף ים",
    "sea": "beach", "the sea": "beach", "seaside": "beach", "ocean": "beach",
    "דואר": "סניף דואר", "הדואר": "סניף דואר", "post": "post office",
}


def search_query(category: str) -> str:
    """The words Google is given for the kind of place she asked for."""
    c = str(category or "").strip()
    return _SEARCH_AS.get(c.lower(), c)

# Parking — an allowance, not a measurement.
_PARK_SEARCH_M = 800        # how far from the place a car park still counts
_PARK_CLOSE_M = 500         # a car park this close: finding a space is quick
_PARK_FIND_CLOSE_MIN = 5
_PARK_FIND_FAR_MIN = 10     # no car park nearby: street parking, take longer
_PARKING_QUERY = "חניון"
_WALK_M_PER_MIN = 80
_DETOUR = 1.3               # streets are longer than the straight line
_BIKE_LOCK_MIN = 2
# A taxi is a car that comes to her: the drive, plus waiting for it to arrive.
# An allowance, said as one ("~"), never a quote — and no price: there is no
# honest source for one (Koral, 7.10: "always, with a Gett button, no price").
_TAXI_PICKUP_MIN = 5
# Start and destination this close are the same place: no trip to plan.
_ALREADY_THERE_M = 150


def normalize_modes(modes, fallback: Optional[str]) -> list[str]:
    """Her words for vehicles → the modes Google knows, in her order, deduped.
    Nothing usable → her usual mode → car."""
    alias = {"transit": "bus", "public": "bus", "אוטובוס": "bus", "רכבת": "train",
             "אוטו": "car", "רכב": "car", "driving": "car", "אופניים": "bike",
             "bicycle": "bike", "cycling": "bike", "scooter": "bike", "קורקינט": "bike",
             "הליכה": "walk", "walking": "walk", "foot": "walk", "ברגל": "walk",
             "מונית": "taxi", "cab": "taxi", "gett": "taxi", "uber": "taxi", "yango": "taxi"}
    out: list[str] = []
    for m in modes or []:
        m = alias.get(str(m).strip().lower(), str(m).strip().lower())
        if m in MODES and m not in out:
            out.append(m)
    if not out:
        f = alias.get(str(fallback or "").lower(), str(fallback or "").lower())
        out = [f if f in MODES else "car"]
    return out


# The ways of going she can NAME in a sentence, with Hebrew's attached
# prepositions (באוטו, במונית, ברגל) — a word table, like categorize.
_NAMED_MODE_WORDS = {
    "car": ("באוטו", "ברכב", "במכונית", "by car", "drive", "driving"),
    "taxi": ("במונית", "מונית", "taxi", "cab", "gett"),
    "bus": ("באוטובוס", "אוטובוס", "בתחבורה ציבורית", "by bus", "bus"),
    "train": ("ברכבת", "רכבת", "by train", "train"),
    "bike": ("באופניים", "אופניים", "בקורקינט", "by bike", "bike", "cycling", "scooter"),
    "walk": ("ברגל", "בהליכה", "on foot", "walking", "walk"),
}


def named_modes(text: str) -> list[str]:
    """The ways of going her words name, in a fixed order; [] when none."""
    t = f" {str(text or '').lower()} "
    out = []
    for mode, words in _NAMED_MODE_WORDS.items():
        if any(re.search(rf"(?<![\w\u0590-\u05FF]){re.escape(w)}(?![\w\u0590-\u05FF])", t)
               for w in words):
            out.append(mode)
    return out


def _walk_minutes(metres: float) -> int:
    return max(1, round(metres * _DETOUR / _WALK_M_PER_MIN))


def _wait_minutes(depart_at: Optional[str], now_hhmm: str) -> int:
    """Minutes from now until the trip's first step (transit). A departure that
    reads as earlier than now is after midnight — at most a day away."""
    if not depart_at:
        return 0
    try:
        dh, dm = (int(x) for x in depart_at.split(":"))
        nh, nm = (int(x) for x in now_hhmm.split(":"))
    except ValueError:
        return 0
    gap = (dh * 60 + dm) - (nh * 60 + nm)
    return gap if gap >= 0 else gap + 1440


async def _parking(client: httpx.AsyncClient, dest: dict) -> dict:
    """{find_min, walk_min, lot, lot_m} for driving to `dest`. Estimate."""
    try:
        lots = await geo.places_near(client, _PARKING_QUERY, dest["lat"], dest["lng"], _PARK_SEARCH_M)
    except geo.PlacesRefused:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("place_ranker parking search failed: %s", exc)
        lots = []
    best, best_m = None, None
    for lot in lots:
        loc = (lot.get("geometry") or {}).get("location") or {}
        if "lat" not in loc:
            continue
        m = errands_along.metres((dest["lat"], dest["lng"]), (loc["lat"], loc["lng"]))
        if m <= _PARK_SEARCH_M and (best_m is None or m < best_m):
            best, best_m = lot, m
    if best is None:
        return {"find_min": _PARK_FIND_FAR_MIN, "walk_min": 0, "lot": None, "lot_m": None}
    return {"find_min": _PARK_FIND_CLOSE_MIN if best_m <= _PARK_CLOSE_M else _PARK_FIND_FAR_MIN,
            "walk_min": _walk_minutes(best_m), "lot": best.get("name"), "lot_m": round(best_m)}


def _leg(mode: str, route: dict, now_hhmm: str, parking: Optional[dict]) -> dict:
    """One mode's door-to-door minutes, with the parts that make it up."""
    ride = int(route["minutes"])
    leg = {"mode": mode, "ride_min": ride}
    total = ride
    if mode == "car" and parking:
        leg["park_min"] = parking["find_min"]
        leg["walk_from_parking_min"] = parking["walk_min"]
        if parking.get("lot"):
            leg["parking"] = parking["lot"]
            leg["parking_m"] = parking["lot_m"]
        leg["parking_is_estimate"] = True
        total += parking["find_min"] + parking["walk_min"]
    elif mode == "taxi":
        leg["wait_min"] = _TAXI_PICKUP_MIN
        leg["wait_is_estimate"] = True
        total += _TAXI_PICKUP_MIN
    elif mode in ("bus", "train"):
        wait = _wait_minutes(route.get("departAt"), now_hhmm)
        leg["wait_min"] = wait
        total += wait
        t = route.get("transit") or {}
        if t.get("line"):
            leg["line"] = t.get("line")
            leg["vehicle"] = t.get("vehicle")
            leg["from_stop"] = t.get("departStop")
            if t.get("departTime"):
                leg["board_at"] = t.get("departTime")
        legs = route.get("legs") or []
        if legs and legs[0].get("type") == "walk":
            leg["walk_to_stop_min"] = legs[0].get("minutes")
        if route.get("departAt"):
            leg["leave_at"] = route["departAt"]
        if route.get("arriveAtReal"):
            leg["arrive_at"] = route["arriveAtReal"]
    elif mode == "bike":
        leg["lock_min"] = _BIKE_LOCK_MIN
        total += _BIKE_LOCK_MIN
    leg["total_min"] = total
    return leg


async def _hours(client: httpx.AsyncClient, place_id: Optional[str]) -> dict:
    if not place_id:
        return {}
    d = await errands_along._details(client, place_id)
    today = _tz.today_il()
    now = _tz.now_il().strftime("%H:%M")
    return {"open_now": errands_along.open_at(d.get("periods"), today, now),
            "hours_today": errands_along.hours_today(d.get("weekday_text") or [], today) or None}


async def rank(*, origin: dict, modes: list[str], category: Optional[str] = None,
               destination: Optional[dict] = None, park_at_destination: bool = True,
               open_now: bool = False, count: int = 3) -> dict:
    """The quickest place (category) or way (destination), door to door.

    origin / destination: {lat, lng, formatted?, place_id?, name?}.
    -> {ok, results:[{name, address, distance_km, best, by_mode, open_now?}]}
       or {ok: False, reason, detail?}
    """
    if not config.GOOGLE_MAPS_API_KEY:
        return {"ok": False, "reason": "not_configured"}
    if not (category or destination):
        return {"ok": False, "reason": "nothing_to_find"}
    count = max(1, min(int(count or 3), _MAX_COUNT))
    now_hhmm = _tz.now_il().strftime("%H:%M")
    here = (origin["lat"], origin["lng"])

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            if destination:
                candidates = [{"name": destination.get("name") or destination.get("formatted"),
                               "address": destination.get("formatted"),
                               "lat": destination["lat"], "lng": destination["lng"],
                               "place_id": destination.get("place_id")}]
            else:
                found = await geo.places_near(client, category, here[0], here[1], _SEARCH_RADIUS_M)
                seen, candidates = set(), []
                for r in found:
                    loc = (r.get("geometry") or {}).get("location") or {}
                    pid = r.get("place_id")
                    if "lat" not in loc or pid in seen:
                        continue
                    seen.add(pid)
                    candidates.append({"name": r.get("name"), "address": r.get("formatted_address"),
                                       "lat": loc["lat"], "lng": loc["lng"], "place_id": pid})
                if not candidates:
                    return {"ok": False, "reason": "nothing_found", "query": category}
                # Google ranks Text Search by relevance, not distance: keep the
                # nearest few by the straight line before paying for routes.
                candidates.sort(key=lambda c: errands_along.metres(here, (c["lat"], c["lng"])))
                keep = _CANDIDATES_ONE_MODE if len(modes) == 1 else _CANDIDATES_MANY_MODES
                candidates = candidates[:max(keep, count)]

            for c in candidates:
                c["distance_km"] = round(errands_along.metres(here, (c["lat"], c["lng"])) / 1000, 1)

            pairs = [(c, m) for c in candidates for m in modes]
            routes = await asyncio.gather(*(
                geo.directions_detailed(origin, {"lat": c["lat"], "lng": c["lng"]},
                                        "car" if m == "taxi" else m, None)
                for c, m in pairs))
            parking: dict[int, dict] = {}
            if "car" in modes and park_at_destination:
                lots = await asyncio.gather(*(_parking(client, c) for c in candidates))
                parking = {id(c): p for c, p in zip(candidates, lots)}

            reasons = []
            for (c, m), (route, reason) in zip(pairs, routes):
                if route is None:
                    reasons.append(reason)
                    c.setdefault("failed_modes", {})[m] = reason
                    continue
                c.setdefault("by_mode", {})[m] = _leg(m, route, now_hhmm, parking.get(id(c)))

            reached = [c for c in candidates if c.get("by_mode")]
            if not reached:
                if "refused" in reasons or "not_configured" in reasons:
                    return {"ok": False, "reason": "directions_refused"}
                if reasons and all(r == "unreachable" for r in reasons):
                    return {"ok": False, "reason": "directions_unreachable"}
                return {"ok": False, "reason": "no_route"}
            for c in reached:
                c["best"] = min(c["by_mode"].values(), key=lambda leg: leg["total_min"])
            reached.sort(key=lambda c: c["best"]["total_min"])

            if open_now and not destination:
                for c in reached[:count + 2]:
                    c.update(await _hours(client, c.get("place_id")))
                # Open first (by time), then unknown, then closed — closed is
                # still shown, because "the nearest one is closed now" is news.
                order = {True: 0, None: 1, False: 2}
                reached.sort(key=lambda c: (order[c.get("open_now")], c["best"]["total_min"]))
    except geo.PlacesRefused as exc:
        logger.error("place_ranker: Places refused the server key — %s", exc)
        return {"ok": False, "reason": "places_refused", "detail": str(exc)[:160]}
    except httpx.HTTPError as exc:
        logger.warning("place_ranker: Places unreachable — %s", exc)
        return {"ok": False, "reason": "places_unreachable"}

    results = []
    for c in reached[:count]:
        row = {k: c.get(k) for k in ("name", "address", "lat", "lng", "place_id",
                                     "distance_km", "best", "by_mode")}
        if c.get("failed_modes"):
            row["failed_modes"] = c["failed_modes"]
        if "open_now" in c:
            row["open_now"] = c["open_now"]
            row["hours_today"] = c.get("hours_today")
        results.append(row)
    return {"ok": True, "now": now_hhmm, "modes": modes, "results": results,
            **({"query": category} if category else {})}


# ── one entry point: the agent's tools AND the fast path call this ──────────

_HOME_WORDS = ("home", "my home", "הביתה", "בית", "הבית", "לבית", "habayta")


def _here_point(here: Optional[dict]) -> str:
    """"lat,lng" of the app's live fix, or "" — (0,0) is no fix (Null Island)."""
    try:
        lat, lng = float((here or {})["lat"]), float((here or {})["lng"])
    except (KeyError, TypeError, ValueError):
        return ""
    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
        return ""
    return f"{lat:.5f},{lng:.5f}"


def route_modes(profile: Optional[dict]) -> list[str]:
    """"How do I get home?" with no mode named: every way she could go — on
    foot, the bus, a taxi — plus her own vehicle when she has one."""
    modes = ["walk", "bus", "taxi"]
    prof = profile or {}
    # Only a vehicle she HAS: normalize_modes falls back to "car" for nothing,
    # and offering a car to someone without one is how a plan goes wrong.
    raw = prof.get("transportType")
    own = normalize_modes([raw], None)[0] if raw else None
    if own in ("car", "bike", "train") and own not in modes:
        modes.insert(0, own)
    if prof.get("hasCar") is True and "car" not in modes:
        modes.insert(0, "car")
    return modes


async def resolve_origin(profile: Optional[dict], here: Optional[dict],
                         origin: str = "auto") -> tuple[Optional[dict], str, Optional[str]]:
    """(position, origin_used, note) — where the trip starts, never asked when known.

    auto: where she is now, else home. 'home' / 'here': that one, else the
    other, with a note saying which was used. (None, "", None) only when
    nothing at all is known."""
    prof = profile or {}
    home = str(prof.get("homeAddress") or "").strip()
    point = _here_point(here) or str(prof.get("currentAddress") or "").strip()
    label = str((here or {}).get("label") or "").strip() if _here_point(here) else ""
    want = str(origin or "auto").strip().lower()
    if want in ("home", "בית", "הבית", "מהבית"):
        order = [(home, "home", None), (point, "here", "no_home_saved")]
    elif want in ("here", "auto", "", "current", "כאן", "פה", "מפה"):
        order = [(point, "here", None),
                 (home, "home", None if want == "auto" else "no_live_position")]
    else:
        order = [(origin, "named", None)]
    for addr, used, note in order:
        if not addr:
            continue
        pos = await geo.geocode(addr)
        if pos:
            if used == "here" and label:
                pos["formatted"] = label
            return pos, used, note
    return None, "", None


async def resolve_destination(text: str, profile: Optional[dict],
                              recall=None) -> tuple[Optional[dict], bool, Optional[str]]:
    """(place, is_home, reason) for 'home', a place she has, or a name/address."""
    words = str(text or "").strip()
    is_home = words.lower() in _HOME_WORDS
    if is_home:
        words = str((profile or {}).get("homeAddress") or "").strip()
        if not words:
            return None, True, "no_home_saved"
    elif recall:
        hit = recall(words)
        if hit and hit.get("address"):
            words = hit["address"]
    if not words:
        return None, is_home, "nothing_to_find"
    dest = await geo.geocode(words) or await geo.find_place(words)
    if not dest:
        return None, is_home, "destination_not_found"
    dest.setdefault("name", "home" if is_home else str(text).strip())
    return dest, is_home, None


async def lookup(*, profile: Optional[dict], here: Optional[dict], recall=None,
                 category: Optional[str] = None, destination: Optional[str] = None,
                 modes=None, origin: str = "auto", open_now: bool = False,
                 count: int = 3) -> dict:
    """The answer to "the closest X" (category) or "how do I get to Y" (destination).

    -> rank()'s result plus {kind: 'places'|'route', origin_used, origin_note?,
    destination?}, or {ok: False, reason}. Read-only."""
    start, used, note = await resolve_origin(profile, here, origin)
    if not start:
        return {"ok": False, "reason": "need_origin",
                "message": "No live position and no home address — ask ONCE where she is now."}
    usual = (profile or {}).get("transportType")
    if destination and not category:
        dest, is_home, why = await resolve_destination(destination, profile, recall)
        if not dest:
            return {"ok": False, "reason": why, "kind": "route"}
        if is_home and used == "home":
            # "How do I get home?" with no idea where she is: a route from home
            # to home is "1 min on foot" — a confident nonsense answer (7.10).
            return {"ok": False, "reason": "need_origin", "kind": "route",
                    "message": "She is asking how to get HOME and her live position is unknown — "
                               "ask ONCE where she is now."}
        apart = errands_along.metres((start["lat"], start["lng"]), (dest["lat"], dest["lng"]))
        if apart < _ALREADY_THERE_M:
            return {"ok": False, "reason": "already_there", "kind": "route",
                    "message": "She is already there (start and destination are the same place) — say so."}
        chosen = normalize_modes(modes, usual) if modes else route_modes(profile)
        result = await rank(origin=start, modes=chosen, destination=dest,
                            park_at_destination=not is_home)
        result.update({"kind": "route", "to_home": is_home,
                       "destination": {"name": dest.get("name"), "address": dest.get("formatted"),
                                       "lat": dest.get("lat"), "lng": dest.get("lng")}})
    else:
        result = await rank(origin=start, modes=normalize_modes(modes, usual),
                            category=search_query(category), open_now=bool(open_now),
                            count=count)
        result["kind"] = "places"
    result["origin_used"] = used
    result["origin"] = {"name": start.get("formatted"), "lat": start.get("lat"), "lng": start.get("lng")}
    if note:
        result["origin_note"] = note
    return result


TRIP_BUFFER_MIN = 5
_DEFAULT_STOP_MIN = 10


def _mins(hhmm: Optional[str]) -> Optional[int]:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(hhmm or "").strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def _clock(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


async def trip_via(*, profile: Optional[dict], here: Optional[dict], recall=None,
                   via: list, destination: str, arrive_by: Optional[str] = None,
                   stop_minutes: Optional[int] = None, modes=None,
                   origin: str = "auto", now_hhmm: Optional[str] = None) -> dict:
    """"When do I leave from here to pass home and then reach the gym by 20:00?"

    27.10, Koral at Yitzhak Sadeh with a workout next: Meira answered the
    route to the gym leaving NOW and never went home. The question has three
    parts — the stops in order, the time she stays at each, and the hour she
    must arrive — and each is arithmetic once the legs are routed.

    One vehicle for the whole chain (she does not leave her bike at home and
    walk on), the one with the shortest total. -> {ok, kind: 'trip', mode,
    legs: [{to, minutes}], stop_minutes, leave_at, arrive_at, late} or
    {ok: False, reason}."""
    stops = [*(via or [])[:2], destination]
    legs: list = []
    start = origin or "auto"
    for stop in stops:
        r = await lookup(profile=profile, here=here, recall=recall, destination=stop,
                         modes=modes, origin=start)
        if not r.get("results") or r.get("ok") is False:
            return {"ok": False, "kind": "trip", "reason": r.get("reason") or "no_route",
                    "stop": stop}
        legs.append(r)
        start = "home" if (r.get("to_home") or str(stop).strip().lower() in _HOME_WORDS) else (
            (r.get("destination") or {}).get("address") or stop)
    by_leg = [(leg["results"][0].get("by_mode") or {}) for leg in legs]
    common = set(by_leg[0]).intersection(*by_leg[1:]) - {"taxi"} or set(by_leg[0]).intersection(*by_leg[1:])
    if not common:
        return {"ok": False, "kind": "trip", "reason": "no_common_mode"}
    mode = min(common, key=lambda m: sum(b[m]["total_min"] for b in by_leg))
    stay = _DEFAULT_STOP_MIN if stop_minutes is None else int(stop_minutes)
    minutes = [int(b[mode]["total_min"]) for b in by_leg]
    total = sum(minutes) + stay * (len(stops) - 1)
    now = _mins(now_hhmm) if now_hhmm else None
    if now is None:
        n = _tz.now_il()
        now = n.hour * 60 + n.minute
    target = _mins(arrive_by)
    out = {"ok": True, "kind": "trip", "mode": mode, "stop_minutes": stay,
           "legs": [{"to": str(s), "minutes": m,
                     "home": bool(leg.get("to_home")) or str(s).strip().lower() in _HOME_WORDS}
                    for s, m, leg in zip(stops, minutes, legs)],
           "total_min": total, "arrive_by": arrive_by,
           "origin_used": legs[0].get("origin_used"), "results": legs[-1]["results"]}
    if target is None:
        out.update({"leave_at": _clock(now), "arrive_at": _clock(now + total), "late": False})
        return out
    leave = target - total - TRIP_BUFFER_MIN
    late = leave < now
    out.update({"leave_at": _clock(max(leave, now)),
                "arrive_at": _clock(now + total if late else target - TRIP_BUFFER_MIN),
                "late": late})
    return out


def say_trip(result: dict, he: bool) -> str:
    """'צאי ב-19:28 באופניים: 7 דק׳ הביתה · 10 בבית · 12 לאימון → שם ב-19:55.'"""
    lang = "he" if he else "en"
    mins = "דק׳" if he else "min"
    parts = []
    for i, leg in enumerate(result.get("legs") or []):
        to = ("הביתה" if he else "home") if leg.get("home") else (
            f"ל{leg['to']}" if he else f"to {leg['to']}")
        parts.append(f"{leg['minutes']} {mins} {to}")
        if i < len(result["legs"]) - 1:
            stay = (("בבית" if he else "at home") if leg.get("home")
                    else ("שם" if he else "there"))
            parts.append(f"{result['stop_minutes']} {mins} {stay}")
    route = " · ".join(parts)
    way = _MODE_WORD[lang].get(result.get("mode"), "")
    if result.get("late"):
        head = (f"כבר צפוף ל-{result['arrive_by']}: אם יוצאת עכשיו {way} — מגיעה ב-{result['arrive_at']}"
                if he else f"It's tight for {result['arrive_by']}: leaving now {way}, you arrive at {result['arrive_at']}")
        return f"{_RLM if he else _LRM}{head}.\n{_RLM if he else _LRM}{route}"
    head = (f"צאי ב-{result['leave_at']} {way}" if he else f"Leave at {result['leave_at']} {way}")
    tail = (f" → שם ב-{result['arrive_at']}" if he else f" → there at {result['arrive_at']}")
    return f"{_RLM if he else _LRM}{head}: {route}{tail}."


# ── the words, written by code ─────────────────────────────────────────────

_MODE_WORD = {
    "he": {"car": "באוטו", "bike": "באופניים", "bus": "באוטובוס", "train": "ברכבת",
           "walk": "ברגל", "taxi": "במונית"},
    "en": {"car": "by car", "bike": "by bike", "bus": "by bus", "train": "by train",
           "walk": "on foot", "taxi": "by taxi"},
}


def _parts(leg: dict, he: bool) -> str:
    """'17 נסיעה · ~5 חניה · 2 הליכה' — what the total is made of."""
    m = leg.get("mode")
    out = []
    if m in ("bus", "train"):
        if leg.get("line"):
            stop = f" מ{leg['from_stop']}" if he and leg.get("from_stop") else (
                f" from {leg['from_stop']}" if leg.get("from_stop") else "")
            at = f" ב-{leg['board_at']}" if he and leg.get("board_at") else (
                f" at {leg['board_at']}" if leg.get("board_at") else "")
            out.append((f"קו {leg['line']}" if he else f"line {leg['line']}") + stop + at)
        return " · ".join(out)
    if m == "taxi":
        return (f"~{leg.get('wait_min')} המתנה + {leg['ride_min']} נסיעה" if he
                else f"~{leg.get('wait_min')} wait + {leg['ride_min']} ride")
    verb = {"car": ("נסיעה", "drive"), "bike": ("רכיבה", "ride"), "walk": ("הליכה", "walk")}.get(
        m, ("נסיעה", "ride"))
    out.append(f"{leg['ride_min']} {verb[0] if he else verb[1]}")
    if leg.get("park_min"):
        out.append(f"~{leg['park_min']} {'חניה' if he else 'parking'}")
    if leg.get("walk_from_parking_min"):
        out.append(f"{leg['walk_from_parking_min']} {'הליכה' if he else 'walk'}")
    if leg.get("lock_min"):
        out.append(f"{leg['lock_min']} {'נעילה' if he else 'lock'}")
    return " · ".join(out)


# Each line opens with a direction mark: "חוף עליה — ~26 min by car" starts
# with a Hebrew name, so the phone laid the whole English line out right-to-
# left and scrambled it (7.10, on her phone). The mark says which way it reads.
_LRM, _RLM = "\u200e", "\u200f"


def say(result: dict, he: bool) -> str:
    mark = _RLM if he else _LRM
    text = _say(result, he)
    return "\n".join(mark + line for line in text.split("\n")) if text else text


def _say(result: dict, he: bool) -> str:
    """The reply for a lookup that succeeded, in 1-2 lines (CLAUDE.md: short).

    Written by code: the numbers are the answer, and a model paraphrasing
    them was 50 seconds of waiting for the same sentence (7.10)."""
    lang = "he" if he else "en"
    rows = result.get("results") or []
    if not rows:
        return ""
    mins = "דק׳" if he else "min"
    where = ""
    if result.get("origin_note") == "no_home_saved":
        where = " (מהמקום שלך — אין לי כתובת בית)" if he else " (from where you are — no home saved)"
    if result.get("kind") == "route":
        by_mode = sorted((rows[0].get("by_mode") or {}).values(), key=lambda l: l["total_min"])
        best = by_mode[0]
        head = (f"הכי מהיר: {_MODE_WORD[lang][best['mode']]} — {best['total_min']} {mins}"
                if he else f"Fastest: {_MODE_WORD[lang][best['mode']]} — {best['total_min']} {mins}")
        detail = _parts(best, he)
        others = " · ".join(f"{_MODE_WORD[lang][l['mode']]} {l['total_min']}" for l in by_mode[1:])
        line1 = f"{head}{f' ({detail})' if detail else ''}{where}."
        return line1 + (f"\n{'אחרות' if he else 'Other ways'}: {others}" if others else "")
    first = rows[0]
    best = first["best"]
    closed = ""
    if first.get("open_now") is False:
        closed = " — סגור עכשיו" if he else " — closed now"
    line1 = (f"{first['name']} — ~{best['total_min']} {mins} {_MODE_WORD[lang][best['mode']]}"
             f" ({_parts(best, he)}){closed}{where}.")
    ways = sorted((first.get("by_mode") or {}).values(), key=lambda l: l["total_min"])
    if len(ways) > 1:
        # "Car, bike or bus?" — the comparison IS the answer; the winner alone
        # left out what she asked (8.10). The card has the other places.
        others = " · ".join(f"{_MODE_WORD[lang][l['mode']]} {l['total_min']}" for l in ways[1:])
        return line1 + f"\n{'אחרות' if he else 'Other ways'}: {others}"
    if len(rows) > 1:
        nxt = rows[1]
        line1 += (f"\n{'אחריו' if he else 'Next'}: {nxt['name']} ~{nxt['best']['total_min']} {mins}")
    return line1


def _cli() -> None:  # pragma: no cover — a live diagnostic, needs the Maps key
    """python place_ranker.py "חוף ים" --from "<address>" [--modes car,bike,bus]"""
    import argparse
    import json
    p = argparse.ArgumentParser()
    p.add_argument("category")
    p.add_argument("--from", dest="origin", required=True)
    p.add_argument("--modes", default="car")
    p.add_argument("--open-now", action="store_true")
    a = p.parse_args()

    async def go():
        o = await geo.geocode(a.origin)
        if not o:
            print(json.dumps({"ok": False, "reason": "origin_unresolved"}))
            return
        out = await rank(origin=o, modes=normalize_modes(a.modes.split(","), None),
                         category=a.category, open_now=a.open_now)
        print(json.dumps(out, ensure_ascii=False, indent=2))

    asyncio.run(go())


if __name__ == "__main__":  # pragma: no cover
    _cli()
