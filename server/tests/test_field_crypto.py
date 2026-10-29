"""field_crypto — personal columns reach Supabase as ciphertext (7.10).

  * round trip; plaintext (old rows) passes through; no key = passthrough;
  * AAD binds a value to its table+column, a per-person key to its owner;
  * deterministic only where the database must compare (unique/conflict keys);
  * a known place's coordinates travel inside the sealed address, never bare;
  * task rows: sealed fields round-trip, a stored copy's fields survive a
    partial write, an OLD client's plaintext row wins over a stale seal, and
    a row that will not open is flagged, never shown as ciphertext;
  * the app's AES-GCM opens what the server seals (tests/fixtures vector).
"""
import base64
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import field_crypto  # noqa: E402
import secure_store  # noqa: E402
import supabase_tasks  # noqa: E402

KEY = base64.b64encode(bytes(range(32))).decode()
FIXTURE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                       "tests", "fixtures", "sealed-vector.json")


def use_key(key):
    if key is None:
        os.environ.pop("LUMI_DATA_KEY", None)
    else:
        os.environ["LUMI_DATA_KEY"] = key
    secure_store._key_resolved = False
    secure_store._cached_key = None
    field_crypto.key_for.cache_clear()


class Base(unittest.TestCase):
    def setUp(self):
        self._old = os.environ.get("LUMI_DATA_KEY")
        use_key(KEY)

    def tearDown(self):
        use_key(self._old)


class Columns(Base):
    def test_profile_round_trip_and_nothing_readable(self):
        row = {"userKey": "972500000001", "homeAddress": "אבן גבירול 30", "transportType": "bus"}
        sealed = field_crypto.seal_row("lumi_profiles", row)
        self.assertTrue(sealed["homeAddress"].startswith("enc1:"))
        self.assertNotIn("גבירול", json.dumps(sealed, ensure_ascii=False))
        self.assertEqual(sealed["transportType"], "bus")
        self.assertEqual(field_crypto.open_row("lumi_profiles", sealed)["homeAddress"], "אבן גבירול 30")

    def test_a_value_moved_to_another_column_or_person_does_not_open(self):
        sealed = field_crypto.seal_row("lumi_profiles", {"userKey": "a", "homeAddress": "x"})
        moved = field_crypto.open_row("lumi_profiles", {"userKey": "a", "workAddress": sealed["homeAddress"]})
        self.assertIsNone(moved["workAddress"])
        stolen = field_crypto.open_row("lumi_profiles", {**sealed, "userKey": "b"})
        self.assertIsNone(stolen["homeAddress"])

    def test_places_carry_coordinates_inside_the_seal(self):
        row = {"userKey": "k", "name": "Gym", "address": "Space Gym", "lat": 32.08, "lng": 34.78}
        sealed = field_crypto.seal_row("lumi_known_places", row)
        self.assertIsNone(sealed["lat"])
        self.assertIsNone(sealed["lng"])
        back = field_crypto.open_row("lumi_known_places", sealed)
        self.assertEqual((back["address"], back["lat"], back["lng"]), ("Space Gym", 32.08, 34.78))

    def test_coordinates_without_an_address_are_sealed_too(self):
        sealed = field_crypto.seal_row("lumi_known_places", {"userKey": "k", "name": "x", "lat": 32.1, "lng": 34.8})
        self.assertIsNone(sealed["lat"])
        self.assertEqual(field_crypto.open_row("lumi_known_places", sealed)["lat"], 32.1)

    def test_a_read_that_filtered_on_userkey_opens_without_selecting_it(self):
        import asyncio
        import database_service
        sealed = field_crypto.seal_row("lumi_memories", {"userKey": "972500000001", "kind": "fact",
                                                         "content": "likes tea"})
        resp = mock.MagicMock(status_code=200, json=lambda: [{"id": "1", "content": sealed["content"]}])
        client = mock.MagicMock()
        client.__aenter__ = mock.AsyncMock(return_value=client)
        client.__aexit__ = mock.AsyncMock(return_value=False)
        client.get = mock.AsyncMock(return_value=resp)
        with mock.patch("database_service.httpx.AsyncClient", return_value=client), \
             mock.patch("database_service.enabled", return_value=True):
            rows = asyncio.run(database_service._get("lumi_memories", {"select": "id,content",
                                                                       "userKey": "eq.972500000001"}))
        self.assertEqual(rows[0]["content"], "likes tea")

    def test_deterministic_only_where_the_database_compares(self):
        a = field_crypto.seal_row("lumi_memories", {"userKey": "k", "kind": "fact", "content": "likes tea"})
        b = field_crypto.seal_row("lumi_memories", {"userKey": "k", "kind": "fact", "content": "likes tea"})
        self.assertEqual(a["content"], b["content"])                 # unique index still dedupes
        c = field_crypto.seal_row("lumi_conversations", {"userKey": "k", "text": "hi"})
        d = field_crypto.seal_row("lumi_conversations", {"userKey": "k", "text": "hi"})
        self.assertNotEqual(c["text"], d["text"])

    def test_json_columns_and_old_plaintext_rows(self):
        s = field_crypto.seal_row("lumi_sessions", {"userKey": "k", "payload": {"inputText": "ראיון"}})
        self.assertIn("enc1", s["payload"])
        self.assertEqual(field_crypto.open_row("lumi_sessions", s)["payload"], {"inputText": "ראיון"})
        old = {"userKey": "k", "text": "plain from before"}
        self.assertEqual(field_crypto.open_row("lumi_conversations", old), old)

    def test_no_key_means_passthrough(self):
        use_key(None)
        row = {"userKey": "k", "text": "hi"}
        self.assertEqual(field_crypto.seal_row("lumi_conversations", row), row)


class TaskRows(Base):
    def setUp(self):
        super().setUp()
        self.env = mock.patch.dict(os.environ, {"SEAL_APP_ROWS": "1"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        super().tearDown()

    def test_sealed_task_round_trip(self):
        row = {"id": "t1", "userId": "u", "text": "ראיון ב-Ceva", "date": "2026-10-08",
               "location": {"address": "Ra'anana", "lat": 32.18}, "contactPhone": "0541234567"}
        out = supabase_tasks.seal_task_row("u", row)
        self.assertEqual(out["text"], supabase_tasks.PLACEHOLDER)
        self.assertIsNone(out["location"])
        self.assertEqual(out["date"], "2026-10-08")                  # queries still filter on it
        # Only the clear columns: random base64 in `sealed` may spell "Ceva" by
        # chance (it did, once, in CI on 8.10, and stopped the deploy).
        clear = {k: v for k, v in out.items() if k != "sealed"}
        self.assertNotIn("Ceva", json.dumps(clear, ensure_ascii=False))
        back = supabase_tasks.open_task_row("u", out)
        self.assertEqual(back["text"], "ראיון ב-Ceva")
        self.assertEqual(back["location"]["address"], "Ra'anana")

    def test_a_partial_write_keeps_the_stored_fields(self):
        stored = supabase_tasks.open_task_row("u", supabase_tasks.seal_task_row(
            "u", {"id": "t1", "text": "a", "contactPhone": "054", "location": {"address": "x"}}))
        out = supabase_tasks.seal_task_row("u", {"id": "t1", "text": "a, renamed"}, stored)
        back = supabase_tasks.open_task_row("u", out)
        self.assertEqual((back["text"], back["contactPhone"], back["location"]),
                         ("a, renamed", "054", {"address": "x"}))

    def test_an_old_clients_plaintext_wins_over_a_stale_seal(self):
        sealed = supabase_tasks.seal_task_row("u", {"id": "t1", "text": "old"})
        row = {**sealed, "text": "edited on the old app"}
        self.assertEqual(supabase_tasks.open_task_row("u", row)["text"], "edited on the old app")

    def test_another_account_cannot_open_it(self):
        sealed = supabase_tasks.seal_task_row("u", {"id": "t1", "text": "secret"})
        self.assertTrue(supabase_tasks.open_task_row("someone-else", sealed).get("_unreadable"))

    def test_off_means_plaintext_as_before(self):
        with mock.patch.dict(os.environ, {"SEAL_APP_ROWS": "0"}):
            row = {"id": "t1", "text": "x"}
            self.assertEqual(supabase_tasks.seal_task_row("u", row), row)


class CrossLanguage(Base):
    def test_write_the_vector_the_app_test_opens(self):
        """Python seals with a FIXED nonce; tests/run-sealed-interop.ts must open
        it with the app's code, and seal one back that this side opens."""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = bytes(range(32))
        nonce = bytes(range(12))
        plain = json.dumps({"text": "ראיון ב-Ceva 🚌", "location": {"lat": 32.18}}, ensure_ascii=False)
        ct = AESGCM(key).encrypt(nonce, plain.encode(), b"tasks:t1")
        vector = {"key_b64": base64.b64encode(key).decode(), "aad": "tasks:t1", "plain": plain,
                  "sealed": "enc1:" + base64.b64encode(nonce + ct).decode()}
        if os.path.exists(FIXTURE):
            with open(FIXTURE, encoding="utf-8") as f:
                on_disk = json.load(f)
            self.assertEqual(on_disk["sealed"], vector["sealed"], "fixture is stale — regenerate")
            if on_disk.get("from_app"):
                raw = base64.b64decode(on_disk["from_app"][5:])
                self.assertEqual(AESGCM(key).decrypt(raw[:12], raw[12:], b"tasks:t1").decode(), plain)
        else:
            os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
            with open(FIXTURE, "w", encoding="utf-8") as f:
                json.dump(vector, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    unittest.main()
