"""X-Hub-Signature-256 is verified only when we are set up to verify it.

There is no Meta Business Account behind this product, so the App Secret that
keys Meta's signature does not exist and the gateway in front of WhatsApp signs
nothing. Enforcing the header would reject every real message — so the rule is
opt-in: unset WHATSAPP_APP_SECRET accepts, set enforces.

These tests pin both halves, so nobody "hardens" the default and takes WhatsApp
down, and nobody deletes the check that makes the eventual switch a one-liner.
"""
import hashlib
import hmac
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
import main  # noqa: E402

BODY = b'{"entry":[{"changes":[{"value":{"messages":[]}}]}]}'
SECRET = "test-app-secret"


def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_no_secret_configured_accepts_everything(monkeypatch):
    monkeypatch.setattr(config, "WHATSAPP_APP_SECRET", "")
    assert main._signature_ok(BODY, None) is True
    assert main._signature_ok(BODY, "sha256=nonsense") is True


def test_a_configured_secret_accepts_a_correct_signature(monkeypatch):
    monkeypatch.setattr(config, "WHATSAPP_APP_SECRET", SECRET)
    assert main._signature_ok(BODY, _sign(BODY, SECRET)) is True


def test_a_configured_secret_rejects_everything_else(monkeypatch):
    monkeypatch.setattr(config, "WHATSAPP_APP_SECRET", SECRET)
    assert main._signature_ok(BODY, None) is False
    assert main._signature_ok(BODY, "") is False
    assert main._signature_ok(BODY, "deadbeef") is False, "missing the sha256= prefix"
    assert main._signature_ok(BODY, _sign(BODY, "wrong-secret")) is False
    assert main._signature_ok(b'{"tampered":true}', _sign(BODY, SECRET)) is False


def test_the_signature_covers_the_raw_bytes_not_a_reparse(monkeypatch):
    """Whitespace changes the signature. This is why the handler reads
    request.body() and json.loads()es it itself, instead of request.json()."""
    monkeypatch.setattr(config, "WHATSAPP_APP_SECRET", SECRET)
    respaced = BODY.replace(b'":[', b'": [')
    assert main._signature_ok(respaced, _sign(BODY, SECRET)) is False
