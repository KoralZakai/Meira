"""Google Maps geocoding + directions for the WhatsApp backend.

This is the heart of the app: turn the user's REAL home and the REAL destination
into precise coordinates, ask Google Directions for the REAL travel time by the
user's actual transport mode, then derive when to leave home and wake up.

Design choices for accuracy:
- Geocode BOTH ends and drive Directions off lat/lng + place_id, not loose text,
  so we don't silently route from the wrong "Trumpeldor".
- Pass the real arrival_time so transit/traffic estimates match the actual hour.
- Return the resolved addresses + mode so Lumi can CONFIRM them with the user
  before trusting the plan.

Dependencies: config (GOOGLE_MAPS_API_KEY), httpx. Consumed by lumi_agent
(plan_departure tool) and main.py (reverse_geocode for shared locations).
The returned plan dict feeds reminders.schedule_departures — keep its keys
(wakeUpBy, leaveHomeBy, arriveBy, destination, date) stable.
"""
import logging
import re
from datetime import datetime, time as dtime, timedelta
from typing import Optional

import httpx

import config
from tz import IL, now_il, today_il

logger = logging.getLogger(__name__)

# App TransportType -> Google Directions travel mode.
_MODE_MAP = {
    "car": "driving",
    "bus": "transit",
    "train": "transit",
    "transit": "transit",
    "walk": "walking",
    "bike": "bicycling",
}
_MODE_LABEL = {
    "driving": "by car",
    "transit": "by public transport",
    "walking": "on foot",
    "bicycling": "by bike",
}
# Google Directions transit_mode preference per transport (bus-only vs rail).
_TRANSIT_PREF = {
    "bus": "bus",
    "train": "train|tram|subway",
}


def _next_occurrence(hhmm: str) -> int:
    """Unix timestamp of the next Israel-local HH:MM (today, or tomorrow if it's
    already passed). Feeds Google Directions' arrival_time — must be IL-aware
    or the traffic/transit estimate is computed for the wrong hour (was naive
    UTC before this fix, silently 2-3h off depending on DST)."""
    h, m = (int(x) for x in hhmm.split(":"))
    when = datetime.combine(today_il(), dtime(hour=h, minute=m), tzinfo=IL)
    if when < now_il():
        when += timedelta(days=1)  # handles month/year rollover, unlike day+1
    return int(when.timestamp())


_COORDS_RE = re.compile(r"^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$")


# Addresses do not move: one Google call per address per month, per process.
# A miss is remembered for an hour so a bad address is not paid for on every save.
_GEOCODE_TTL_S = 30 * 24 * 3600
_GEOCODE_MISS_TTL_S = 600   # short: a None can also be a network blip
_GEOCODE_MAX = 2000
_geocode_cache: dict = {}


async def geocode(address: str, bounds: Optional[str] = None) -> Optional[dict]:
    import time as _t
    key = (str(address or "").strip().lower(), bounds or "")
    hit = _geocode_cache.get(key)
    if hit and hit[0] > _t.time():
        return dict(hit[1]) if hit[1] else None
    found = await _geocode_uncached(address, bounds)
    if len(_geocode_cache) >= _GEOCODE_MAX:
        _geocode_cache.pop(next(iter(_geocode_cache)))
    _geocode_cache[key] = (_t.time() + (_GEOCODE_TTL_S if found else _GEOCODE_MISS_TTL_S), dict(found) if found else None)
    return found


async def _geocode_uncached(address: str, bounds: Optional[str] = None) -> Optional[dict]:
    """Resolve an address to {formatted, lat, lng, place_id, partial}. None if not found.

    `bounds` is Google's "lat,lng|lat,lng" viewport hint — a BIAS, not a filter:
    Google still returns a distant match when that is the only one. The phone
    passes a box around her home so a bare street name lands in her own city.
    """
    if not address:
        return None
    # A live fix ("32.07312,34.79201") is already a position — the app sends
    # one with every chat turn. Asking Google to geocode it costs a call and
    # can only move it.
    coords = _COORDS_RE.match(str(address).strip())
    if coords:
        lat, lng = float(coords.group(1)), float(coords.group(2))
        if -90 <= lat <= 90 and -180 <= lng <= 180:
            return {"formatted": f"{lat:.5f},{lng:.5f}", "lat": lat, "lng": lng,
                    "place_id": None, "partial": False}
    if not config.GOOGLE_MAPS_API_KEY:
        return None
    params = {"address": address, "key": config.GOOGLE_MAPS_API_KEY}
    # Bias toward Israel so 'Trompeldor 20' doesn't land in another country.
    params["region"] = "il"
    if bounds:
        params["bounds"] = bounds
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get("https://maps.googleapis.com/maps/api/geocode/json", params=params)
            data = r.json()
        if data.get("status") != "OK":
            logger.warning("geocode -> %s", data.get("status"))
            return None
        res = data["results"][0]
        loc = res["geometry"]["location"]
        return {
            "formatted": res["formatted_address"],
            "lat": loc["lat"],
            "lng": loc["lng"],
            "place_id": res.get("place_id"),
            # 'partial_match' or only a city-level type => low confidence, must confirm.
            "partial": bool(res.get("partial_match")) or res["geometry"].get("location_type") in ("APPROXIMATE",),
        }
    except (httpx.HTTPError, KeyError, IndexError) as exc:
        logger.error("geocode error: %s", exc)
        return None


def looks_like_name(text: str) -> bool:
    """A business or place NAME rather than a street address: no house number,
    short. "Nebuis", "Intel Haifa", "קפה לנדוור" — yes; "יצחק שדה 6" — no."""
    t = (text or "").strip()
    return bool(t) and not any(ch.isdigit() for ch in t) and len(t) <= 60


_place_cache: dict = {}


async def find_place(query: str) -> Optional[dict]:
    """Cached (a miss for a day): a name that never resolves is asked once, not every sweep."""
    import time as _t
    key = (query or "").strip().lower()
    hit = _place_cache.get(key)
    if hit and hit[0] > _t.time():
        return dict(hit[1]) if hit[1] else None
    found = await _find_place_uncached(query)
    if len(_place_cache) >= _GEOCODE_MAX:
        _place_cache.pop(next(iter(_place_cache)))
    _place_cache[key] = (_t.time() + (_GEOCODE_TTL_S if found else 24 * 3600), dict(found) if found else None)
    return found


async def _find_place_uncached(query: str) -> Optional[dict]:
    """Resolve a business/place NAME to {name, formatted, lat, lng, place_id}.

    geocode() needs a street address; a company name like 'MER Group' returns
    nothing or a wrong partial. Places Text Search takes the name and returns
    the real address — the fix for Lumi inventing 'HaArba'a 3 Tel Aviv' for a
    firm actually at 'Yahadut Canada 5, Or Yehuda'. Israel-biased. None if not
    found or if the Places API isn't enabled on the key.
    """
    if not config.GOOGLE_MAPS_API_KEY or not query:
        return None
    params = {"query": query, "key": config.GOOGLE_MAPS_API_KEY, "region": "il"}
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get(
                "https://maps.googleapis.com/maps/api/place/textsearch/json", params=params)
            data = r.json()
        status = data.get("status")
        if status != "OK" or not data.get("results"):
            # REQUEST_DENIED usually = Places API not enabled on the key.
            logger.warning("find_place -> %s", status)
            return None
        res = data["results"][0]
        loc = res["geometry"]["location"]
        return {
            "name": res.get("name"),
            "formatted": res.get("formatted_address"),
            "lat": loc["lat"],
            "lng": loc["lng"],
            "place_id": res.get("place_id"),
        }
    except (httpx.HTTPError, KeyError, IndexError) as exc:
        logger.error("find_place error: %s", exc)
        return None


async def reverse_geocode(lat: float, lng: float) -> Optional[dict]:
    """Coordinates -> {formatted, lat, lng, place_id}. For shared WhatsApp locations."""
    if not config.GOOGLE_MAPS_API_KEY:
        return None
    params = {"latlng": f"{lat},{lng}", "key": config.GOOGLE_MAPS_API_KEY}
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get("https://maps.googleapis.com/maps/api/geocode/json", params=params)
            data = r.json()
        if data.get("status") != "OK":
            return {"formatted": f"{lat:.5f},{lng:.5f}", "lat": lat, "lng": lng, "place_id": None}
        res = data["results"][0]
        return {
            "formatted": res["formatted_address"],
            "lat": lat,
            "lng": lng,
            "place_id": res.get("place_id"),
        }
    except (httpx.HTTPError, KeyError, IndexError) as exc:
        logger.error("reverse_geocode error: %s", exc)
        return None


def _first_transit_leg(steps: list) -> Optional[dict]:
    """First TRANSIT step of a route -> {line, vehicle, departStop, departTime}.

    Used by `directions` for the short 'transit' summary. None if the route has
    no transit step (pure walking route).
    Dependencies: consumed by lumi_agent.plan_departure output and reminders text.
    """
    for s in steps:
        if s.get("travel_mode") == "TRANSIT":
            td = s.get("transit_details", {})
            line = td.get("line", {})
            return {
                "line": line.get("short_name") or line.get("name"),
                "vehicle": (line.get("vehicle") or {}).get("type"),
                "departStop": (td.get("departure_stop") or {}).get("name"),
                "departTime": (td.get("departure_time") or {}).get("text"),
            }
    return None


def _transit_legs(steps: list) -> list:
    """Every step of a transit route as a human-explainable leg list.

    Each leg: {type: 'walk'|'bus'|'train'|..., minutes, from?, to?, line?,
    departTime?, arriveTime?, stops?}. This is what lets Lumi SHOW the user
    exactly why 'leave by 08:12' — walk 6 min to the stop, bus 251 at 08:20
    from Arlozerov, 25 min ride, arrive 08:51.
    Dependencies: returned as plan['legs'] via `directions` -> `plan_departure`;
    rendered by the agent prompt rules in lumi_agent._system_prompt.
    """
    legs = []
    for s in steps:
        mins = max(1, round((s.get("duration") or {}).get("value", 60) / 60))
        if s.get("travel_mode") == "TRANSIT":
            td = s.get("transit_details", {})
            line = td.get("line", {})
            vehicle = ((line.get("vehicle") or {}).get("type") or "BUS").lower()
            start_loc = s.get("start_location") or {}
            end_loc = s.get("end_location") or {}
            legs.append({
                "type": vehicle,  # bus / heavy_rail / subway / tram ...
                "line": line.get("short_name") or line.get("name"),
                # Boarding/alighting coords — the WhatsApp map marks the stations.
                "fromLat": start_loc.get("lat"), "fromLng": start_loc.get("lng"),
                "toLat": end_loc.get("lat"), "toLng": end_loc.get("lng"),
                "from": (td.get("departure_stop") or {}).get("name"),
                "to": (td.get("arrival_stop") or {}).get("name"),
                "departTime": (td.get("departure_time") or {}).get("text"),
                "arriveTime": (td.get("arrival_time") or {}).get("text"),
                "stops": td.get("num_stops"),
                "minutes": mins,
            })
        else:
            legs.append({
                "type": "walk",
                "to": (s.get("html_instructions") or "").replace("Walk to ", "")[:60] or None,
                "minutes": mins,
            })
    return legs


# A drive that has to arrive by HH:MM is asked about this long before it, so
# Google prices the traffic of roughly the right hour (see _time_params).
_DRIVE_LEAD_S = 40 * 60


def _time_params(mode: str, arrival_hhmm: Optional[str]) -> dict:
    """The clock parameters Google accepts for this mode.

    `arrival_time` is a TRANSIT parameter, and Google refuses a request that
    carries it together with `departure_time`. This function used to send both
    for every car trip with an arrival hour — while route_proxy, the app's path,
    had already learned the rule (test_route_proxy). Same API, two readers, and
    only one of them knew. So: transit takes the arrival; driving takes a
    departure (traffic-aware), placed a little before the arrival; walking and
    cycling take neither."""
    if mode == "transit":
        return {"arrival_time": _next_occurrence(arrival_hhmm)} if arrival_hhmm else {}
    if mode == "driving":
        if not arrival_hhmm:
            return {"departure_time": "now"}
        depart = _next_occurrence(arrival_hhmm) - _DRIVE_LEAD_S
        soon = int(now_il().timestamp()) + 60
        return {"departure_time": "now" if depart <= soon else depart}
    return {}


async def directions(origin: dict, destination: dict, transport: str,
                     arrival_hhmm: Optional[str]) -> Optional[dict]:
    """Real route. Returns {minutes, mode, modeLabel, transit?}. None on failure.

    The reason for a None is in directions_detailed."""
    route, _reason = await directions_detailed(origin, destination, transport, arrival_hhmm)
    return route


async def directions_detailed(origin: dict, destination: dict, transport: str,
                              arrival_hhmm: Optional[str]) -> tuple[Optional[dict], Optional[str]]:
    """(route, None) or (None, reason) — "no route between these two" and "Google
    refused the key" are different fixes (silent-state rule 1).

    reason: "not_configured" | "refused" | "no_route" | "unreachable"."""
    if not config.GOOGLE_MAPS_API_KEY:
        return None, "not_configured"
    mode = _MODE_MAP.get(transport, "driving")
    params = {
        "origin": f"place_id:{origin['place_id']}" if origin.get("place_id") else f"{origin['lat']},{origin['lng']}",
        "destination": f"place_id:{destination['place_id']}" if destination.get("place_id") else f"{destination['lat']},{destination['lng']}",
        "mode": mode,
        "key": config.GOOGLE_MAPS_API_KEY,
        "region": "il",
        # Hebrew station/street names — what Israeli users actually recognize
        # (and what keeps the agent from "translating" into invented names).
        "language": "iw",
        **_time_params(mode, arrival_hhmm),
    }
    # 'bus' vs 'train' both map to transit, but each PREFERS its vehicle —
    # this is what lets plan_departure offer "by bus vs by train" side by side.
    if mode == "transit" and transport in _TRANSIT_PREF:
        params["transit_mode"] = _TRANSIT_PREF[transport]
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get("https://maps.googleapis.com/maps/api/directions/json", params=params)
            data = r.json()
        status = data.get("status")
        if status != "OK":
            logger.warning("directions [%s] %s", status, (data.get("error_message") or "")[:120])
            if status in ("REQUEST_DENIED", "OVER_QUERY_LIMIT", "OVER_DAILY_LIMIT", "INVALID_REQUEST"):
                return None, "refused"
            return None, "no_route"
        leg = data["routes"][0]["legs"][0]
        secs = (leg.get("duration_in_traffic") or leg["duration"])["value"]
        out = {
            "minutes": max(1, round(secs / 60)),
            "mode": mode,
            "transport": transport,
            "modeLabel": {"bus": "by bus", "train": "by train"}.get(transport)
            or _MODE_LABEL.get(mode, mode),
        }
        # Keep the encoded route shape — the app's RouteMap draws it (was
        # silently discarded, so Task Detail could never show the route).
        poly = (data["routes"][0].get("overview_polyline") or {}).get("points")
        if poly:
            out["overviewPolyline"] = poly
        if mode == "transit":
            out["transit"] = _first_transit_leg(leg.get("steps", []))
            out["legs"] = _transit_legs(leg.get("steps", []))
            # Door-to-door anchors of THIS specific departure (Google times the
            # initial walk to meet the actual train/bus): when you must start
            # walking, and when you actually arrive at the door.
            out["departAt"] = _extract_hhmm((leg.get("departure_time") or {}).get("text"))
            out["arriveAtReal"] = _extract_hhmm((leg.get("arrival_time") or {}).get("text"))
        return out, None
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        logger.error("directions error: %s", exc)
        return None, "unreachable"


class PlacesRefused(Exception):
    """Google answered REQUEST_DENIED / over quota — the key, not the place."""


async def text_search(query: str, place_type: Optional[str] = None,
                      radius_m: Optional[int] = None) -> list[dict]:
    """Places Text Search for the APP (POST /app/place/search): up to 5
    {name, address, lat, lng}. [] = Google found nothing; a refused or missing
    key RAISES PlacesRefused, so the two never look alike (silent-state rule 1).

    The phone used to ask Google itself with the key compiled into the APK.
    That key is Android-restricted, so every such call was REQUEST_DENIED —
    and while it carried a web-service API at all, anyone who unzipped the
    APK could bill Places to her account by copying two public headers."""
    if not config.GOOGLE_MAPS_API_KEY:
        raise PlacesRefused("no server Maps key")
    params = {"query": query, "region": "il", "language": "iw", "key": config.GOOGLE_MAPS_API_KEY}
    if place_type:
        params["type"] = place_type
    if radius_m:
        params["radius"] = radius_m
    async with httpx.AsyncClient(timeout=12) as client:
        r = await client.get("https://maps.googleapis.com/maps/api/place/textsearch/json", params=params)
        data = r.json()
    status = data.get("status")
    if status in ("REQUEST_DENIED", "OVER_QUERY_LIMIT", "INVALID_REQUEST"):
        raise PlacesRefused(f"{status}: {data.get('error_message') or ''}")
    out = []
    for res in (data.get("results") or [])[:5]:
        loc = (res.get("geometry") or {}).get("location") or {}
        if res.get("name") and loc.get("lat") is not None:
            out.append({"name": res["name"], "address": res.get("formatted_address") or res["name"],
                        "lat": loc["lat"], "lng": loc.get("lng")})
    return out


async def places_near(client: httpx.AsyncClient, query: str, lat: float, lng: float,
                      radius_m: int) -> list[dict]:
    """Places Text Search biased to a point: Google's raw results, possibly [].

    [] means Google found nothing; a refused key RAISES PlacesRefused, so the two
    can never be the same value (silent-state rule 1). Shared by errands_along
    (errands on the way) and place_ranker (the nearest X)."""
    params = {"query": query, "location": f"{lat},{lng}", "radius": radius_m,
              "region": "il", "language": "iw", "key": config.GOOGLE_MAPS_API_KEY}
    r = await client.get("https://maps.googleapis.com/maps/api/place/textsearch/json", params=params)
    data = r.json()
    status = data.get("status")
    if status in ("REQUEST_DENIED", "OVER_QUERY_LIMIT", "INVALID_REQUEST"):
        raise PlacesRefused(f"{status}: {data.get('error_message') or ''}")
    if status not in ("OK", "ZERO_RESULTS"):
        logger.warning("places_near -> %s", status)
    return data.get("results") or []


async def fetch_route_map(plan: dict) -> Optional[bytes]:
    """PNG of the route for WhatsApp: the Google polyline + markers on the
    start (green A), every boarding station (numbered blue) and the destination
    (red B). Fetched server-side so the API key never appears in a user-visible
    URL. None when there's no polyline or the fetch fails."""
    poly = plan.get("overviewPolyline")
    if not (config.GOOGLE_MAPS_API_KEY and poly):
        return None
    markers = []
    if plan.get("startLat") is not None:
        markers.append(f"color:green|label:A|{plan['startLat']},{plan['startLng']}")
    for i, leg in enumerate(plan.get("legs") or []):
        if leg.get("fromLat") is not None:
            markers.append(f"color:blue|label:{i + 1}|{leg['fromLat']},{leg['fromLng']}")
    if plan.get("lat") is not None:
        markers.append(f"color:red|label:B|{plan['lat']},{plan['lng']}")
    params = [
        ("size", "640x400"), ("scale", "2"), ("language", "iw"),
        ("path", f"color:0x6C63FFff|weight:5|enc:{poly}"),
        *[("markers", m) for m in markers],
        ("key", config.GOOGLE_MAPS_API_KEY),
    ]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get("https://maps.googleapis.com/maps/api/staticmap", params=params)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image/"):
                return r.content
            logger.warning("static map rejected (%s)", r.status_code)
    except httpx.HTTPError as exc:
        logger.warning("static map failed: %s", exc)
    return None


def _sub_minutes(hhmm: str, minutes: int) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    total = (h * 60 + m - minutes) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def _extract_hhmm(text: Optional[str]) -> Optional[str]:
    """'10:46' out of a Directions time text, zero-padded; None if absent."""
    m = re.search(r"(\d{1,2}):(\d{2})", text or "")
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


_LEG_ICON = {"walk": "🚶", "bus": "🚌", "heavy_rail": "🚆", "rail": "🚆", "train": "🚆",
             "commuter_train": "🚆", "subway": "🚇", "tram": "🚋"}


def _route_text(legs: Optional[list], leave_by: str, arrive_by: str) -> str:
    """Render the REAL Google legs as ready-to-send WhatsApp lines. The agent
    is instructed to paste this verbatim — it must never write its own station
    names / line numbers / departure times (it invents them otherwise)."""
    lines = []
    for leg in legs or []:
        icon = _LEG_ICON.get((leg.get("type") or "").lower(), "🚌")
        mins = leg.get("minutes")
        if (leg.get("type") or "").lower() == "walk":
            to = leg.get("to") or ""
            lines.append(f"🚶 {mins} דק' הליכה" + (f" → {to}" if to else ""))
        else:
            line_name = leg.get("line") or ""
            frm = leg.get("from") or ""
            to = leg.get("to") or ""
            dep = leg.get("departTime") or ""
            arr = leg.get("arriveTime") or ""
            lines.append(
                f"{icon} {line_name} {dep} מ־{frm} → {to}"
                + (f" (הגעה {arr}, {mins} דק')" if arr else f" ({mins} דק')")
            )
    lines.append(f"🚪 לצאת עד {leave_by} · 🎯 להגיע עד {arrive_by}")
    return "\n".join(lines)


def _vehicle_of(alt: dict) -> str:
    """The vehicle type of an alternative ('train'|'bus'|'subway').

    Classify by whether ANY leg is rail, not just the first non-walk leg: an
    Israeli train trip usually starts with a feeder bus/walk to the station, so
    first-leg classification mislabeled real train journeys as 'bus' and the
    rail filter dropped them (then backfilled with buses — the reported mix).
    """
    kinds = [(leg.get("type") or "").lower() for leg in alt.get("legs") or []
             if (leg.get("type") or "").lower() != "walk"]
    if any("rail" in t or t in ("train", "tram", "commuter_train", "monorail") for t in kinds):
        return "train"
    if any(t == "subway" for t in kinds):
        return "subway"
    return "bus"


def _format_option(alt: dict, index: int, routine_minutes: int,
                   from_home: bool, destination: str, is_interview: bool, lang: str) -> str:
    """One transit option in the user's exact door-to-door format (Hebrew/English):
    wake → walk to station → line + real departure/arrival + arrival station →
    walk to destination → final arrival (+ interview 'arrive early' note)."""
    he = lang == "he"
    legs = alt.get("legs") or []
    walk_legs = [l for l in legs if (l.get("type") or "").lower() == "walk"]
    transit = next((l for l in legs if (l.get("type") or "").lower() != "walk"), {})
    veh = _vehicle_of(alt)
    icon = "🚆" if veh in ("train", "subway") else "🚌"
    ride_word = (("רכבת" if veh in ("train", "subway") else "אוטובוס") if he
                 else ("train" if veh in ("train", "subway") else "bus"))
    line = transit.get("line") or ""
    from_station = transit.get("from") or ""
    to_station = transit.get("to") or ""
    dep = transit.get("departTime") or alt.get("departAt") or ""
    arr_station = transit.get("arriveTime") or ""
    final_arrive = alt.get("arriveAt") or ""
    leave_by = alt.get("leaveBy") or ""
    wake = _sub_minutes(leave_by, routine_minutes) if (from_home and leave_by) else None
    walk1 = walk_legs[0].get("minutes") if walk_legs else None
    walk2 = walk_legs[1].get("minutes") if len(walk_legs) > 1 else None

    lines = [f"*{'אפשרות' if he else 'Option'} {index}:*"]
    if wake:
        lines.append(f"⏰ {'להתעורר עד' if he else 'Wake up by'} {wake}")
    if walk1 is not None:
        lines.append(f"🚶 {walk1} {'דק׳ לתחנת' if he else 'min to'} {from_station}")
    lines.append(
        f"{icon} {ride_word} {line} {'ב-' if he else 'at '}{dep} "
        f"→ {'מגיעה' if he else 'arrives'} {arr_station} {'לתחנת' if he else 'at'} {to_station}"
    )
    if walk2 is not None:
        lines.append(f"🚶 {walk2} {'דק׳ ל' if he else 'min to '}{destination}")
    lines.append(f"📍 {'הגעה ב-' if he else 'Arrive by '}{final_arrive}")
    if is_interview:
        lines.append("💼 " + ("לראיון כדאי להגיע 10–15 דק׳ לפני"
                              if he else "For an interview, arrive 10–15 min early"))
    return "\n".join(lines)


def format_route_message(plan: dict, pref: str = "rail", is_interview: bool = False,
                         lang: str = "he", counter: Optional[list] = None,
                         out_options: Optional[list] = None) -> str:
    """Build the FULL WhatsApp route message deterministically from real Google
    data. The model never renders routes — this is sent verbatim by main.py, so
    stations/lines/times are always Google's, never invented. `pref` filters to
    trains ('rail') or buses ('bus').

    Pass `counter` (a one-element list) to receive how many numbered options were
    rendered. main.py records that as the open "pick 1-N" question so a bare
    number reply is routed to the route picker rather than the HR job picker —
    the count has to come from here because only this function knows it.

    Pass `out_options` (an empty list) to receive the option dicts THEMSELVES,
    in the order they were numbered. Knowing that three options were shown is
    not enough to honour "option 2": the pick has to resolve to a real
    departure, with its own leave time and its own reminder."""
    he = lang == "he"
    alts = plan.get("alternatives") or []
    wanted = ("train", "subway") if pref == "rail" else ("bus",)
    options = [a for a in alts if _vehicle_of(a) in wanted]
    # No option of the asked vehicle — fall back to what exists, but SAY SO
    # instead of silently mixing buses into a "train" answer (the reported bug).
    fell_back = not options
    if fell_back:
        options = alts
    options = options[:3]
    if counter is not None:
        counter.append(len(options))
    if out_options is not None:
        out_options.extend(options)

    start = plan.get("startResolved") or ""
    dest = plan.get("destResolved") or plan.get("destination") or ""
    arrive_by = plan.get("arriveBy") or ""
    routine = plan.get("routineMinutes") or 0
    from_home = bool(plan.get("fromHome"))

    head = [
        f"🏠 {'יציאה מ' if he else 'Leaving from'}: {start}",
        f"🎯 {'יעד' if he else 'Destination'}: {dest} — {'הגעה עד' if he else 'arrive by'} {arrive_by}",
    ]
    if fell_back and pref == "rail":
        head.append("🚆 " + ("אין רכבת ישירה למסלול הזה — הנה אפשרויות אוטובוס:"
                             if he else "No direct train for this route — bus options instead:"))
    blocks = [
        _format_option(a, i + 1, routine, from_home, plan.get("destination") or dest, is_interview, lang)
        for i, a in enumerate(options)
    ]
    if pref == "rail":
        tail = ("🚌 רוצה גם אפשרויות אוטובוס? כתבי \"אוטובוס\". "
                f"או בחרי רכבת (1–{len(options)}) — תזכורת עזיבה תישמר ⏰"
                if he else
                f"🚌 Want bus options too? Say \"bus\". Or pick a train (1–{len(options)}) — leave reminder will be saved ⏰")
    else:
        tail = (f"בחרי אוטובוס (1–{len(options)}) — או 🚆 \"רכבת\""
                if he else f"Pick a bus (1–{len(options)}) — or 🚆 \"train\"")
    return "\n\n".join(["\n".join(head), *blocks, tail])


# Past this, her own legs are not a plan: public transport is (29.10).
_SELF_POWERED_CAP = {"bike": 60, "walk": 45}
_HE_MODE = {"bike": "אופניים", "walk": "הליכה"}


async def plan_departure(
    destination: str,
    arrival_hhmm: str,
    home_address: str,
    transport: str = "car",
    routine_minutes: int = 45,
    buffer_minutes: int = 10,
    start_address: Optional[str] = None,
) -> dict:
    """Accurate wake/leave plan with resolved, confirmable route info.

    Routes from `start_address` (e.g. the user's shared current location) when
    given, otherwise from home. Routine minutes only apply when starting at home.
    Always returns a dict with 'ok'; when ok=False it explains what to clarify.
    """
    origin = start_address or home_address
    from_home = start_address is None
    home_geo = await geocode(origin)
    if not home_geo:
        return {"ok": False, "need": "home_address" if from_home else "start",
                "message": f"Couldn't locate '{origin}'. Ask the user for a clearer address."}
    dest_geo = await geocode(destination)
    if not dest_geo:
        return {"ok": False, "need": "destination",
                "message": f"Couldn't locate '{destination}'. Ask the user to clarify the address."}

    # Public transport: fetch bus-preferred AND rail-preferred routes, and for
    # each mode up to TWO consecutive real departures (this train and the next/
    # previous one) — probed the timetable-aware way: re-ask Google with
    # arrival_time = this departure's real arrival minus 1 minute. Every option
    # is a full door-to-door chain with its own leave-by. Other modes: 1 route.
    async def _departures(pref: str, count: int = 2) -> list:
        outs: list = []
        deadline = arrival_hhmm
        for _ in range(count):
            r = await directions(home_geo, dest_geo, pref, deadline)
            if not r:
                break
            if any(o.get("departAt") == r.get("departAt") for o in outs):
                break  # timetable exhausted — same trip again
            outs.append(r)
            arr = r.get("arriveAtReal")
            if not arr:
                break
            deadline = _sub_minutes(arr, 1)  # probe the previous departure
        return outs

    alternatives: list = []
    if transport in ("bus", "train", "transit"):
        import asyncio as _asyncio
        bus_opts, train_opts = await _asyncio.gather(_departures("bus", 3), _departures("train", 3))
        seen = set()
        for r in bus_opts + train_opts:
            sig = ((r.get("transit") or {}).get("line"), r.get("departAt"), r["minutes"])
            if sig in seen:
                continue
            seen.add(sig)
            alternatives.append(r)
        # Earliest departure first — reads like a timetable.
        alternatives.sort(key=lambda r: r.get("departAt") or "99:99")
        # Main plan = the latest departure that still arrives by the deadline
        # (least waiting at the destination); fallback: the fastest.
        on_time = [r for r in alternatives if (r.get("arriveAtReal") or arrival_hhmm) <= arrival_hhmm]
        route = (max(on_time, key=lambda r: r.get("departAt") or "") if on_time
                 else min(alternatives, key=lambda r: r["minutes"]) if alternatives else None)
    else:
        route = await directions(home_geo, dest_geo, transport, arrival_hhmm)
        cap = _SELF_POWERED_CAP.get(transport)
        if route and cap and route["minutes"] > cap:
            # A preference is not a constraint (CLAUDE.md rule 9). 29.10, live: Tel Aviv →
            # Haifa "by bike", 327 min, leave at 04:23. Past the cap, the plan is public
            # transport — and it says what was asked and why it changed.
            fallback = await plan_departure(destination, arrival_hhmm, home_address, "transit",
                                            routine_minutes, buffer_minutes, start_address)
            if fallback.get("ok"):
                fallback["plan"]["fallbackFrom"] = {"transport": transport, "minutes": route["minutes"]}
                fallback["plan"]["modeNote"] = (f"ב{_HE_MODE.get(transport, transport)} זה {route['minutes']} דק׳ — "
                                                f"תכננתי בתחבורה ציבורית")
                return fallback
    if not route:
        return {"ok": False, "message": "Couldn't get a route for that trip — ask the user to confirm address/mode."}

    travel = route["minutes"]
    # Anchor on the REAL departure when Google gave one (transit): departAt
    # already times the walk to meet the actual train/bus; buffer on top.
    if route.get("departAt"):
        leave_by = _sub_minutes(route["departAt"], buffer_minutes)
        arrive_actual = route.get("arriveAtReal") or arrival_hhmm
    else:
        leave_by = _sub_minutes(arrival_hhmm, travel + buffer_minutes)
        arrive_actual = arrival_hhmm
    # Wake time only makes sense from home (it includes the morning routine).
    wake_by = _sub_minutes(leave_by, routine_minutes) if from_home else None
    # Every public-transport alternative, summarized with its own leave time —
    # the agent presents these side by side and recommends the fastest (= plan).
    def _alt_leave(r: dict) -> str:
        return (_sub_minutes(r["departAt"], buffer_minutes) if r.get("departAt")
                else _sub_minutes(arrival_hhmm, r["minutes"] + buffer_minutes))

    alt_summaries = [
        {
            "transport": r.get("transport"),
            "modeLabel": r.get("modeLabel"),
            "travelMinutes": r["minutes"],
            "departAt": r.get("departAt"),
            "arriveAt": r.get("arriveAtReal") or arrival_hhmm,
            "leaveBy": _alt_leave(r),
            "transit": r.get("transit"),
            "legs": r.get("legs"),
            "routeText": _route_text(r.get("legs"), _alt_leave(r), r.get("arriveAtReal") or arrival_hhmm),
        }
        for r in alternatives
    ]
    return {
        "ok": True,
        "plan": {
            "startResolved": home_geo["formatted"],
            "fromHome": from_home,
            "destResolved": dest_geo["formatted"],
            "needsConfirm": home_geo["partial"] or dest_geo["partial"],
            "transport": route.get("transport", transport),
            "alternatives": alt_summaries,
            "mode": route["mode"],
            "modeLabel": route["modeLabel"],
            "transit": route.get("transit"),
            # Full leg-by-leg route (walk → bus → …) so the whole map — not just
            # the first-leg summary — can be persisted onto the task and shown later.
            "legs": route.get("legs"),
            "routeText": _route_text(route.get("legs"), leave_by, arrive_actual),
            "arriveActual": arrive_actual,
            "overviewPolyline": route.get("overviewPolyline"),
            "startLat": home_geo["lat"],
            "startLng": home_geo["lng"],
            "travelMinutes": travel,
            "bufferMinutes": buffer_minutes,
            "routineMinutes": routine_minutes if from_home else 0,
            "arriveBy": arrival_hhmm,
            "leaveHomeBy": leave_by,
            "wakeUpBy": wake_by,
            "lat": dest_geo["lat"],
            "lng": dest_geo["lng"],
            "destination": destination,
        },
    }
