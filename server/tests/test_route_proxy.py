"""The Directions proxy: the door that replaces a key the phone cannot use.

The APK's Maps key is restricted to `meira.secretary` + SHA-1, which Google
enforces through headers only the Maps SDK sends. Every Directions call from a
React Native `fetch()` therefore came back REQUEST_DENIED — 107 of them in one
day on her device, at a 99% error rate, while the card said there was no train.

These tests pin the three things that make the replacement safe rather than
merely working: it refuses what it will not relay, it never caches a refusal,
and Google's verdict survives the extra hop intact.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import route_proxy  # noqa: E402
import tz as _tz  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_cache():
    route_proxy.cache_clear()
    yield
    route_proxy.cache_clear()


# ── it is a proxy for OUR app, not an open relay ──────────────────────────
def test_refuses_an_unknown_mode():
    with pytest.raises(route_proxy.RouteProxyError):
        route_proxy.build_params({"mode": "teleport"}, "A", "B", None)


def test_refuses_an_unknown_transit_mode():
    with pytest.raises(route_proxy.RouteProxyError):
        route_proxy.build_params(
            {"mode": "transit", "transit_mode": "hoverboard"}, "A", "B", None)


def test_refuses_transit_mode_on_a_road_query():
    # Google ignores it silently, which is how a "train" preference could look
    # honoured while a car route came back.
    with pytest.raises(route_proxy.RouteProxyError):
        route_proxy.build_params(
            {"mode": "driving", "transit_mode": "rail"}, "A", "B", None)


def test_the_key_is_never_part_of_a_cache_key():
    a = route_proxy._cache_key({"origin": "A", "key": "SECRET-1"})
    b = route_proxy._cache_key({"origin": "A", "key": "SECRET-2"})
    assert a == b


# ── arrival_time is a TRANSIT parameter ───────────────────────────────────
def test_transit_gets_arrival_time_and_driving_does_not():
    transit = route_proxy.build_params({"mode": "transit"}, "A", "B", 1790163000)
    assert transit["arrival_time"] == "1790163000"
    assert "departure_time" not in transit

    # Google rejects arrival_time for driving; it takes departure_time, which
    # is also what selects the traffic model.
    driving = route_proxy.build_params({"mode": "driving"}, "A", "B", 1790163000)
    assert "arrival_time" not in driving
    assert driving["departure_time"] == "now"

    timed = route_proxy.build_params(
        {"mode": "driving", "depart_epoch": 1790163000}, "A", "B", None)
    assert timed["departure_time"] == "1790163000"


def test_transit_can_depart_at_a_time_when_no_arrival_is_asked():
    # Still home, the planned bus gone: the phone asks for the departures
    # after a moment, one probe at a time.
    nxt = route_proxy.build_params(
        {"mode": "transit", "transit_mode": "bus", "depart_epoch": 1790163000}, "A", "B", None)
    assert nxt["departure_time"] == "1790163000"
    assert "arrival_time" not in nxt
    # An arrival deadline still wins: Google takes one or the other.
    both = route_proxy.build_params(
        {"mode": "transit", "depart_epoch": 1790160000}, "A", "B", 1790163000)
    assert both["arrival_time"] == "1790163000" and "departure_time" not in both


def test_walking_carries_no_time_at_all():
    walk = route_proxy.build_params({"mode": "walking"}, "A", "B", 1790163000)
    assert "arrival_time" not in walk and "departure_time" not in walk


# ── the arrival instant is Israel time, not the server's zone ─────────────
def test_arrival_epoch_is_israel_time():
    # The interview: 2026-09-23 14:30 in Ra'anana. Built from a naive datetime
    # this becomes 14:30 in whatever region Fly scheduled the machine — three
    # hours out, and a route for the wrong part of the timetable.
    from datetime import datetime

    epoch = _tz.epoch_il("2026-09-23", "14:30")
    assert epoch is not None
    back = datetime.fromtimestamp(epoch, _tz.IL)
    assert (back.year, back.month, back.day) == (2026, 9, 23)
    assert (back.hour, back.minute) == (14, 30)


def test_a_time_that_does_not_parse_is_none_not_now():
    assert _tz.epoch_il("not-a-date", "14:30") is None
    assert _tz.epoch_il("2026-09-23", "half past two") is None


# ── caching: a stable answer yes, a refusal never ─────────────────────────
@pytest.mark.asyncio
async def test_zero_results_is_cached_but_request_denied_is_not(monkeypatch):
    calls: list[str] = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None):
            calls.append(params.get("transit_mode", "any"))
            if params.get("transit_mode") == "rail":
                return FakeResponse({"status": "ZERO_RESULTS", "routes": []})
            return FakeResponse({
                "status": "REQUEST_DENIED",
                "error_message": "This IP, site or mobile application is not "
                                 "authorized to use this API key.",
            })

    monkeypatch.setattr(route_proxy.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(route_proxy.config, "GOOGLE_MAPS_API_KEY", "test-key")

    queries = [{"mode": "transit", "transit_mode": "rail"},
               {"mode": "transit", "transit_mode": "bus"}]

    first = await route_proxy.directions_batch("A", "B", queries, 1790163000, ttl=300)
    assert [r["status"] for r in first] == ["ZERO_RESULTS", "REQUEST_DENIED"]
    assert all(r["cached"] is False for r in first)

    second = await route_proxy.directions_batch("A", "B", queries, 1790163000, ttl=300)
    # The timetable's "there is no train" is a stable fact and is reused.
    assert second[0]["cached"] is True
    # The refusal is about US and may be fixed at any moment. Caching it would
    # keep her routeless for the whole TTL after the fix landed.
    assert second[1]["cached"] is False
    assert calls.count("bus") == 2


@pytest.mark.asyncio
async def test_a_refusal_keeps_googles_own_words(monkeypatch):
    """The sentence on her screen is built from this. It must survive the hop."""
    message = ("This IP, site or mobile application is not authorized to use "
               "this API key. Request received from IP address "
               "199.203.153.129, with empty referer")

    class FakeResponse:
        def json(self):
            return {"status": "REQUEST_DENIED", "error_message": message}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None):
            return FakeResponse()

    monkeypatch.setattr(route_proxy.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(route_proxy.config, "GOOGLE_MAPS_API_KEY", "test-key")

    out = await route_proxy.directions_batch(
        "A", "B", [{"mode": "transit"}], None, ttl=300)
    assert out[0]["status"] == "REQUEST_DENIED"
    assert out[0]["error_message"] == message
    assert out[0]["data"] is None


@pytest.mark.asyncio
async def test_a_bad_query_does_not_take_the_good_ones_down(monkeypatch):
    class FakeResponse:
        def json(self):
            return {"status": "OK", "routes": [{"legs": [{"steps": []}]}]}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None):
            return FakeResponse()

    monkeypatch.setattr(route_proxy.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(route_proxy.config, "GOOGLE_MAPS_API_KEY", "test-key")

    out = await route_proxy.directions_batch(
        "A", "B",
        [{"mode": "transit"}, {"mode": "teleport"}, {"mode": "walking"}],
        None, ttl=300)
    assert [r["status"] for r in out] == ["OK", "BAD_REQUEST", "OK"]


@pytest.mark.asyncio
async def test_no_server_key_says_so_rather_than_looking_like_no_route(monkeypatch):
    monkeypatch.setattr(route_proxy.config, "GOOGLE_MAPS_API_KEY", "")
    out = await route_proxy.directions_batch(
        "A", "B", [{"mode": "transit"}, {"mode": "walking"}], None, ttl=300)
    assert [r["status"] for r in out] == ["NO_SERVER_KEY", "NO_SERVER_KEY"]
    # NOT ZERO_RESULTS, and NOT an empty list — either would be read as
    # "there is no way to get there", which is the bug this replaces.


# ── pruning keeps what the app draws ──────────────────────────────────────
def test_pruning_keeps_the_polyline_and_drops_the_bulk():
    data = {"routes": [{
        "overview_polyline": {"points": "abc"},
        "warnings": ["walk carefully"],
        "bounds": {"northeast": {}},
        "legs": [{"steps": [{
            "polyline": {"points": "xyz"},
            "html_instructions": "<b>Walk</b>",
            "steps": [{"polyline": {"points": "nested"}}],
            "travel_mode": "WALKING",
        }]}],
    }]}
    out = route_proxy._prune(data)
    route = out["routes"][0]
    # RouteMap draws this. Dropping it is how the map went blank once before.
    assert route["overview_polyline"]["points"] == "abc"
    assert "warnings" not in route and "bounds" not in route
    step = route["legs"][0]["steps"][0]
    assert "polyline" not in step
    assert "html_instructions" not in step
    assert "steps" not in step
    assert step["travel_mode"] == "WALKING"
