"""7.10 privacy: nothing in the logs or the history can be used to follow her.

  * logs: coordinates, phones, API keys, tokens and emails never come out;
    httpx (which logged every outbound URL, query string included) is silent;
  * history: the live fix and a shared pin never enter a stored turn;
  * a WhatsApp-shared pin is forgotten after 30 minutes;
  * a judge note that names her people or places is dropped (it reaches
    everyone's prompt);
  * deletion removes list-shaped stores (reminders, agents) too.
"""
import io
import logging
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import log_redact  # noqa: E402
import privacy  # noqa: E402


class Logs(unittest.TestCase):
    def capture(self, msg, *args):
        buf = io.StringIO()
        h = logging.StreamHandler(buf)
        lg = logging.getLogger("privacy-test")
        lg.handlers, lg.propagate = [h], False
        h.addFilter(log_redact.RedactFilter())
        lg.warning(msg, *args)
        return buf.getvalue()

    def test_nothing_that_finds_her_survives(self):
        out = self.capture(
            "GET https://maps.googleapis.com/x?origin=32.08530,34.78180&destination=%s&key=AIzaSyDp0123456789abcdefghijklmnopqrstu "
            "user=%s phone=%s Authorization: Bearer abc.def.ghi mail=dana@example.com filter=userKey=eq.972541234567",
            "32.1,34.8", "+972 54-123-4567", "0541234567")
        for leaked in ("32.08530", "34.78180", "AIzaSy", "54-123", "0541234567", "abc.def",
                       "dana@example.com", "972541234567"):
            self.assertNotIn(leaked, out)
        self.assertIn("***567", out)

    def test_ordinary_lines_are_untouched(self):
        self.assertEqual(log_redact.redact("directions [ZERO_RESULTS] at 08:20 on 2026-10-07"),
                         "directions [ZERO_RESULTS] at 08:20 on 2026-10-07")

    def test_an_access_line_keeps_its_shape(self):
        # uvicorn's AccessFormatter unpacks five args; None made every request
        # print "--- Logging error ---" instead of its line (8.10).
        from uvicorn.logging import AccessFormatter
        record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                                   '%s - "%s %s HTTP/%s" %d', ("1.2.3.4:5", "GET",
                                   "/app/x?origin=32.08530,34.78180&key=secret", "1.1", 200), None)
        self.assertTrue(log_redact.RedactFilter().filter(record))
        line = AccessFormatter("%(message)s", use_colors=False).format(record)
        self.assertIn('"GET /app/x?origin=<coords>&key=*** HTTP/1.1" 200', line)

    def test_httpx_is_quiet(self):
        log_redact.install()
        self.assertGreaterEqual(logging.getLogger("httpx").level, logging.WARNING)


class History(unittest.TestCase):
    def test_the_live_fix_never_enters_a_stored_turn(self):
        import agent_turn
        import conversation
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(conversation, "_PATH", os.path.join(d, "c.json")), \
             mock.patch("database_service.shadow_write") as shadow, \
             mock.patch("database_service.append_turn"):
            msg = agent_turn._here_stamp({"lat": 32.0853, "lng": 34.7818, "label": "דיזנגוף 50"}) + "איך מגיעים הביתה?"
            conversation.append("972500000001", msg, "קו 5 בעוד 4 דק׳")
            stored = conversation.get_history("972500000001")[0]["content"]
            self.assertEqual(stored, "איך מגיעים הביתה?")
            self.assertTrue(shadow.called)

    def test_a_shared_pin_and_bare_coordinates_are_stripped(self):
        self.assertEqual(privacy.strip_location(
            "(I'm sharing my current location: Dizengoff 50, Tel Aviv) route home"), "route home")
        self.assertEqual(privacy.strip_location("from 32.0853,34.7818 please"), "from  please")


class Pins(unittest.TestCase):
    def test_a_pin_is_forgotten_after_thirty_minutes(self):
        pin = {"currentAddress": "Dizengoff 50", "currentLat": 32.08, "currentLng": 34.78}
        fresh = privacy.without_stale_current({**pin, "currentAt": time.time()})
        self.assertEqual(fresh["currentAddress"], "Dizengoff 50")
        stale = privacy.without_stale_current({**pin, "currentAt": time.time() - 31 * 60})
        self.assertEqual(stale["currentAddress"], "")
        self.assertIsNone(privacy.without_stale_current(pin)["currentLat"])   # undated = stale


class JudgeNotes(unittest.TestCase):
    def test_a_note_naming_her_world_is_dropped(self):
        task = {"text": "ראיון ב-Ceva", "location": {"address": "Raanana"}, "contact": {"name": "Danny"}}
        self.assertEqual(privacy.scrub_note("Confirm the Ceva interview address", "", task), "")
        self.assertEqual(privacy.scrub_note("Ask Danny before saving", "", task), "")
        self.assertEqual(privacy.scrub_note("Leave at 8 next time", "", task), "")
        self.assertEqual(privacy.scrub_note("Ask for the duration before saving", "", task),
                         "Ask for the duration before saving")


class Deletion(unittest.TestCase):
    def test_list_stores_lose_her_rows_and_keep_others(self):
        import account_deletion
        rows = [{"phone": "972500000001", "text": "mine"}, {"phone": "972500000002", "text": "theirs"}]
        fake = mock.MagicMock(_load=mock.MagicMock(return_value=list(rows)))
        with mock.patch.object(account_deletion, "_STORE_MODULES", ("reminders",)), \
             mock.patch("importlib.import_module", return_value=fake), \
             mock.patch.object(account_deletion, "_purge_pending_mirror", return_value="absent"):
            out = account_deletion.purge_local_stores("972500000001")
        self.assertEqual(out["reminders"], "deleted")
        fake._save.assert_called_once_with([rows[1]])


if __name__ == "__main__":
    unittest.main()
