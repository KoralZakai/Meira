"""POST /app/geocode — the door the phone needed and did not have.

The bug this closes: the app geocoded by calling Google directly with the key
compiled into the APK. That key is restricted, correctly, to four APIs that do
NOT include Geocoding, so every call came back REQUEST_DENIED, the app dropped
to the device geocoder, and `region=il` plus the box around her home — the only
reason the Google path existed — never ran. It failed as a warning in a log.

So the two things pinned here are: the bias actually reaches Google, and a
miss is reported as a plain "not found" rather than an error, because the
caller's fallback is what a miss is supposed to trigger.
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import geo  # noqa: E402


class GeocodeBoundsTests(unittest.TestCase):
    """geo.geocode must pass the home box through to Google."""

    @staticmethod
    def _capture(sent: dict):
        class _Resp:
            @staticmethod
            def json():
                return {"status": "OK", "results": [{
                    "formatted_address": "Yigal Alon 94, Tel Aviv",
                    "geometry": {"location": {"lat": 32.07, "lng": 34.79},
                                 "location_type": "ROOFTOP"},
                    "place_id": "p1"}]}

        class _Client:
            def __init__(self, *args, **kwargs):  # httpx.AsyncClient(timeout=…)
                pass

            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, url, params=None):
                sent.update(params or {})
                return _Resp()
        return _Client

    def test_bounds_and_region_reach_google(self):
        sent: dict = {}
        with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "k"), \
                mock.patch.object(geo.httpx, "AsyncClient", self._capture(sent)):
            hit = asyncio.run(geo.geocode("יגאל אלון 94", bounds="32,34|33,35"))
        self.assertEqual(hit["lat"], 32.07)
        self.assertEqual(sent["bounds"], "32,34|33,35")
        self.assertEqual(sent["region"], "il", "the Israel hint is the whole point")

    def test_no_bounds_means_no_bounds_param(self):
        """Without a home we must not send an empty box — Google treats a
        malformed viewport as an error, which would turn a working geocode
        into a failure for every user who has not set a home address."""
        sent: dict = {}
        with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", "k"), \
                mock.patch.object(geo.httpx, "AsyncClient", self._capture(sent)):
            asyncio.run(geo.geocode("יגאל אלון 94"))
        self.assertNotIn("bounds", sent)

    def test_no_key_is_none_not_a_crash(self):
        with mock.patch.object(geo.config, "GOOGLE_MAPS_API_KEY", ""):
            self.assertIsNone(asyncio.run(geo.geocode("anywhere")))


class GeocodeRouteTests(unittest.TestCase):
    def setUp(self):
        import routes_app
        self.routes_app = routes_app

    def _call(self, body):
        """Invoke the route function directly, past FastAPI's DI."""
        class _Req:
            def __init__(self, payload): self._payload = payload
            async def body(self): return b"{}" if self._payload else b""
            async def json(self): return self._payload
        return asyncio.run(self.routes_app.geocode_route(
            _Req(body), caller={"key": "user-a"}))

    def test_an_empty_address_is_rejected(self):
        res = self._call({"address": "   "})
        self.assertEqual(res.status_code, 400)

    def test_a_miss_is_not_found_not_an_error(self):
        async def _none(address, bounds=None):
            return None
        with mock.patch.object(self.routes_app.geo, "geocode", _none):
            res = self._call({"address": "nowhere at all"})
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "not_found")

    def test_a_hit_returns_coordinates_and_forwards_the_bounds(self):
        seen = {}

        async def _hit(address, bounds=None):
            seen["address"], seen["bounds"] = address, bounds
            return {"formatted": "Yigal Alon 94", "lat": 32.07, "lng": 34.79,
                    "place_id": "p1", "partial": False}

        with mock.patch.object(self.routes_app.geo, "geocode", _hit):
            res = self._call({"address": "יגאל אלון 94", "bounds": "32,34|33,35"})
        self.assertTrue(res["ok"])
        self.assertEqual((res["lat"], res["lng"]), (32.07, 34.79))
        self.assertEqual(seen["bounds"], "32,34|33,35")


if __name__ == "__main__":
    unittest.main()
