"""Every door refuses a stranger — checked over the real app, route by route.

8.10: /docs, /redoc and /openapi.json were open on production and printed the
full map of the server (admin and diag included) to anyone with a browser.
Each route had its own auth check, and every one of those had tests — but no
test asked the question from the outside: "with no credentials at all, what
answers?" This one does, for every route the app registers, so a new route
that forgets its check fails here instead of in a stranger's hands.

OPEN is the whole list of doors that may answer an anonymous caller, each with
the reason it is allowed to.
"""
from __future__ import annotations

import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.routing import APIRoute       # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import config                              # noqa: E402

config.DATA_DIR = tempfile.mkdtemp(prefix="lumi-doors-")
config.LLM_API_KEY = ""
config.ADMIN_TOKEN = "set-in-production"   # unset, /admin/* answers 503, not 401

import main                                # noqa: E402

client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)

OPEN = {
    ("GET", "/health"): "Fly's health check",
    ("GET", "/webhook/whatsapp"): "Meta's subscribe handshake; answers only the verify token",
    ("POST", "/webhook/whatsapp"): "Meta's deliveries; X-Hub-Signature-256 checked inside",
    ("POST", "/mcp"): "MCP; every tool call is refused without a personal token (test_mcp_server)",
    ("GET", "/personality/resolve"): "the token IS the credential: 256-bit, single use, 10 min",
    ("GET", "/g/{token}"): "group invite page; the token IS the credential: 144-bit, stored hashed, 14 days, yes/no only",
    ("POST", "/g/{token}"): "group invite answers; same token, writes only that member's yes/no",
    ("GET", "/"): "302 to the public site",
    ("GET", "/privacy"): "302 to the public site",
    ("GET", "/delete-account"): "302 to the public site",
}

REFUSED = {401, 403, 404, 405}
# Required query params, so a door is judged on its auth, not on a 422.
PARAMS = {"phone": "972500000000"}


def _flat(routes):
    """FastAPI 0.142 nests an included router as one _IncludedRouter entry."""
    for r in routes:
        inner = getattr(r, "original_router", None)
        if inner is not None:
            yield from _flat(inner.routes)
        else:
            yield r


def _routes():
    for r in _flat(main.app.routes):
        if not isinstance(r, APIRoute):
            continue
        path = re.sub(r"\{[^}]+\}", "972500000000", r.path)
        for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
            yield m, r.path, path


def test_the_api_map_is_not_published():
    for p in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(p).status_code == 404, p


def test_every_other_door_refuses_a_stranger():
    open_now = []
    for method, template, path in _routes():
        if (method, template) in OPEN:
            continue
        r = client.request(method, path, json={}, params=PARAMS)
        if r.status_code not in REFUSED:
            open_now.append(f"{method} {template} -> {r.status_code}")
    assert not open_now, "answers with no credentials:\n" + "\n".join(open_now)


def test_the_open_list_names_only_real_routes():
    real = {(m, t) for m, t, _ in _routes()}
    assert not set(OPEN) - real, set(OPEN) - real
