"""Every route that touches personal data rejects an unauthenticated caller,
and rejects an AUTHENTICATED caller reaching for someone else's data.

The second half is the point. Adding a token check alone would have fixed
authentication and left authorization open: `/tasks/{phone}` takes the phone
from the URL, so any signed-in user could still have read, edited and deleted a
stranger's tasks by typing their number. These tests fail if that regresses.

No network: app_auth.verify is patched, so nothing here calls Supabase.
"""
import importlib
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient   # noqa: E402

import config                                # noqa: E402

# Point every JSON store at a scratch dir before main imports them.
_TMP = tempfile.mkdtemp(prefix="lumi-authz-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "agents_store", "user_store", "conversation",
           "provenance", "reminders", "known_places", "travel_prefs"):
    mod = importlib.import_module(_m)
    mod._PATH = os.path.join(_TMP, os.path.basename(getattr(mod, "_PATH")))

import main            # noqa: E402
import app_auth        # noqa: E402

ALICE = {"userId": "alice-uuid", "email": "alice@example.com"}
BOB = {"userId": "bob-uuid", "email": "bob@example.com"}
ALICE_PHONE = "972500000001"
BOB_PHONE = "972500000002"

_PHONES = {"alice-uuid": ALICE_PHONE, "bob-uuid": BOB_PHONE}


def _as(identity):
    """Patch verification so the given account is the authenticated caller."""
    async def fake_verify(authorization):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise app_auth.AuthError("missing bearer token")
        return dict(identity)

    async def fake_phone(user_id):
        return _PHONES.get(user_id)

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


client = TestClient(main.app)

# (method, path-template) for every route that must require a token.
PROTECTED = [
    ("get",    "/tasks/{phone}"),
    ("post",   "/tasks/{phone}"),
    ("patch",  "/tasks/{phone}/some-task-id"),
    ("delete", "/tasks/{phone}/some-task-id"),
    ("get",    "/agents/{phone}"),
    ("post",   "/agents/{phone}"),
    ("patch",  "/agents/{phone}/some-agent-id"),
    ("delete", "/agents/{phone}/some-agent-id"),
    ("get",    "/link/verify/{phone}"),
    ("post",   "/push/register"),
]

ADMIN_ONLY = ["/diag/sync", "/diag/embed", "/debug/graph", "/usage"]


class Unauthenticated(unittest.TestCase):
    """No token at all -> 401 on every personal-data route."""

    def test_all_protected_routes_reject_missing_token(self):
        for method, tmpl in PROTECTED:
            path = tmpl.format(phone=ALICE_PHONE)
            with self.subTest(route=f"{method.upper()} {path}"):
                # This TestClient only accepts a body on POST/PATCH/PUT.
                kwargs = {"json": {}} if method in ("post", "patch", "put") else {}
                r = getattr(client, method)(path, **kwargs)
                self.assertEqual(
                    r.status_code, 401,
                    f"{method.upper()} {path} returned {r.status_code}, expected 401",
                )

    def test_garbage_token_rejected(self):
        r = client.get(f"/tasks/{ALICE_PHONE}",
                       headers={"Authorization": "Bearer not-a-real-token"})
        self.assertEqual(r.status_code, 401)

    def test_non_bearer_scheme_rejected(self):
        r = client.get(f"/tasks/{ALICE_PHONE}",
                       headers={"Authorization": f"Basic {ALICE_PHONE}"})
        self.assertEqual(r.status_code, 401)


class CrossUserAccess(unittest.TestCase):
    """Authenticated as Alice, reaching for Bob's data -> 403. The IDOR guard."""

    def test_cannot_read_another_users_tasks(self):
        with _as(ALICE):
            r = client.get(f"/tasks/{BOB_PHONE}", headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 403)

    def test_cannot_write_into_another_users_store(self):
        with _as(ALICE):
            r = client.post(f"/tasks/{BOB_PHONE}",
                            headers={"Authorization": "Bearer x"},
                            json={"text": "planted", "date": "2026-09-09"})
        self.assertEqual(r.status_code, 403)

    def test_cannot_delete_another_users_task(self):
        with _as(ALICE):
            r = client.delete(f"/tasks/{BOB_PHONE}/whatever",
                              headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 403)

    def test_cannot_create_agent_for_another_user(self):
        """The worst of the set: this scheduled outbound WhatsApp to a stranger."""
        with _as(ALICE):
            r = client.post(f"/agents/{BOB_PHONE}",
                            headers={"Authorization": "Bearer x"},
                            json={"template": "morning_planner"})
        self.assertEqual(r.status_code, 403)

    def test_cannot_list_another_users_agents(self):
        with _as(ALICE):
            r = client.get(f"/agents/{BOB_PHONE}", headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 403)

    def test_link_verify_does_not_leak_other_users(self):
        """Anti-enumeration: Bob's number must not report as linked to Alice."""
        async def bob_owns_it(phone):
            return "bob-uuid"
        with _as(ALICE), patch("supabase_tasks.user_id_for_phone", bob_owns_it):
            r = client.get(f"/link/verify/{BOB_PHONE}",
                           headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["linked"],
                         "leaked that another account owns this number")


class OwnAccessStillWorks(unittest.TestCase):
    """The guard must not break the legitimate path."""

    def test_reads_own_tasks(self):
        with _as(ALICE):
            r = client.get(f"/tasks/{ALICE_PHONE}", headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("tasks", r.json())

    def test_write_then_read_round_trip(self):
        with _as(ALICE):
            h = {"Authorization": "Bearer x"}
            w = client.post(f"/tasks/{ALICE_PHONE}", headers=h,
                            json={"text": "yoga", "date": "2026-09-09"})
            self.assertEqual(w.status_code, 200)
            r = client.get(f"/tasks/{ALICE_PHONE}", headers=h)
        self.assertEqual(r.status_code, 200)
        self.assertIn("yoga", [t["text"] for t in r.json()["tasks"]])

    def test_own_link_verify_reports_linked(self):
        async def alice_owns_it(phone):
            return "alice-uuid"
        async def no_flush(phone):
            return 0
        with _as(ALICE), \
             patch("supabase_tasks.user_id_for_phone", alice_owns_it), \
             patch("supabase_tasks.flush_pending", no_flush):
            r = client.get(f"/link/verify/{ALICE_PHONE}",
                           headers={"Authorization": "Bearer x"})
        self.assertTrue(r.json()["linked"])


class AdminRoutes(unittest.TestCase):
    """Diagnostics disclose infrastructure detail — admin token or nothing."""

    def test_admin_routes_closed_without_token(self):
        for path in ADMIN_ONLY:
            with self.subTest(path=path):
                r = client.get(path)
                self.assertIn(
                    r.status_code, (401, 503),
                    f"{path} returned {r.status_code}; expected 401 (bad token) "
                    "or 503 (ADMIN_TOKEN unset = closed)",
                )

    def test_admin_route_rejects_wrong_token(self):
        with patch.object(config, "ADMIN_TOKEN", "the-real-token"):
            r = client.get("/diag/sync", headers={"x-admin-token": "guess"})
        self.assertEqual(r.status_code, 401)


class PublicRoutes(unittest.TestCase):
    """/health stays open on purpose — it carries no user data."""

    def test_health_is_public(self):
        self.assertEqual(client.get("/health").status_code, 200)


if __name__ == "__main__":
    unittest.main()
