"""phone_links — a WhatsApp number is linked to an account only by PROOF.

7.10 audit: the server believed app_settings."whatsAppPhone", a field the user
types. A stranger who typed someone's number became her (tasks, places, memory,
alerts). What must hold now:
  * identify() and user_id_for_phone() read ONLY proved links, exact digits;
  * a link is made only by the code arriving FROM the number (Meta's `from`);
  * codes expire, are single-use, and a number may guess only 5 times a day;
  * proving a number moves it: one number, one account;
  * a number two accounts claimed is grandfathered to neither.
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import app_auth  # noqa: E402
import phone_links  # noqa: E402
import supabase_tasks  # noqa: E402

DANA = "11111111-1111-4111-8111-111111111111"
EVE = "22222222-2222-4222-8222-222222222222"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = mock.patch.object(phone_links, "_PATH", os.path.join(self.tmp.name, "links.json"))
        self.p.start()

    def tearDown(self):
        self.p.stop()
        self.tmp.cleanup()

    def link(self, uid, phone):
        code = phone_links.start(uid)["code"]
        return phone_links.confirm(phone, f"קוד חיבור למאירה: {code}")


class Proof(Base):
    def test_the_code_sent_from_the_number_links_it(self):
        self.assertTrue(self.link(DANA, "972541234567")["ok"])
        self.assertEqual(phone_links.phone_for(DANA), "972541234567")
        self.assertEqual(phone_links.user_for("972541234567"), DANA)

    def test_a_wrong_code_links_nothing(self):
        phone_links.start(DANA)
        res = phone_links.confirm("972541234567", "קוד חיבור למאירה: 000000")
        self.assertFalse(res["ok"])
        self.assertIsNone(phone_links.user_for("972541234567"))

    def test_codes_are_single_use(self):
        code = phone_links.start(DANA)["code"]
        self.assertTrue(phone_links.confirm("972541234567", f"link {code}")["ok"])
        self.assertFalse(phone_links.confirm("972549999999", f"link {code}")["ok"])
        self.assertEqual(phone_links.user_for("972541234567"), DANA)

    def test_codes_expire(self):
        code = phone_links.start(DANA)["code"]
        with mock.patch("phone_links.time.time", return_value=time.time() + phone_links.CODE_TTL_S + 1):
            self.assertEqual(phone_links.confirm("972541234567", f"link {code}")["reason"],
                             "wrong_or_expired")

    def test_five_wrong_guesses_a_day_then_locked(self):
        code = phone_links.start(DANA)["code"]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(phone_links.MAX_FAILS_PER_DAY):
            phone_links.confirm("972549999999", f"link {wrong}")
        self.assertEqual(phone_links.confirm("972549999999", f"link {code}")["reason"],
                         "too_many_attempts")

    def test_proving_a_number_moves_it_to_the_prover(self):
        self.link(EVE, "972541234567")
        self.link(DANA, "972541234567")
        self.assertEqual(phone_links.user_for("972541234567"), DANA)
        self.assertIsNone(phone_links.phone_for(EVE))

    def test_ordinary_messages_are_not_codes(self):
        self.assertFalse(phone_links.looks_like_code("תזכירי לי מחר ב-10 להתקשר ל-0541234567"))
        self.assertTrue(phone_links.looks_like_code("קוד חיבור למאירה: 123456"))


class NoTrustInTheTypedField(Base):
    def test_identify_ignores_app_settings(self):
        # Even if app_settings said EVE owns Dana's number, identify() asks phone_links.
        with mock.patch.object(app_auth, "verify", new=mock.AsyncMock(
                return_value={"userId": EVE, "email": "e@x"})), \
             mock.patch("identity_keys.note_caller"), mock.patch("identity_keys.report_split"):
            caller = asyncio.run(app_auth.identify("Bearer t"))
        self.assertIsNone(caller["phone"])
        self.assertEqual(caller["key"], EVE)

    def test_user_id_for_phone_is_exact_and_proved(self):
        self.link(DANA, "972541234567")
        self.assertEqual(asyncio.run(supabase_tasks.user_id_for_phone("972541234567")), DANA)
        self.assertIsNone(asyncio.run(supabase_tasks.user_id_for_phone("0541234567")))
        self.assertIsNone(asyncio.run(supabase_tasks.user_id_for_phone("972500000000")))

    def test_a_stranger_cannot_reach_her_tasks_by_url(self):
        self.link(DANA, "972541234567")
        with self.assertRaises(Exception) as ctx:
            app_auth.storage_key_for({"userId": EVE, "phone": None, "key": EVE}, "972541234567")
        self.assertEqual(getattr(ctx.exception, "status_code", None), 403)


class Grandfather(Base):
    def run_with(self, rows):
        resp = mock.MagicMock(status_code=200, json=lambda: rows)
        client = mock.MagicMock()
        client.__aenter__ = mock.AsyncMock(return_value=client)
        client.__aexit__ = mock.AsyncMock(return_value=False)
        client.get = mock.AsyncMock(return_value=resp)
        with mock.patch("phone_links.httpx.AsyncClient", return_value=client), \
             mock.patch("supabase_tasks._enabled", return_value=True):
            return asyncio.run(phone_links.grandfather())

    def test_existing_pairs_are_kept_and_disputed_ones_are_not(self):
        out = self.run_with([
            {"userId": DANA, "whatsAppPhone": "+972 54-123-4567"},
            {"userId": EVE, "whatsAppPhone": "972529999999"},
            {"userId": "33333333-3333-4333-8333-333333333333", "whatsAppPhone": "972529999999"},
        ])
        self.assertEqual(out, {"adopted": 1, "conflicts": 1})
        self.assertEqual(phone_links.user_for("972541234567"), DANA)
        self.assertIsNone(phone_links.user_for("972529999999"))
        self.assertEqual(self.run_with([]), {"skipped": True})   # once only


if __name__ == "__main__":
    unittest.main()
