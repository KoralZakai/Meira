"""POST /app/place/search — the phone's Places lookups, asked by the server.

8.10: the profile's place picker and the train-interchange search asked Google
from the phone with the APK's key. That key is Android-restricted, so each call
was REQUEST_DENIED; and as long as it allowed a web-service API at all, anyone
who unzipped the APK could bill Places by copying two public headers. The phone
now asks the server, and the APK key keeps only Maps SDK for Android.
"""
from __future__ import annotations

import asyncio
import os
import sys
from unittest import mock

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import geo   # noqa: E402


def _google(body: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["key"] == "server-key"
        return httpx.Response(200, json=body)
    real = httpx.AsyncClient
    return mock.patch.object(geo.httpx, "AsyncClient",
                             lambda **kw: real(transport=httpx.MockTransport(handler)))


def test_hits_come_back_trimmed():
    body = {"status": "OK", "results": [
        {"name": "רכבת רעננה", "formatted_address": "רעננה", "geometry": {"location": {"lat": 32.1, "lng": 34.8}}},
        {"name": "no geometry"},
    ]}
    with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "server-key"), _google(body):
        out = asyncio.run(geo.text_search("רכבת רעננה", "train_station", 5000))
    assert out == [{"name": "רכבת רעננה", "address": "רעננה", "lat": 32.1, "lng": 34.8}]


def test_nothing_found_is_an_empty_list():
    with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "server-key"), _google({"status": "ZERO_RESULTS"}):
        assert asyncio.run(geo.text_search("x")) == []


def test_a_refused_key_is_not_nothing_found():
    with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "server-key"), \
            _google({"status": "REQUEST_DENIED", "error_message": "nope"}):
        with pytest.raises(geo.PlacesRefused):
            asyncio.run(geo.text_search("x"))


def test_no_server_key_is_a_refusal():
    with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", ""):
        with pytest.raises(geo.PlacesRefused):
            asyncio.run(geo.text_search("x"))


def test_the_gym_check_is_an_allowed_type():
    # 13.10: utils/gymCheck asks {type: "gym"}; the allow-list said only
    # stations, so the phone got "place search: bad_request" and the gym's
    # number was never checked.
    import re
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routes_app.py"),
               encoding="utf-8").read()
    allowed = re.search(r'place_type not in \(([^)]*)\)', src).group(1)
    assert '"gym"' in allowed
