"""The ceilings are actually WIRED to the doors, not merely implemented.

test_rate_limit.py proves the limiter counts correctly. That is the easy half.
The half that silently fails is the wiring: a limiter that is imported and
never consulted passes every unit test it has and protects nothing, and the
symptom — a bill, or a stranger writing tasks — arrives weeks later with no
error anywhere.

So these tests speak to the real FastAPI app over the real routes, and assert
the thing the unit tests cannot: that the 429 comes out of the endpoint.

The webhook cases matter most. Until WHATSAPP_APP_SECRET is set, POST
/webhook/whatsapp accepts any body from anyone, and each accepted body runs a
full ReAct turn on a 235B model. The signature is the real fix; these ceilings
are what stands between an open door and an unbounded bill while it is unset.
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient   # noqa: E402

import config                                # noqa: E402

_TMP = tempfile.mkdtemp(prefix="lumi-ratelimit-")
config.DATA_DIR = _TMP
# No LLM credential, deliberately. Requests under the ceiling fail inside the
# handler and become 500s (see raise_server_exceptions below) instead of
# reaching the network — a test that measures a ceiling must not depend on a
# model call, and an earlier version that supplied a fake key spent four
# minutes in SDK retry backoff before anyone noticed it was calling out.
config.LLM_API_KEY = ""
for _m in ("user_memory", "agents_store", "user_store", "conversation",
           "provenance", "reminders", "known_places", "travel_prefs"):
    mod = importlib.import_module(_m)
    mod._PATH = os.path.join(_TMP, os.path.basename(getattr(mod, "_PATH")))

import main            # noqa: E402
import app_auth        # noqa: E402
import rate_limit      # noqa: E402

# raise_server_exceptions=False so a handler that throws becomes a 500 RESPONSE
# rather than propagating out of the client. Requests under the ceiling run real
# handler code that has no LLM credential here; what is under test is that
# request N+1 is refused, and it must be refused whatever the ones before it did.
client = TestClient(main.app, raise_server_exceptions=False)

ALICE = {"userId": "alice-uuid", "email": "alice@example.com"}
BOB = {"userId": "bob-uuid", "email": "bob@example.com"}
_PHONES = {"alice-uuid": "972500000001", "bob-uuid": "972500000002"}


def _as(identity):
    async def fake_verify(authorization):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise app_auth.AuthError("missing bearer token")
        return dict(identity)

    async def fake_phone(user_id):
        return _PHONES.get(user_id)

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


def _wa_body(phone: str, msg_id: str, text: str = "שלום"):
    """A WhatsApp webhook body — the exact shape anyone could forge today."""
    return {"entry": [{"changes": [{"value": {"messages": [{
        "id": msg_id, "from": phone, "type": "text", "text": {"body": text},
    }]}}]}]}


@pytest.fixture(autouse=True)
def _clean():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture
def _no_agent():
    """Stub everything a webhook body would otherwise set in motion.

    Without this the first N requests reach the real agent and die on a missing
    LLM credential, so the test would report a crash where the ANSWER is
    whether request N+1 gets a 429. What is under test here is the ceiling, and
    the ceiling must hold whatever the handler behind it does.
    """
    async def noop_turn(*args, **kwargs):
        return {"text": "", "type": None, "tasks": [], "departures": []}

    async def noop_send(*args, **kwargs):
        return None

    with patch.object(main.agent_turn, "run_turn", noop_turn), \
         patch.object(main.WhatsAppService, "send_message", noop_send):
        yield


def test_chat_refuses_past_the_ceiling():
    """A signed-in account cannot spend turns without limit."""
    with _as(ALICE):
        seen = []
        for _ in range(rate_limit.CHAT_LIMIT + 3):
            r = client.post("/agent/chat", json={"message": ""},
                            headers={"Authorization": "Bearer t"})
            seen.append(r.status_code)
    assert 429 in seen, f"no 429 in {sorted(set(seen))} — the limit is not wired"
    # An empty message is a 400; what matters is that 429 takes over at the cap.
    assert seen.count(429) >= 3


def test_chat_limit_is_per_account_not_global():
    """One noisy friend must not lock everyone else out of the app."""
    with _as(ALICE):
        for _ in range(rate_limit.CHAT_LIMIT + 3):
            client.post("/agent/chat", json={"message": ""},
                        headers={"Authorization": "Bearer t"})
        blocked = client.post("/agent/chat", json={"message": ""},
                              headers={"Authorization": "Bearer t"})
    assert blocked.status_code == 429
    with _as(BOB):
        fresh = client.post("/agent/chat", json={"message": ""},
                            headers={"Authorization": "Bearer t"})
    assert fresh.status_code != 429, "Bob paid for Alice's loop"


def test_chat_says_when_to_come_back():
    with _as(ALICE):
        for _ in range(rate_limit.CHAT_LIMIT + 1):
            r = client.post("/agent/chat", json={"message": ""},
                            headers={"Authorization": "Bearer t"})
    assert r.status_code == 429
    assert r.headers.get("Retry-After"), "a 429 with no Retry-After invites a hot retry loop"


def test_the_limit_runs_after_auth_so_it_cannot_be_used_to_probe():
    """An unauthenticated caller gets 401, never a 429 that confirms anything.

    If the ceiling were checked first, its counter would be keyed on something
    an anonymous caller controls, and the different status codes would leak
    whether an account exists.
    """
    r = client.post("/agent/chat", json={"message": "hi"})
    assert r.status_code == 401


def test_webhook_refuses_a_flood_from_one_number(_no_agent):
    seen = []
    for i in range(rate_limit.WHATSAPP_LIMIT + 3):
        r = client.post("/webhook/whatsapp", json=_wa_body("972500000009", f"m{i}"))
        seen.append(r.status_code)
    assert 429 in seen, f"no 429 in {sorted(set(seen))} — one sender is unlimited"


def test_webhook_refuses_a_forged_flood_of_DISTINCT_numbers(_no_agent):
    """The attack the per-sender limit cannot see.

    Every forged body names a different `from`, so each looks like a brand new
    user with a full allowance. Only the whole-door ceiling stops it, and this
    is the test that would fail if that ceiling were ever removed as redundant.
    """
    seen = []
    for i in range(rate_limit.WEBHOOK_GLOBAL_LIMIT + 10):
        r = client.post("/webhook/whatsapp",
                        json=_wa_body(f"97250000{i:04d}", f"forged{i}"))
        seen.append(r.status_code)
    assert 429 in seen, "a forged flood of fresh numbers ran unbounded"
    assert seen.count(429) >= 10


def test_the_webhook_ceiling_is_checked_before_the_body_is_parsed(_no_agent):
    """Garbage still costs its slot — an attacker cannot send junk for free."""
    for _ in range(rate_limit.WEBHOOK_GLOBAL_LIMIT):
        client.post("/webhook/whatsapp", content=b"not json",
                    headers={"Content-Type": "application/json"})
    r = client.post("/webhook/whatsapp", json=_wa_body("972500000009", "after"))
    assert r.status_code == 429, "junk bodies bypassed the ceiling"


# 19.10, before Play: the model-calling app doors that had no ceiling. Bodies
# are deliberately invalid, so nothing under the cap reaches a model — and the
# cap must still count them, because the check runs before the body is read.
_APP_DOORS = [
    ("/app/tasks/extract", {}, "error"),
    ("/app/profile/extract", {}, "error"),
    ("/app/email/events", {}, "error"),
    ("/app/meeting/brief", {}, "ok"),
    ("/app/task/prep", {}, "ok"),
    ("/app/errands/along", {"task": "not-a-dict"}, "ok"),
    ("/app/questions/answer", {}, "ok"),
]


@pytest.mark.parametrize("path,body,shape", _APP_DOORS)
def test_model_calling_app_doors_refuse_past_the_ceiling(path, body, shape):
    with _as(ALICE):
        seen = [client.post(path, json=body, headers={"Authorization": "Bearer t"})
                for _ in range(rate_limit.APP_MODEL_LIMIT + 2)]
    codes = [r.status_code for r in seen]
    assert 429 not in codes[:rate_limit.APP_MODEL_LIMIT], f"{path} refused under the cap: {codes}"
    last = seen[-1]
    assert last.status_code == 429, f"{path}: no 429 in {sorted(set(codes))} — the limit is not wired"
    assert last.headers.get("retry-after")
    # The refusal names itself in the door's own shape — never an empty result
    # that reads as "nothing found" (silent-state rule 1).
    want = {"ok": False, "reason": "rate_limited"} if shape == "ok" else {"error": "rate_limited"}
    assert last.json() == want


def test_app_door_limits_are_per_account_and_per_door():
    with _as(ALICE):
        for _ in range(rate_limit.APP_MODEL_LIMIT + 1):
            client.post("/app/tasks/extract", json={}, headers={"Authorization": "Bearer t"})
        other_door = client.post("/app/task/prep", json={}, headers={"Authorization": "Bearer t"})
    with _as(BOB):
        other_person = client.post("/app/tasks/extract", json={}, headers={"Authorization": "Bearer t"})
    assert other_door.status_code != 429
    assert other_person.status_code != 429


def test_personality_resolve_is_counted_per_ip():
    ip_a = {"Fly-Client-IP": "203.0.113.7"}
    codes = [client.get("/personality/resolve", params={"token": f"guess{i}"}, headers=ip_a).status_code
             for i in range(rate_limit.RESOLVE_LIMIT + 2)]
    assert codes[-1] == 429, f"no 429 in {sorted(set(codes))} — guessing is unlimited"
    assert 429 not in codes[:rate_limit.RESOLVE_LIMIT]
    other = client.get("/personality/resolve", params={"token": "x"},
                       headers={"Fly-Client-IP": "198.51.100.9"})
    assert other.status_code != 429


def test_health_publishes_no_model_configuration():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
