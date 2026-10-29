"""Errands on the way — places for a to-do that sit ON her route and are OPEN
when she passes them.

Koral, 29.9: "if the task is 'fix my coffee machine' — suggest places on the
way (you know the travel routes) that are open at the hours I pass by them.
Same for car washes, picking up mail, clinic visits, groceries…"

Meira already knows each planned journey: its line on the map (the route's
encoded polyline) and when she leaves and arrives. So an errand with no place
and no hour can be answered with a real plan: "Tikun Mechonot, 300 m off your
route, open when you pass at 17:40."

FOUR STEPS
1. UNDERSTAND (Nemotron Nano): is this an errand done AT a business, and what
   to search for — in Hebrew and English ("fix my coffee machine" → "coffee
   machine repair" / "תיקון מכונות קפה"). The recalled memory tailors it ("her
   clinic is Maccabi"). Not an errand ("write the report") → no search at all.
2. SAMPLE the route: a handful of points along the polyline, each with the
   minute she passes it (linear in distance between leave and arrive).
3. SEARCH near each point (Places Text Search, location + radius) and read the
   OPENING HOURS for that weekday (Place Details) — "open now" is the wrong
   question at 09:00 for a 17:40 pass.
4. RANK: open when she passes first, then closest to the line. Top 3.

Nothing is invented: every candidate is a Google place with a place_id, and
"open when you pass" is computed from Google's own periods. A place whose hours
Google does not know says so ("hours unknown") rather than being called open.

Every failure has its own reason (CLAUDE.md rule 1): not an errand, no route,
Places refused (the key), nothing found near the route, nothing open.
"""
from __future__ import annotations

import json
import re
import logging
import math
from datetime import date as _date
from typing import Optional

import httpx

import ai_gate
import config
import geo
import llm_usage
import model_router

logger = logging.getLogger(__name__)

_TEXTSEARCH = "https://maps.googleapis.com/maps/api/place/textsearch/json"
_DETAILS = "https://maps.googleapis.com/maps/api/place/details/json"
_SAMPLES = 4          # points along a route
_RADIUS_M = 700       # how far off the line counts as "on the way"
_TOP = 3


# ── 1. understand ───────────────────────────────────────────────────────────

_SYSTEM = """Decide whether a to-do is an ERRAND done at a business or public \
place (repair shop, car wash, post office, clinic, pharmacy, grocery, bank, \
dry cleaner, hardware store…) and what to search for on a map.

If it CAN be done at a business, it IS an errand — she decides whether to go:
- laundry / כביסה → laundromat or dry cleaner (מכבסה / ניקוי יבש)
- fix / repair X → a repair shop for X
- mail / parcel / חבילה → post office or pickup point
- haircut, printing, key copy, car wash, pharmacy, groceries, gifts → the shop
Not an errand: work, study, calls, meetings with a person, things that only \
happen at home (cooking, cleaning the flat).

Queries: what a MAP search needs to find such a place — a business type, not \
the task sentence. Give both Hebrew and English. Use the MEMORY block (her \
health fund, her usual supermarket…) to be specific when it applies.

Return JSON only:
{"errand": true|false, "query_he": "", "query_en": "", "minutes": 15, "why": "<=10 words"}"""


# The errands any city has a shop for, by their words — code, not the model.
# 1.10: the model answered "not an errand" for "לתקן את מכונת הקפה", the very
# example this module was built for, and that "no" was final. A rule hit now
# overrules a refusal; the model still writes the query for anything else.
_RULES = [
    (r"(?:^|\s)(?:לתקן|תיקון|fix|repair)\s+(?:את\s+|my\s+|the\s+)?(.+)", "תיקון {o}", "{o} repair"),
    (r"(?:חבילה|דואר|parcel|package|post office)", "דואר ישראל", "post office"),
    (r"(?:כביסה|ניקוי יבש|laundry|dry clean)", "מכבסה", "laundromat"),
    (r"(?:תספורת|מספרה|haircut|barber)", "מספרה", "barber"),
    (r"(?:להדפיס|הדפסה|print)", "דפוס", "print shop"),
    (r"(?:מפתח|key cut|copy a key)", "שכפול מפתחות", "key cutting"),
    (r"(?:שטיפת רכב|לשטוף את הרכב|car wash)", "שטיפת רכב", "car wash"),
    (r"(?:בית מרקחת|תרופ|pharmacy|prescription)", "בית מרקחת", "pharmacy"),
    (r"(?:סופר|מכולת|groceries|supermarket)", "סופרמרקט", "supermarket"),
    (r"(?:מתנה|gift)", "חנות מתנות", "gift shop"),
    (r"(?:^|\s)(?:לקנות|buy)\s+(?:את\s+|a\s+|an\s+|the\s+)?(.+)", "{o}", "{o}"),
]


def rule_understand(text: str) -> Optional[dict]:
    t = str(text or "").strip()
    for pattern, he, en in _RULES:
        m = re.search(pattern, t, re.IGNORECASE)
        if not m:
            continue
        obj = (m.group(1) if m.groups() else "").strip(" .,!?") if m.groups() else ""
        hebrew = bool(re.search(r"[\u0590-\u05FF]", obj))
        # One language per query: a Hebrew object never goes in the English one.
        q_he = he.format(o=obj).strip() if (hebrew or "{o}" not in he) else ""
        q_en = en.format(o=obj).strip() if (not hebrew or "{o}" not in en) else ""
        return {"errand": True, "query_he": q_he, "query_en": q_en, "minutes": 20, "why": "rule"}
    return None


async def understand(text: str, memory: str = "") -> Optional[dict]:
    got = await _model_understand(text, memory)
    if got and got.get("errand"):
        return got
    return rule_understand(text) or got


async def _model_understand(text: str, memory: str = "") -> Optional[dict]:

    user = f"TO-DO: {text}\n" + (f"\nMEMORY (private):\n{memory[:600]}\n" if memory else "")
    model = model_router.pick("errand_understand", prompt_chars=len(_SYSTEM) + len(user))
    client = ai_gate.client()
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}],
            temperature=0.1, max_tokens=300,
            response_format={"type": "json_object"}, timeout=30,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("errands_along understand failed: %s", exc)
        return None
    usage = getattr(resp, "usage", None)
    if usage:
        llm_usage.record("errand_understand", usage.prompt_tokens or 0, usage.completion_tokens or 0, model)
    try:
        raw = json.loads(resp.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        return None
    q_he = str(raw.get("query_he") or "").strip()
    q_en = str(raw.get("query_en") or "").strip()
    return {
        "errand": bool(raw.get("errand")) and bool(q_he or q_en),
        "query_he": q_he, "query_en": q_en,
        "minutes": int(raw.get("minutes") or 15) if str(raw.get("minutes") or "").isdigit() else 15,
        "why": str(raw.get("why") or "")[:80],
    }


# ── 2. the route ────────────────────────────────────────────────────────────

def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Google's encoded polyline → [(lat, lng)]."""
    points, index, lat, lng = [], 0, 0, 0
    while index < len(encoded):
        for is_lng in (False, True):
            shift, result = 0, 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if is_lng:
                lng += delta
            else:
                lat += delta
        points.append((lat / 1e5, lng / 1e5))
    return points


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _hhmm_to_min(s: str) -> Optional[int]:
    try:
        h, m = s.split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def _min_to_hhmm(m: int) -> str:
    m %= 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def samples(points: list[tuple[float, float]], leave: str, arrive: str,
            n: int = _SAMPLES) -> list[dict]:
    """n points spread by DISTANCE along the route, each with its pass time."""
    if len(points) < 2:
        return []
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + metres(a, b))
    total = cum[-1] or 1.0
    t0, t1 = _hhmm_to_min(leave), _hhmm_to_min(arrive)
    if t0 is None or t1 is None:
        return []
    if t1 < t0:
        t1 += 1440
    out = []
    for k in range(n):
        frac = (k + 0.5) / n
        target = frac * total
        i = next((j for j, c in enumerate(cum) if c >= target), len(cum) - 1)
        out.append({"lat": points[i][0], "lng": points[i][1],
                    "pass_at": _min_to_hhmm(round(t0 + frac * (t1 - t0)))})
    return out


def distance_to_route(p: tuple[float, float], points: list[tuple[float, float]]) -> float:
    """Metres from p to the nearest vertex — close enough for a 700 m radius."""
    return min(metres(p, q) for q in points) if points else float("inf")


# ── 3. opening hours ────────────────────────────────────────────────────────

def open_at(periods: Optional[list], day: _date, hhmm: str) -> Optional[bool]:
    """Google 'periods' → is it open at hhmm on `day`? None when unknown.

    Google numbers days 0=Sunday; Python's weekday() is 0=Monday. A period with
    no close is open 24h. A period may run past midnight (close.day differs).
    """
    if not periods:
        return None
    gday = (day.weekday() + 1) % 7
    t = _hhmm_to_min(hhmm)
    if t is None:
        return None
    week_t = gday * 1440 + t
    for p in periods:
        o = p.get("open") or {}
        c = p.get("close")
        if c is None and o.get("time") == "0000":
            return True
        try:
            ot = int(o["day"]) * 1440 + int(o["time"][:2]) * 60 + int(o["time"][2:])
            ct = int(c["day"]) * 1440 + int(c["time"][:2]) * 60 + int(c["time"][2:])
        except (KeyError, TypeError, ValueError):
            continue
        if ct <= ot:
            ct += 7 * 1440
        for wt in (week_t, week_t + 7 * 1440):
            if ot <= wt < ct:
                return True
    return False


# ── 4. search ───────────────────────────────────────────────────────────────

PlacesRefused = geo.PlacesRefused


async def _nearby(client: httpx.AsyncClient, query: str, lat: float, lng: float) -> list[dict]:
    return await geo.places_near(client, query, lat, lng, _RADIUS_M)


async def _details(client: httpx.AsyncClient, place_id: str) -> dict:
    """Hours (periods + the human weekday lines), price level, rating."""
    params = {"place_id": place_id,
              "fields": "opening_hours,price_level,rating,user_ratings_total",
              "language": "he", "key": config.GOOGLE_MAPS_API_KEY}
    try:
        r = await client.get(_DETAILS, params=params)
        res = (r.json() or {}).get("result") or {}
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("errands_along details failed: %s", exc)
        return {}
    oh = res.get("opening_hours") or {}
    return {"periods": oh.get("periods"), "weekday_text": oh.get("weekday_text") or [],
            "price_level": res.get("price_level"), "rating": res.get("rating"),
            "reviews": res.get("user_ratings_total")}


def hours_today(weekday_text: list, day: _date) -> str:
    """Google's weekday_text runs Monday..Sunday; the line for `day`, minus the day name."""
    if len(weekday_text) != 7:
        return ""
    line = weekday_text[day.weekday()]
    return line.split(":", 1)[1].strip() if ":" in line else line


def score(c: dict) -> float:
    """Better rating first, then closer to the line (1 km off costs a star) —
    and a leg AFTER an event beats the leg TO one: a stop on the way to an
    interview is a stop that can make her late (Koral, 1.10: "after the
    interview, because I'm in Ra'anana")."""
    return ((c.get("rating") or 4.0) - (c.get("off_route_m") or 0) / 1000.0
            + (1.5 if c.get("after") else 0.0))


async def along(task_text: str, trips: list[dict], *, memory: str = "",
                plan: Optional[dict] = None, user_key: Optional[str] = None,
                prices: bool = True) -> dict:
    """{ok, query, candidates[]} or {ok: false, reason}.

    trips: [{polyline, leave: "HH:MM", arrive: "HH:MM", date: "YYYY-MM-DD",
             label?: str}] — the journeys Meira already planned.
    """
    if not (task_text or "").strip():
        return {"ok": False, "reason": "no_task"}
    usable = [t for t in trips or [] if t.get("polyline") and t.get("leave") and t.get("arrive")]
    if not usable:
        return {"ok": False, "reason": "no_route"}
    if not config.GOOGLE_MAPS_API_KEY:
        return {"ok": False, "reason": "places_not_configured"}

    p = plan or await understand(task_text, memory)
    if p is None:
        return {"ok": False, "reason": "understand_failed"}
    if not p["errand"]:
        return {"ok": False, "reason": "not_an_errand", "why": p["why"]}
    query = p["query_he"] or p["query_en"]

    found: dict[str, dict] = {}
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            for trip in usable[:3]:
                pts = decode_polyline(trip["polyline"])
                for s in samples(pts, trip["leave"], trip["arrive"]):
                    for r in await _nearby(client, query, s["lat"], s["lng"]):
                        pid = r.get("place_id")
                        loc = (r.get("geometry") or {}).get("location") or {}
                        if not pid or pid in found or "lat" not in loc:
                            continue
                        off = distance_to_route((loc["lat"], loc["lng"]), pts)
                        if off > _RADIUS_M:
                            continue
                        found[pid] = {
                            "place_id": pid,
                            "name": r.get("name"),
                            "address": r.get("formatted_address"),
                            "lat": loc["lat"], "lng": loc["lng"],
                            "rating": r.get("rating"),
                            "off_route_m": round(off),
                            "pass_at": s["pass_at"],
                            "date": trip.get("date"),
                            "trip": trip.get("label") or "",
                            "after": bool(trip.get("after")),
                        }
            if not found:
                return {"ok": False, "reason": "nothing_on_route", "query": query}
            # Hours only for the closest few: Details is a paid call per place.
            shortlist = sorted(found.values(), key=lambda c: c["off_route_m"])[:6]
            for c in shortlist:
                d = await _details(client, c["place_id"])
                try:
                    day = _date.fromisoformat(c["date"]) if c.get("date") else _date.today()
                except ValueError:
                    day = _date.today()
                c["open_when_passing"] = open_at(d.get("periods"), day, c["pass_at"])
                c["hours_today"] = hours_today(d.get("weekday_text") or [], day)
                c["price_level"] = d.get("price_level")
                if d.get("rating") is not None:
                    c["rating"] = d["rating"]
                c["reviews"] = d.get("reviews")
    except PlacesRefused as exc:
        logger.error("errands_along: Places refused the server key — %s", exc)
        return {"ok": False, "reason": "places_refused", "detail": str(exc)}
    except httpx.HTTPError as exc:
        logger.warning("errands_along: Places unreachable — %s", exc)
        return {"ok": False, "reason": "places_unreachable"}

    # Her own verdicts (feedback_store): a place she liked moves up, one she
    # turned down sinks below everything she has not judged. None → as before.
    verdict: dict[str, Optional[str]] = {}
    if user_key:
        try:
            import feedback_store
            for c in shortlist:
                verdict[c["place_id"]] = feedback_store.place_verdict(user_key, c["place_id"])
                if verdict[c["place_id"]]:
                    c["your_verdict"] = verdict[c["place_id"]]
        except Exception as exc:  # noqa: BLE001 — ranking without her verdicts, not no ranking
            logger.warning("errands_along: verdicts unavailable: %s", exc)
    rank = {True: 0, None: 1, False: 2}
    ordered = sorted(shortlist, key=lambda c: (
        rank[c["open_when_passing"]],
        1 if verdict.get(c["place_id"]) == "down" else 0,
        -(score(c) + (1.0 if verdict.get(c["place_id"]) == "up" else 0.0)),
    ))
    if all(c["open_when_passing"] is False for c in ordered):
        return {"ok": False, "reason": "nothing_open_when_passing", "query": query,
                "closed": ordered[:_TOP]}
    top = [c for c in ordered if c["open_when_passing"] is not False][:_TOP]
    # One recommendation, with the reason in words she can check.
    # Never recommend a place she turned down.
    best = next((c for c in top if verdict.get(c["place_id"]) != "down"), None)
    if best:
        best["recommended"] = True
        best["why"] = [w for w in (
            "you liked it before" if verdict.get(best["place_id"]) == "up" else None,
            "open_when_passing" if best["open_when_passing"] else None,
            f"rating {best['rating']}" if best.get("rating") else None,
            f"{best['off_route_m']} m off route",
        ) if w]
    # What it costs, from the web — each price verified against its source.
    # `prices=False`: a caller that only needs to know WHICH place is on the way
    # (the Add screen's suggestion row) does not pay for web searches per place.
    if prices:
        try:
            import errand_prices
            await errand_prices.enrich(top, p["query_he"] or p["query_en"] or query)
            if best and best.get("price"):
                best["why"].append(f"price {best['price']['price']}")
        except Exception as exc:  # noqa: BLE001 — prices are a bonus, the route is the answer
            logger.warning("errands_along: prices skipped: %s", exc)
    for c in top:
        c["maps_url"] = f"https://www.google.com/maps/search/?api=1&query={c['lat']},{c['lng']}&query_place_id={c['place_id']}"
    return {"ok": True, "query": query, "minutes": p["minutes"], "candidates": top}
