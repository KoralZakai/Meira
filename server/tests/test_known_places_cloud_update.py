"""A re-remembered place UPDATES its cloud row — it must not 409 forever.

Prod, 2026-10-09: she changed her work address and every shadow write logged
`lumi_known_places write failed (HTTP 409) ... 23505 ("userKey", lower(name))`.
The row carried no id, so merge-duplicates resolved on the primary key, found
nothing, INSERTed, and the unique expression index refused it. The JSON file had
the new address; the cloud kept the old one, and nothing but a log line said so.

The fake below enforces BOTH constraints a real Postgres has — the primary key
and the ("userKey", lower(name)) index — so the test fails the way prod did.
"""
import asyncio
import base64
import json as _json
import logging
import os
import sys
import uuid
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config                      # noqa: E402
import database_service as db      # noqa: E402
import field_crypto                # noqa: E402
import secure_store                # noqa: E402

KEY = base64.b64encode(bytes(range(32))).decode()
USER = "542900277"


class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = _json.dumps(payload)

    def json(self):
        return self._payload


class _Table:
    """lumi_known_places as Postgres + PostgREST would treat it."""

    def __init__(self):
        self.rows: list = []

    def _unique_hit(self, row, skip=None):
        for r in self.rows:
            if r is not skip and r["userKey"] == row["userKey"] \
                    and r["name"].lower() == row["name"].lower():
                return r
        return None

    def upsert(self, rows, on_conflict):
        for row in rows:
            row = dict(row)
            row.setdefault("id", str(uuid.uuid4()))
            same_pk = next((r for r in self.rows if r["id"] == row["id"]), None) \
                if on_conflict == "id" else None
            if same_pk:
                clash = self._unique_hit(row, skip=same_pk)
                if clash:
                    return _Resp(409, {"code": "23505"})
                same_pk.update(row)
                continue
            if self._unique_hit(row):
                return _Resp(409, {"code": "23505", "details": 'Key ("userKey", lower(name))'})
            self.rows.append(row)
        return _Resp(201, [])

    def patch(self, params, body):
        uk = params["userKey"][3:]
        name = params["name"][3:]
        hit = [r for r in self.rows if r["userKey"] == uk and r["name"] == name]
        for r in hit:
            r.update(body)
        return _Resp(200, [dict(r) for r in hit])


TABLE = _Table()


class _Client:
    def __init__(self, *_, **__):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def post(self, url, headers=None, params=None, json=None):
        return TABLE.upsert(json, (params or {}).get("on_conflict"))

    async def patch(self, url, headers=None, params=None, json=None):
        return TABLE.patch(params, json)


def _use_key(key):
    if key is None:
        os.environ.pop("LUMI_DATA_KEY", None)
    else:
        os.environ["LUMI_DATA_KEY"] = key
    secure_store._key_resolved = False
    secure_store._cached_key = None
    field_crypto.key_for.cache_clear()


def _run(key, body):
    old = os.environ.get("LUMI_DATA_KEY")
    TABLE.rows = []
    _use_key(key)
    try:
        with patch.multiple(config, SUPABASE_URL="https://fake.supabase.co",
                            SUPABASE_SERVICE_ROLE_KEY="service-role-key"), \
                patch.object(db.httpx, "AsyncClient", _Client):
            body()
    finally:
        _use_key(old)


def _address(row):
    return field_crypto.open_row("lumi_known_places", dict(row))["address"]


def test_a_new_work_address_replaces_the_old_one_sealed():
    def body():
        assert asyncio.run(db.remember_place(USER, "@work", "Herzl 1, Tel Aviv", 32.06, 34.77))
        assert asyncio.run(db.remember_place(USER, "@work", "Weizmann 5, Rehovot", 31.9, 34.8,
                                             uses=2))
        assert len(TABLE.rows) == 1
        assert _address(TABLE.rows[0]) == "Weizmann 5, Rehovot"
        assert TABLE.rows[0]["uses"] == 2
    _run(KEY, body)


def test_without_a_data_key_too():
    def body():
        assert asyncio.run(db.remember_place(USER, "@work", "Herzl 1"))
        assert asyncio.run(db.remember_place(USER, "@WORK", "Weizmann 5"))
        assert len(TABLE.rows) == 1 and TABLE.rows[0]["address"] == "Weizmann 5"
    _run(None, body)


def test_a_legacy_row_with_a_random_id_is_updated_and_moved_onto_the_stable_id():
    def body():
        legacy = field_crypto.seal_row("lumi_known_places", {
            "id": str(uuid.uuid4()), "userKey": USER, "name": "@work",
            "address": "Herzl 1, Tel Aviv", "lat": 32.06, "lng": 34.77})
        TABLE.rows.append(legacy)
        assert asyncio.run(db.remember_place(USER, "@work", "Weizmann 5, Rehovot"))
        assert len(TABLE.rows) == 1
        assert _address(TABLE.rows[0]) == "Weizmann 5, Rehovot"
        assert TABLE.rows[0]["id"] == db.place_id(USER, "@work")
        # …and the next write is a plain upsert, no collision path.
        assert asyncio.run(db.remember_place(USER, "@work", "Bialik 3"))
        assert _address(TABLE.rows[0]) == "Bialik 3"
    _run(KEY, body)


def test_a_collision_that_cannot_be_resolved_is_said_not_called_saved(caplog):
    def body():
        # Same lower(name) as far as the index is concerned, but the filter
        # cannot find it (a legacy plaintext name in other casing).
        TABLE.rows.append({"id": str(uuid.uuid4()), "userKey": USER, "name": "@WORK",
                           "address": "Herzl 1"})
        with caplog.at_level(logging.WARNING, logger="lumi.db"):
            assert asyncio.run(db.remember_place(USER, "@work", "Weizmann 5")) is False
        assert "NOT updated" in caplog.text
    _run(None, body)


def test_the_id_does_not_reveal_the_name_and_differs_per_person():
    def body():
        a = db.place_id(USER, "@work")
        assert a == db.place_id(USER, "@Work")
        assert a != db.place_id("542900999", "@work")
        assert a != str(uuid.uuid5(db._PLACE_NS, f"{USER}\x00@work"))
    _run(KEY, body)
