"""route_proxy — Google Directions, asked by the server, with the server's key.

WHY THIS EXISTS

The APK's Maps key is restricted to `com.lumi.app` + a SHA-1 fingerprint. That
restriction is correct and must not be loosened. It is also unusable for web
service APIs: Google enforces an Android-app restriction through the
`X-Android-Package` and `X-Android-Cert` headers, and ONLY the Maps SDK sends
those. A plain `fetch()` from React Native sends neither, so every Directions
call from the phone came back:

    REQUEST_DENIED — This IP, site or mobile application is not authorized to
    use this API key. Request received from IP address 199.203.153.129, with
    empty referer

Read off her own device, 2026-09-22, for "7 HaPnina Street, Ra'anana" — the
interview. Her Google console recorded 107 such calls in a day at a 99% error
rate and a 9 ms median: rejected at the edge, before any routing ran. The app
had never once received a route, and the card said there was no train.

`/app/geocode` already exists for exactly this reason and says exactly this in
its docstring. Geocoding was moved; Directions was not.

WHAT THIS RETURNS, AND WHY IT IS RAW

Google's own response body, per query, untouched apart from pruning.

The temptation is to parse here and hand the app a tidy plan. That would put a
SECOND transit parser in the codebase, in a second language, and this project
has already paid for that: `server/clashes.py` and `src/utils/resolveClashes.ts`
have to be parity-tested against each other precisely because two
implementations of one rule drift. `src/utils/transitParse.ts` already ranks
alternatives the way Koral asked (on time → fewest rides → shortest → latest
departure), and `utils/transitFallback` applies direct-rail ‹ direct-bus ‹
mixed on top. None of that moves. The server becomes a door, not a brain.

So the app keeps its parser and gains a key that works.

FAST

- One HTTP round trip for several queries. The phone used to fire rail, bus and
  unconstrained separately; they now travel together and run concurrently here.
- A cache keyed on the question. Transit timetables do not change between two
  syncs fifteen minutes apart, and the same journey was being re-asked on every
  sync, of every screen focus, forever. A future date is stable for hours; today
  is re-asked more often because departures actually pass.

SECURE

- `Depends(app_auth.require_caller)` on the route: a Supabase token, verified by
  Supabase. Without it this is an open Directions proxy billed to her.
- Per-caller rate limit, so a client stuck in a loop cannot spend the quota.
- The key is read from `config.GOOGLE_MAPS_API_KEY` (a Fly secret) and never
  appears in a response.

Dependencies: config (GOOGLE_MAPS_API_KEY), httpx.
Consumed by routes_app.POST /app/route/directions.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import time
from typing import Any, Optional

import httpx

import config

logger = logging.getLogger(__name__)

DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json"

# One caller cannot ask for an unbounded fan-out. A day's chain is a handful of
# stops and each stop asks at most rail/bus/unconstrained.
MAX_QUERIES = 8

# Google's own timeout is generous; ours is not. A phone waiting on a route is
# a person looking at a spinner.
UPSTREAM_TIMEOUT_S = 12.0

# How long an answer stays good.
#
# A timetable for a future date does not move. Today's does not move either,
# but which departures are still AHEAD of you does, and that is what the app
# subtracts from — so today is re-asked far more often.
TTL_TODAY_S = 5 * 60
TTL_FUTURE_S = 6 * 60 * 60

# Bounded so a long-lived 256 MB machine cannot be filled by distinct journeys.
MAX_CACHE_ENTRIES = 500

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()

# Modes the app may ask for, mapped to Google's. Anything else is refused
# rather than passed through — this is a proxy for OUR app, not an open relay.
MODES = {"transit", "driving", "walking", "bicycling"}
TRANSIT_MODES = {"bus", "rail", "train", "subway", "tram"}


class RouteProxyError(Exception):
    """The request was not one we are willing to send."""


def _cache_key(params: dict) -> str:
    # The key excludes the API key: the answer does not depend on which of our
    # keys asked, and a secret has no business in a cache key.
    quiet = {k: v for k, v in sorted(params.items()) if k != "key"}
    return hashlib.sha256(json.dumps(quiet, sort_keys=True).encode()).hexdigest()


def _cache_get(key: str) -> Optional[dict]:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if not hit:
            return None
        expires, payload = hit
        if expires <= now:
            _cache.pop(key, None)
            return None
        return payload


def _cache_put(key: str, payload: dict, ttl: float) -> None:
    now = time.monotonic()
    with _cache_lock:
        _cache[key] = (now + ttl, payload)
        if len(_cache) > MAX_CACHE_ENTRIES:
            # Drop what has already expired first; if that is not enough, drop
            # the soonest to expire. Never drop at random — the entry a user is
            # about to reuse is the one that just went in.
            for k in [k for k, (exp, _) in _cache.items() if exp <= now]:
                _cache.pop(k, None)
            while len(_cache) > MAX_CACHE_ENTRIES:
                oldest = min(_cache.items(), key=lambda kv: kv[1][0])[0]
                _cache.pop(oldest, None)


def cache_clear() -> None:
    """Forget every cached route. For tests, and for nothing else."""
    with _cache_lock:
        _cache.clear()


# Fields the app's parser never reads, and which dominate the payload size.
#
# `overview_polyline` IS kept: RouteMap draws it, and dropping it is how the
# map went blank once before. Per-step polylines and the HTML directions blob
# are what actually bloat a transit response with alternatives.
def _prune(data: dict) -> dict:
    for route in data.get("routes") or []:
        route.pop("warnings", None)
        route.pop("bounds", None)
        for leg in route.get("legs") or []:
            for step in leg.get("steps") or []:
                step.pop("polyline", None)
                step.pop("html_instructions", None)
                step.pop("maneuver", None)
                # A transit step's nested walking directions are a whole second
                # itinerary that nothing renders.
                step.pop("steps", None)
    return data


def build_params(q: dict, origin: str, destination: str,
                 arrival_epoch: Optional[int]) -> dict:
    """One query dict → Google's query string. Raises on anything unexpected."""
    mode = str(q.get("mode") or "transit").lower()
    if mode not in MODES:
        raise RouteProxyError(f"unsupported mode {mode!r}")
    params: dict[str, Any] = {
        "origin": origin,
        "destination": destination,
        "mode": mode,
        "alternatives": "true",
        "region": "il",
        # Hebrew station and street names — what she actually reads on a sign.
        "language": "he",
    }
    transit_mode = q.get("transit_mode")
    if transit_mode:
        parts = [p.strip() for p in str(transit_mode).split("|") if p.strip()]
        bad = [p for p in parts if p not in TRANSIT_MODES]
        if bad:
            raise RouteProxyError(f"unsupported transit_mode {bad[0]!r}")
        if mode != "transit":
            raise RouteProxyError("transit_mode only applies to mode=transit")
        params["transit_mode"] = "|".join(parts)
    # `arrival_time` is a TRANSIT parameter. Google rejects it for driving,
    # which takes `departure_time` instead and uses it to pick a traffic model
    # — asking about an 08:00 commute at 22:00 returns a free-flowing road.
    depart_epoch = q.get("depart_epoch")
    if mode == "transit":
        if arrival_epoch is not None:
            params["arrival_time"] = str(arrival_epoch)
        elif depart_epoch is not None:
            # "The next departures after HH:MM" — how the phone walks the
            # timetable when she is still home and the planned bus has gone.
            # Without it every probe was "now" and the list stopped at one.
            try:
                params["departure_time"] = str(int(depart_epoch))
            except (TypeError, ValueError) as exc:
                raise RouteProxyError("depart_epoch must be a unix timestamp") from exc
    elif mode == "driving":
        if depart_epoch is not None:
            try:
                params["departure_time"] = str(int(depart_epoch))
            except (TypeError, ValueError) as exc:
                raise RouteProxyError("depart_epoch must be a unix timestamp") from exc
        else:
            params["departure_time"] = "now"
    # Walking and cycling do not depend on when you set off, so neither is sent.
    return params


async def _one(client: httpx.AsyncClient, params: dict, ttl: float) -> dict:
    """One Directions call, cached, with Google's verdict preserved."""
    key = _cache_key(params)
    cached = _cache_get(key)
    if cached is not None:
        return {**cached, "cached": True}

    try:
        r = await client.get(DIRECTIONS_URL, params=params)
        data = r.json()
    except (httpx.HTTPError, ValueError) as exc:
        # NOT cached: a dropped connection is not an answer about the world,
        # and caching it would turn one bad moment into five stale minutes.
        logger.warning("directions transport error: %s", exc)
        return {
            "status": "UPSTREAM_ERROR",
            "error_message": str(exc),
            "data": None,
            "cached": False,
        }

    status = str(data.get("status") or "")
    out = {
        "status": status,
        "error_message": data.get("error_message"),
        "data": _prune(data) if status == "OK" else None,
        "cached": False,
    }
    if status != "OK":
        # Logged at WARNING with the reason, because this is the exact class of
        # event that was invisible for 107 calls.
        logger.warning("directions %s -> %s [%s] %s",
                       params.get("origin"), params.get("destination"),
                       status, data.get("error_message") or "")
    # ZERO_RESULTS is a real, stable answer — there is no bus — and caching it
    # stops us re-asking a question the timetable already refused. A refusal
    # (REQUEST_DENIED, OVER_QUERY_LIMIT) is about US and may be fixed at any
    # moment, so it is never cached.
    if status in ("OK", "ZERO_RESULTS"):
        _cache_put(key, {k: v for k, v in out.items() if k != "cached"}, ttl)
    return out


async def directions_batch(origin: str, destination: str,
                           queries: list[dict],
                           arrival_epoch: Optional[int],
                           ttl: float) -> list[dict]:
    """Every query, concurrently, each carrying its own verdict.

    Never raises for an individual query: a caller asking rail + bus + any
    wants all three answers, including "that one was refused", which is the
    whole point (see utils/routeFailure.worstFailure on the app side — a
    refusal must outrank two ZERO_RESULTS rather than average into a lie).
    """
    if not config.GOOGLE_MAPS_API_KEY:
        return [{"status": "NO_SERVER_KEY", "error_message":
                 "GOOGLE_MAPS_API_KEY is not set on the server",
                 "data": None, "cached": False} for _ in queries]

    built = []
    for q in queries:
        try:
            built.append((build_params(q, origin, destination, arrival_epoch), None))
        except RouteProxyError as exc:
            built.append((None, str(exc)))

    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S) as client:
        tasks = []
        for params, err in built:
            if params is None:
                async def refused(msg=err):
                    return {"status": "BAD_REQUEST", "error_message": msg,
                            "data": None, "cached": False}
                tasks.append(refused())
            else:
                tasks.append(_one(client, {**params, "key": config.GOOGLE_MAPS_API_KEY}, ttl))
        results = await asyncio.gather(*tasks, return_exceptions=True)

    out: list[dict] = []
    for i, res in enumerate(results):
        if isinstance(res, BaseException):
            logger.error("directions query %d crashed: %s", i, res)
            out.append({"status": "UPSTREAM_ERROR", "error_message": str(res),
                        "data": None, "cached": False})
        else:
            # The key must never travel back out, not even by accident.
            res.pop("key", None)
            out.append(res)
    return out


def ttl_for(date_iso: str, today_iso: str) -> float:
    """How long this date's answer stays good."""
    return TTL_TODAY_S if date_iso <= today_iso else TTL_FUTURE_S
