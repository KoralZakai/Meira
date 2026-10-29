"""A place that is a NAME is looked up as a business (29.10, the Nebius interview)."""
import asyncio

import geo
import routes_app


class _Req:
    def __init__(self, body):
        import json
        self._b = json.dumps(body).encode()

    async def body(self):
        return self._b

    async def json(self):
        import json
        return json.loads(self._b)


def test_looks_like_name():
    assert geo.looks_like_name("Nebuis")
    assert geo.looks_like_name("Intel Haifa")
    assert not geo.looks_like_name("יצחק שדה 6 תל אביב")
    assert not geo.looks_like_name("")


def test_name_falls_back_to_places(monkeypatch):
    async def no_geocode(address, bounds=None):
        return None

    async def place(query):
        assert query == "Nebuis"
        return {"name": "Nebius", "formatted": "Yitzhak Sadeh St 6, Tel Aviv-Yafo", "lat": 32.06, "lng": 34.79, "place_id": "x"}

    monkeypatch.setattr(geo, "geocode", no_geocode)
    monkeypatch.setattr(geo, "find_place", place)
    out = asyncio.run(routes_app.geocode_route(_Req({"address": "Nebuis"}), caller={'key': 't'}))
    assert out["ok"] and out["source"] == "place" and out["name"] == "Nebius"
    assert "Yitzhak Sadeh" in out["formatted"]


def test_an_address_never_goes_to_places(monkeypatch):
    async def no_geocode(address, bounds=None):
        return None

    async def place(query):
        raise AssertionError("an address with a number must not be searched as a business")

    monkeypatch.setattr(geo, "geocode", no_geocode)
    monkeypatch.setattr(geo, "find_place", place)
    out = asyncio.run(routes_app.geocode_route(_Req({"address": "יצחק שדה 6"}), caller={'key': 't'}))
    assert out == {"ok": False, "reason": "not_found"}


def test_place_miss_is_cached(monkeypatch):
    calls = []

    async def miss(query):
        calls.append(query)
        return None

    geo._place_cache.clear()
    monkeypatch.setattr(geo, "_find_place_uncached", miss)
    asyncio.run(geo.find_place("Nowhere Co"))
    asyncio.run(geo.find_place("nowhere co"))
    assert calls == ["Nowhere Co"]
