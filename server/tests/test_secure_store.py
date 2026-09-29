"""secure_store: ciphertext on disk, transparent migration, and — the one that
matters most — a key failure must never look like an empty store.

The last property is why this file exists. Every JSON store in this server used
to answer a corrupt file with `return {}`, and the next save then wrote that
empty dict over the real data. Encryption adds a brand-new way to "fail to
read" (wrong key, rotated key, tampered file), so it must be provably loud.
"""
import base64
import importlib
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import secure_store  # noqa: E402

KEY_A = base64.b64encode(b"A" * 32).decode()
KEY_B = base64.b64encode(b"B" * 32).decode()

SECRET = {
    "972500000001": {
        "routines": ["wakes at 07:30"],
        "contacts": [{"name": "אימוש", "number": "972500000009"}],
        "tasks": [{"text": "interview at Mordei ha-Geta'ot 25", "date": "2026-09-09"}],
    }
}


def _reset(key=None):
    """Re-resolve the module's cached key (it memoises by design)."""
    if key is None:
        os.environ.pop("LUMI_DATA_KEY", None)
    else:
        os.environ["LUMI_DATA_KEY"] = key
    secure_store._key_resolved = False
    secure_store._cached_key = None
    secure_store._warned_no_key = False


class EncryptionAtRest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lumi-sec-")
        self.path = os.path.join(self.dir, "user_memory.json")

    def tearDown(self):
        _reset(None)

    def test_plaintext_when_no_key(self):
        """No key -> today's behaviour exactly. No flag day required."""
        _reset(None)
        secure_store.write_json(self.path, SECRET)
        on_disk = open(self.path, encoding="utf-8").read()
        self.assertIn("אימוש", on_disk)
        self.assertEqual(secure_store.read_json(self.path, {}), SECRET)

    def test_ciphertext_hides_content(self):
        """With a key, nothing sensitive is readable in the file."""
        _reset(KEY_A)
        secure_store.write_json(self.path, SECRET)
        raw = open(self.path, encoding="utf-8").read()

        for leak in ("אימוש", "972500000009", "Mordei", "wakes at 07:30", "interview"):
            self.assertNotIn(leak, raw, f"{leak!r} is readable on disk")

        envelope = json.loads(raw)
        self.assertEqual(envelope["__lumi_enc__"], 1)
        self.assertEqual(envelope["alg"], "AES-256-GCM")
        self.assertEqual(secure_store.read_json(self.path, {}), SECRET)

    def test_nonce_is_per_write(self):
        """Same plaintext twice must not produce the same ciphertext."""
        _reset(KEY_A)
        secure_store.write_json(self.path, SECRET)
        first = open(self.path, encoding="utf-8").read()
        secure_store.write_json(self.path, SECRET)
        second = open(self.path, encoding="utf-8").read()
        self.assertNotEqual(first, second, "nonce reuse — GCM is broken by this")

    def test_legacy_plaintext_migrates_on_next_write(self):
        """A file written before encryption still loads, then becomes ciphertext."""
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(SECRET, f, ensure_ascii=False)

        _reset(KEY_A)
        loaded = secure_store.read_json(self.path, {})
        self.assertEqual(loaded, SECRET, "legacy plaintext must still be readable")

        secure_store.write_json(self.path, loaded)
        self.assertNotIn("אימוש", open(self.path, encoding="utf-8").read())
        self.assertEqual(secure_store.read_json(self.path, {}), SECRET)


class FailsLoudNotEmpty(unittest.TestCase):
    """The data-loss guard. None of these may return {}."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lumi-sec-")
        self.path = os.path.join(self.dir, "user_memory.json")
        _reset(KEY_A)
        secure_store.write_json(self.path, SECRET)

    def tearDown(self):
        _reset(None)

    def test_wrong_key_raises(self):
        _reset(KEY_B)
        with self.assertRaises(secure_store.DecryptionError):
            secure_store.read_json(self.path, {})

    def test_missing_key_raises_on_encrypted_file(self):
        _reset(None)
        with self.assertRaises(secure_store.DecryptionError):
            secure_store.read_json(self.path, {})

    def test_tampered_ciphertext_raises(self):
        """GCM authenticates: a flipped byte is detected, not decrypted."""
        env = json.loads(open(self.path, encoding="utf-8").read())
        ct = bytearray(base64.b64decode(env["ct"]))
        ct[0] ^= 0x01
        env["ct"] = base64.b64encode(bytes(ct)).decode()
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(env, f)

        _reset(KEY_A)
        with self.assertRaises(secure_store.DecryptionError):
            secure_store.read_json(self.path, {})

    def test_ciphertext_cannot_be_moved_between_stores(self):
        """Filename is bound as AAD: swapping files fails to authenticate."""
        other = os.path.join(self.dir, "conversations.json")
        os.rename(self.path, other)
        _reset(KEY_A)
        with self.assertRaises(secure_store.DecryptionError):
            secure_store.read_json(other, {})

    def test_malformed_key_raises_rather_than_silently_plaintext(self):
        _reset("this-is-not-32-bytes")
        with self.assertRaises(ValueError):
            secure_store.write_json(self.path, SECRET)


class AtomicWrites(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lumi-sec-")
        self.path = os.path.join(self.dir, "reminders.json")

    def tearDown(self):
        _reset(None)

    def test_missing_file_returns_fallback(self):
        _reset(KEY_A)
        self.assertEqual(secure_store.read_json(self.path, []), [])

    def test_no_temp_files_left_behind(self):
        _reset(KEY_A)
        secure_store.write_json(self.path, [{"text": "leave now"}])
        leftovers = [f for f in os.listdir(self.dir) if f.startswith(".tmp-")]
        self.assertEqual(leftovers, [], f"temp files leaked: {leftovers}")

    def test_rotate_reencrypts_under_current_key(self):
        _reset(None)
        secure_store.write_json(self.path, [{"text": "plaintext row"}])
        _reset(KEY_A)
        self.assertTrue(secure_store.rotate(self.path))
        self.assertNotIn("plaintext row", open(self.path, encoding="utf-8").read())
        self.assertEqual(secure_store.read_json(self.path, []), [{"text": "plaintext row"}])


if __name__ == "__main__":
    unittest.main()


class LegacyPlaintextMigrationTests(unittest.TestCase):
    """The migration strategy in this module's header is "the next write
    encrypts it". That does nothing for a store nobody writes.

    Checked on the live volume 2026-09-17, with LUMI_DATA_KEY deployed:
    /data/known_places.json was still plaintext and world-readable (0644) from
    31 August, holding a phone number and home/work/gym addresses.
    secure_store.rotate() was written for this exact case and called from
    nowhere in the codebase.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "known_places.json")

    def _write_plaintext(self, data):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def test_a_plaintext_store_is_recognised(self):
        self._write_plaintext({"500000009": {"@fitness": {"address": "Yigal Alon 94"}}})
        with mock.patch.object(secure_store, "_load_key", lambda: b"k" * 32):
            self.assertTrue(secure_store.is_plaintext(self.path))

    def test_migration_encrypts_it_and_keeps_every_value(self):
        original = {"500000009": {"@fitness": {"address": "Yigal Alon 94", "lat": 32.07}}}
        self._write_plaintext(original)
        with mock.patch.object(secure_store, "_load_key", lambda: b"k" * 32):
            moved = secure_store.migrate_plaintext([self.path])
            self.assertEqual(moved, 1)
            self.assertFalse(secure_store.is_plaintext(self.path))
            self.assertEqual(secure_store.read_json(self.path, None), original)

    def test_the_address_is_no_longer_readable_on_disk(self):
        self._write_plaintext({"500000009": {"@fitness": {"address": "Yigal Alon 94"}}})
        with mock.patch.object(secure_store, "_load_key", lambda: b"k" * 32):
            secure_store.migrate_plaintext([self.path])
        raw = open(self.path, "r", encoding="utf-8").read()
        self.assertNotIn("Yigal Alon", raw)
        self.assertNotIn("500000009", raw)

    def test_it_also_tightens_the_permissions(self):
        """The 0644 files are legacy `open(path, 'w')` writes. write_json goes
        through tempfile.mkstemp (0600) and os.replace carries the mode over."""
        self._write_plaintext({"a": 1})
        os.chmod(self.path, 0o644)
        with mock.patch.object(secure_store, "_load_key", lambda: b"k" * 32):
            secure_store.migrate_plaintext([self.path])
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_an_already_encrypted_store_is_left_alone(self):
        with mock.patch.object(secure_store, "_load_key", lambda: b"k" * 32):
            secure_store.write_json(self.path, {"a": 1})
            before = os.stat(self.path).st_mtime_ns
            self.assertEqual(secure_store.migrate_plaintext([self.path]), 0)
            self.assertEqual(os.stat(self.path).st_mtime_ns, before)

    def test_no_key_configured_migrates_nothing(self):
        """Encryption that bricks a running server on deploy is not a security
        improvement — the staged-rollout promise in the header still holds."""
        self._write_plaintext({"a": 1})
        with mock.patch.object(secure_store, "_load_key", lambda: None):
            self.assertEqual(secure_store.migrate_plaintext([self.path]), 0)

    def test_a_missing_file_is_not_an_error(self):
        with mock.patch.object(secure_store, "_load_key", lambda: b"k" * 32):
            self.assertEqual(
                secure_store.migrate_plaintext([os.path.join(self.dir, "nope.json")]), 0)

    def test_one_bad_store_does_not_stop_the_others(self):
        """Best-effort per file: a boot must not fail because one store is odd."""
        good = os.path.join(self.dir, "good.json")
        with open(good, "w", encoding="utf-8") as f:
            json.dump({"ok": True}, f)
        bad = os.path.join(self.dir, "bad.json")
        with open(bad, "w", encoding="utf-8") as f:
            f.write("{not json")
        with mock.patch.object(secure_store, "_load_key", lambda: b"k" * 32):
            self.assertEqual(secure_store.migrate_plaintext([bad, good]), 1)
