"""geo.find_place (behaviour B) — Places TextSearch, mocked (no network).

Pins yesterday's fix: resolve a business NAME to a real address instead of
letting the model invent one. OK -> {name, formatted, lat, lng, place_id};
non-OK status or missing API key -> None.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import asyncio  # noqa: E402
import geo  # noqa: E402


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    """Async-context-manager stand-in for httpx.AsyncClient whose .get returns
    a fixed JSON payload."""
    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, params=None):
        return _FakeResp(self._payload)


def _patched_client(payload):
    return mock.patch.object(geo.httpx, "AsyncClient",
                             lambda *a, **k: _FakeClient(payload))


class FindPlaceTests(unittest.TestCase):
    def setUp(self):
        # find_place caches (misses too) — each test asks Google afresh.
        geo._place_cache.clear()

    OK_PAYLOAD = {
        "status": "OK",
        "results": [{
            "name": "MER Group",
            "formatted_address": "Yahadut Canada 5, Or Yehuda",
            "geometry": {"location": {"lat": 32.03, "lng": 34.85}},
            "place_id": "PID123",
        }],
    }

    def test_ok_returns_place_fields(self):
        with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "dummy"), \
                _patched_client(self.OK_PAYLOAD):
            res = asyncio.run(geo.find_place("MER Group"))
        self.assertEqual(res, {
            "name": "MER Group",
            "formatted": "Yahadut Canada 5, Or Yehuda",
            "lat": 32.03, "lng": 34.85, "place_id": "PID123",
        })

    def test_non_ok_status_returns_none(self):
        payload = {"status": "ZERO_RESULTS", "results": []}
        with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "dummy"), \
                _patched_client(payload):
            self.assertIsNone(asyncio.run(geo.find_place("nowhere ltd")))

    def test_request_denied_returns_none(self):
        payload = {"status": "REQUEST_DENIED"}
        with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "dummy"), \
                _patched_client(payload):
            self.assertIsNone(asyncio.run(geo.find_place("MER Group")))

    def test_missing_api_key_returns_none(self):
        with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", ""):
            self.assertIsNone(asyncio.run(geo.find_place("MER Group")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
