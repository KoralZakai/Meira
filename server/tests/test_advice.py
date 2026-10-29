"""advice — two options she picks, the other moved, a message she sends (27.10)."""
import asyncio
import json
import os
import sys
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import advice  # noqa: E402
import agent_turn  # noqa: E402
import understand  # noqa: E402

CONF_A = {"id": "a", "text": "כנס AI בתל אביב", "date": "2026-10-29", "fixed_time": "10:00", "duration_minutes": 240}
CONF_B = {"id": "b", "text": "כנס סייבר בחיפה", "date": "2026-10-29", "fixed_time": "11:00", "duration_minutes": 180}
YOSI = {"id": "y", "text": "שיחה עם יוסי", "date": "2026-10-29", "fixed_time": "16:00", "duration_minutes": 30,
        "attendees": "yosi@example.com", "contactPhone": "050-1234567"}
NINE_AM = datetime(2026, 10, 29, 9, 0, tzinfo=agent_turn._tz.IL)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _model(payload):
    reply = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))],
                            usage=None)
    client = mock.MagicMock()
    client.chat.completions.create = mock.AsyncMock(return_value=reply)
    return mock.patch.object(understand, "_client", lambda: client), client


class Recognising(unittest.TestCase):
    def test_choice_about_her_events_only(self):
        self.assertTrue(advice.wants_choice("מאירה במה כדאי לי לבחור, איזה כנס יותר יעזור לי?"))
        self.assertTrue(advice.wants_choice("which one should I pick, they overlap"))
        self.assertFalse(advice.wants_choice("מה כדאי לי לאכול?"))

    def test_move_and_confirm(self):
        self.assertTrue(advice.wants_move("מאירה לאן כדאי להזיז את השיחה עם יוסי?"))
        self.assertTrue(advice.wants_move("where should I move the call with Yossi?"))
        self.assertTrue(advice.confirms("יוסי אישר"))
        self.assertFalse(advice.confirms("יוסי אישר אבל רק אם נעשה את זה בזום ובשעה אחרת לגמרי"))

    def test_the_overlap_is_found(self):
        self.assertEqual(advice.overlapping_pair([YOSI, CONF_B, CONF_A]), (CONF_A, CONF_B))


class TwoOptions(unittest.TestCase):
    def test_two_reasons_a_lean_and_her_pick(self):
        patcher, client = _model({"options": [
            {"task_id": "a", "for": "קרוב לבית ותואם למשרה שאת מחפשת", "against": "צפוף"},
            {"task_id": "b", "for": "אנשי תעשייה אווירית", "against": "שעה וחצי נסיעה"}],
            "lean": "a", "why": "המטרה שלך עכשיו היא משרת AI"})
        with patcher:
            text, ids = run(advice.choose(CONF_A, CONF_B, [CONF_A, CONF_B], "מחפשת משרת AI", "איזה כנס?", True))
        self.assertEqual(ids, ["a", "b"])
        self.assertIn("1️⃣ כנס AI בתל אביב — קרוב לבית", text)
        self.assertIn("2️⃣ כנס סייבר בחיפה", text)
        self.assertIn("אני נוטה ל", text)
        self.assertTrue(text.rstrip().endswith("כתבי 1 או 2"))
        sent = client.chat.completions.create.call_args.kwargs["messages"][1]["content"]
        self.assertIn("מחפשת משרת AI", sent, "what Meira knows about her is weighed")

    def test_no_model_still_two_options(self):
        client = mock.MagicMock()
        client.chat.completions.create = mock.AsyncMock(side_effect=RuntimeError("down"))
        with mock.patch.object(understand, "_client", lambda: client):
            text, _ = run(advice.choose(CONF_A, CONF_B, [], "", "?", True))
        self.assertIn("לא הצלחתי לשקול", text)
        self.assertIn("1️⃣", text)
        self.assertIn("2️⃣", text)


class MovingWithAPerson(unittest.TestCase):
    def test_two_free_slots_never_on_top_of_anything(self):
        busy = {"id": "z", "date": "2026-10-29", "fixed_time": "16:30", "duration_minutes": 120}
        slots = advice.two_slots(YOSI, [YOSI, busy], 9 * 60, "2026-10-29")
        self.assertEqual(len(slots), 2)
        self.assertEqual(slots[0], ("2026-10-29", "18:45"))
        self.assertEqual(slots[1][0], "2026-10-30")

    def test_the_draft_and_the_ways_to_send_it(self):
        d = advice.draft(YOSI, "2026-10-30", "09:00", True)
        self.assertIn("יוסי", d["text"])
        self.assertIn("30.10 09:00", d["text"])
        self.assertTrue(d["links"]["email"].startswith("mailto:yosi@example.com"))
        self.assertTrue(d["links"]["whatsapp"].startswith("https://wa.me/972501234567"))
        self.assertIn("sms", d["links"])

    def test_no_contact_means_no_links(self):
        d = advice.draft({"text": "שיחה עם דנה", "date": "2026-10-29", "fixed_time": "10:00"},
                         "2026-10-30", "09:00", True)
        self.assertEqual(d["links"], {})
        self.assertEqual(d["to"]["name"], "דנה")


class TheTurn(unittest.TestCase):
    """The whole flow on the turn: move → pick slot → maybe + draft → confirmed."""

    def _env(self, store, day):
        patched: dict = {}

        def set_choice(p, owner, count, options=None, context=None):
            store["choice"] = {"owner": owner, "count": count, "options": options, "context": context}

        async def patch_task(p, task_id, patch):
            patched.setdefault(task_id, []).append(patch)
            return True

        return [mock.patch.object(agent_turn, "_her_days", mock.AsyncMock(return_value=day)),
                mock.patch.object(agent_turn.session, "get_pending_choice", lambda p: store.get("choice")),
                mock.patch.object(agent_turn.session, "set_pending_choice", set_choice),
                mock.patch.object(agent_turn.session, "clear_pending_choice", lambda p: store.pop("choice", None)),
                mock.patch.object(agent_turn.session, "get_maybe", lambda p: store.get("maybe")),
                mock.patch.object(agent_turn.session, "set_maybe",
                                  lambda p, t, w: store.update(maybe={"task_id": t, "who": w})),
                mock.patch.object(agent_turn.session, "clear_maybe", lambda p: store.pop("maybe", None)),
                mock.patch.object(agent_turn, "_patch_task", patch_task),
                mock.patch.object(agent_turn._tz, "now_il", lambda: NINE_AM)], patched

    def _with(self, patches):
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])

    def test_move_pick_maybe_confirm(self):
        store: dict = {}
        patches, patched = self._env(store, [YOSI])
        self._with(patches)
        out = run(agent_turn.advice_turn("p", "לאן כדאי להזיז את השיחה עם יוסי?", {}, "u"))
        self.assertIn("1)", out["text"])
        self.assertEqual(store["choice"]["owner"], advice.MOVE_OWNER)
        out = run(agent_turn.advice_turn("p", "2", {}, "u"))
        self.assertIn("⏳", out["text"])
        self.assertIn("«", out["text"])
        self.assertIn("WhatsApp", out["text"])
        self.assertIn("draft", out)
        self.assertTrue(patched["y"][0]["notes"].startswith("⏳"))
        self.assertEqual(store["maybe"]["task_id"], "y")
        out = run(agent_turn.advice_turn("p", "יוסי אישר", {}, "u"))
        self.assertIn("קורה", out["text"])
        self.assertEqual(patched["y"][-1], {"notes": ""})

    def test_choose_then_the_other_is_offered_a_move(self):
        store: dict = {}
        patches, _ = self._env(store, [CONF_A, CONF_B])
        patcher, _ = _model({"options": [{"task_id": "a", "for": "x"}, {"task_id": "b", "for": "y"}], "lean": None})
        self._with([*patches, patcher,
                    mock.patch.object(agent_turn.user_memory, "format_for_prompt", lambda k: ""),
                    mock.patch.object(agent_turn.user_profile, "get_profile", lambda k: {})])
        out = run(agent_turn.advice_turn("p", "במה כדאי לי לבחור? הכנסים חופפים", {}, "u"))
        self.assertIn("1️⃣", out["text"])
        out = run(agent_turn.advice_turn("p", "הראשון", {}, "u"))
        self.assertIn("בחרת: כנס AI בתל אביב", out["text"])
        self.assertIn("כנס סייבר בחיפה", out["text"])
        self.assertEqual(store["choice"]["owner"], advice.MOVE_OWNER)

    def test_unrelated_message_is_left_alone(self):
        store: dict = {}
        patches, _ = self._env(store, [CONF_A, CONF_B])
        self._with(patches)
        self.assertIsNone(run(agent_turn.advice_turn("p", "מה כדאי לי לאכול?", {}, "u")))


if __name__ == "__main__":
    unittest.main()
