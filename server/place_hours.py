"""place_hours — is this place open at that hour, on that day?

"Can I go to the dentist at 19:30?" was answered from the diary alone: the
evening was free, so the answer was yes. The clinic closes at 19:00. Nothing
anywhere in the app or the server knew a single opening hour, so every free
slot was offered as if every door in the country were open around the clock.

Hours come from Google Places, with the server's key (the APK's key is
restricted and must stay so):

  1. Text Search turns the name ("Dentist — Dizengoff Center") into a place_id.
  2. Place Details returns `current_opening_hours` — the next seven days,
     INCLUDING holidays and special hours, which is what matters on a Friday
     or on Chol HaMoed — and `opening_hours`, the regular week, used for any
     date further out.

What comes back is either the day's opening intervals or a REASON there are
none (silent-state rule 1): "not found", "no hours listed" and "Google refused
us" are different facts, and none of them is "open".

Pure helpers (`intervals_on`, `slot_verdict`) are split out so the arithmetic
of overnight periods and 24/7 places is testable without the network.

Dependencies: config (GOOGLE_MAPS_API_KEY), httpx, tz. Consumed by
routes_app (/app/place/hours) → the app's ScheduleQueryService.
"""
from __future__ import annotations

import logging
import time
from datetime import date as ddate
from typing import Optional

import httpx

import config

logger = logging.getLogger(__name__)

_CACHE_TTL_S = 6 * 3600
_cache: dict[tuple[str, str], tuple[float, dict]] = {}


def _hhmm(raw: str) -> str:
    raw = str(raw or "").zfill(4)
    return f"{raw[:2]}:{raw[2:4]}"


def google_weekday(date_iso: str) -> int:
    """Google's day numbering: 0 = Sunday … 6 = Saturday."""
    return (ddate.fromisoformat(date_iso).weekday() + 1) % 7


def intervals_on(periods: list, date_iso: str) -> list[list[str]]:
    """The opening intervals that touch `date_iso`, as [["HH:MM", "HH:MM"], …].

    - A period opening on this day and closing on a later one runs to 24:00.
    - A period that opened the day before and closes today runs from 00:00.
    - One period opening Sunday 00:00 with no close is Google's "open 24/7".
    Special-day periods carry a `date`; when any do, only those for this date
    count for it.
    """
    day = google_weekday(date_iso)
    if (len(periods) == 1 and not periods[0].get("close")
            and str(periods[0].get("open", {}).get("time", "")) == "0000"):
        return [["00:00", "24:00"]]
    dated = [p for p in periods if p.get("open", {}).get("date") or p.get("close", {}).get("date")]
    if dated:
        pool = [p for p in dated
                if p.get("open", {}).get("date") == date_iso or p.get("close", {}).get("date") == date_iso]
        if not pool:
            pool = [p for p in periods if not (p.get("open", {}).get("date"))]
    else:
        pool = periods
    out: list[list[str]] = []
    prev_day = (day - 1) % 7
    for p in pool:
        o, c = p.get("open") or {}, p.get("close") or {}
        if o.get("day") == day:
            closes = _hhmm(c.get("time")) if c and c.get("day") == day else "24:00"
            out.append([_hhmm(o.get("time")), closes])
        elif o.get("day") == prev_day and c and c.get("day") == day and _hhmm(c.get("time")) != "00:00":
            out.append(["00:00", _hhmm(c.get("time"))])
    return sorted(out)


def _m(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def slot_verdict(intervals: list[list[str]], start: str, end: str) -> dict:
    """Is [start, end) inside one opening interval?

    {"open": True} or {"open": False, "why": "closed_all_day" | "opens_later" |
    "closes_earlier" | "between_shifts", "opens", "closes"} — the hours she
    needs to pick another time.
    """
    if not intervals:
        return {"open": False, "why": "closed_all_day"}
    s, e = _m(start), _m(end)
    if e < s:
        e += 24 * 60
    for o, c in intervals:
        if _m(o) <= s and e <= _m(c):
            return {"open": True, "opens": o, "closes": c}
    first, last = intervals[0], intervals[-1]
    if s < _m(first[0]):
        return {"open": False, "why": "opens_later", "opens": first[0], "closes": first[1]}
    if s >= _m(last[1]) or e > _m(last[1]):
        return {"open": False, "why": "closes_earlier", "opens": last[0], "closes": last[1]}
    return {"open": False, "why": "between_shifts", "opens": first[0], "closes": last[1]}


async def hours_for(place: str, date_iso: str) -> dict:
    """{ok: True, name, address, intervals, source} or {ok: False, reason}."""
    place = str(place or "").strip()
    if not place:
        return {"ok": False, "reason": "no_place"}
    if not config.GOOGLE_MAPS_API_KEY:
        return {"ok": False, "reason": "not_configured"}
    key = (place.lower(), date_iso)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _CACHE_TTL_S:
        return hit[1]

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get(
                "https://maps.googleapis.com/maps/api/place/textsearch/json",
                params={"query": place, "key": config.GOOGLE_MAPS_API_KEY, "region": "il"})
            found = r.json()
            status = found.get("status")
            if status == "ZERO_RESULTS" or (status == "OK" and not found.get("results")):
                return _remember(key, {"ok": False, "reason": "not_found"})
            if status != "OK":
                logger.warning("place_hours search '%s' -> %s", place, status)
                return {"ok": False, "reason": "provider_failed", "detail": status}
            first = found["results"][0]
            r = await client.get(
                "https://maps.googleapis.com/maps/api/place/details/json",
                params={"place_id": first.get("place_id"), "key": config.GOOGLE_MAPS_API_KEY,
                        "fields": "name,formatted_address,business_status,"
                                  "opening_hours,current_opening_hours",
                        "language": "en"})
            details = r.json()
    except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
        logger.warning("place_hours failed for '%s': %s", place, exc)
        return {"ok": False, "reason": "provider_failed", "detail": str(exc)[:120]}

    if details.get("status") != "OK":
        logger.warning("place_hours details '%s' -> %s", place, details.get("status"))
        return {"ok": False, "reason": "provider_failed", "detail": details.get("status")}
    res = details.get("result") or {}
    base = {"name": res.get("name"), "address": res.get("formatted_address"),
            "business_status": res.get("business_status")}
    if res.get("business_status") == "CLOSED_PERMANENTLY":
        return _remember(key, {"ok": True, **base, "intervals": [], "source": "google",
                               "permanently_closed": True})
    current = (res.get("current_opening_hours") or {}).get("periods")
    regular = (res.get("opening_hours") or {}).get("periods")
    periods = None
    if current:
        # current_opening_hours covers the next seven days; a date further out
        # is answered from the regular week.
        in_window = any(p.get("open", {}).get("date") == date_iso for p in current)
        periods = current if in_window else regular or current
    else:
        periods = regular
    if not periods:
        return _remember(key, {"ok": False, "reason": "no_hours_listed", **base})
    return _remember(key, {"ok": True, **base, "intervals": intervals_on(periods, date_iso),
                           "source": "google"})


def _remember(key: tuple[str, str], value: dict) -> dict:
    _cache[key] = (time.time(), value)
    return value


def clear_cache() -> None:
    _cache.clear()


def _selfcheck() -> Optional[str]:
    week = [{"open": {"day": d, "time": "0800"}, "close": {"day": d, "time": "1900"}} for d in range(0, 5)]
    assert intervals_on(week, "2026-10-14") == [["08:00", "19:00"]]          # a Wednesday
    assert intervals_on(week, "2026-10-17") == []                            # Saturday: closed
    assert slot_verdict([["08:00", "19:00"]], "19:30", "20:15")["why"] == "closes_earlier"
    assert slot_verdict([["08:00", "19:00"]], "09:30", "10:15")["open"] is True
    assert intervals_on([{"open": {"day": 0, "time": "0000"}}], "2026-10-17") == [["00:00", "24:00"]]
    return None


if __name__ == "__main__":
    _selfcheck()
    print("place_hours self-check OK")
