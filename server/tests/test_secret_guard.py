"""secret_guard — a key pasted into a chat is never kept, and a Meira key is revoked.

29.9: the Claude setup text (with a meira_mcp_ key) was sent to Meira's own
WhatsApp and went into the conversation history.
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mcp_server  # noqa: E402
import secret_guard  # noqa: E402

SETUP = ('claude mcp add --transport http meira https://lumi-whatsapp.fly.dev/mcp '
         '--header "Authorization: Bearer {tok}"')


class Guard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = mock.patch.object(mcp_server, "_PATH", os.path.join(self.tmp.name, "m.json"))
        self.p.start()

    def tearDown(self):
        self.p.stop()
        self.tmp.cleanup()

    def test_the_shared_setup_text_is_caught_and_its_key_revoked(self):
        tok = mcp_server.issue_token({"key": "k1", "userId": "u", "phone": None}, "x")["token"]
        reply = secret_guard.handle(SETUP.format(tok=tok), he=True)
        self.assertIn("בוטל", reply)
        self.assertEqual(mcp_server.list_tokens("k1"), [])
        self.assertIsNone(mcp_server._caller_for_token(tok))

    def test_other_keys_are_caught_but_nothing_is_revoked(self):
        for text in ("my key sk-proj-" + "a" * 40, "tvly-" + "b" * 32, "AIza" + "c" * 35,
                     "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"):
            self.assertIsNotNone(secret_guard.handle(text, he=False), text[:12])

    def test_ordinary_sentences_pass(self):
        for text in ("my key is under the mat", "תזכירי לי מחר ב-16:00 רופא שיניים",
                     "sk-8 is a skateboard shop", "meira_mcp_ is the prefix"):
            self.assertIsNone(secret_guard.handle(text), text)

    def test_redact_never_returns_the_value(self):
        tok = "meira_mcp_" + "Z" * 43
        self.assertNotIn(tok, secret_guard.redact(f"here {tok} ok"))


if __name__ == "__main__":
    unittest.main()
