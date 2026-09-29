"""The app's microphone reaches the same Whisper as WhatsApp — and says why not.

The app used Android's own recogniser, pinned to the UI language and cut off at
the first pause, so Hebrew spoken into an English UI came back as nonsense.
`POST /app/stt` hands the recording to the Whisper path WhatsApp already uses.

What is pinned here is the silent-state contract: "nobody spoke", "the server
has no key" and "the provider refused" are three different answers, never one
empty 200. No network: app_auth.verify is patched and the Groq call is stubbed
at httpx.
"""
import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient   # noqa: E402

import config                                # noqa: E402

_TMP = tempfile.mkdtemp(prefix="lumi-stt-")
config.DATA_DIR = _TMP
for _m in ("user_memory", "agents_store", "user_store", "conversation",
           "provenance", "reminders", "known_places", "travel_prefs"):
    mod = importlib.import_module(_m)
    mod._PATH = os.path.join(_TMP, os.path.basename(getattr(mod, "_PATH")))

import main            # noqa: E402
import app_auth        # noqa: E402
import rate_limit      # noqa: E402
import stt             # noqa: E402

client = TestClient(main.app)
AUTH = {"Authorization": "Bearer good-token"}
AUDIO = ("voice.m4a", b"\x00\x00\x00\x18ftypM4A fake-aac-bytes", "audio/mp4")


def _signed_in():
    async def fake_verify(authorization):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise app_auth.AuthError("missing bearer token")
        return {"userId": "alice-uuid", "email": "alice@example.com"}

    async def fake_phone(user_id):
        return "972500000001"

    return patch.multiple(app_auth, verify=fake_verify, phone_for_user_id=fake_phone)


class _Resp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class _FakeClient:
    """Stands in for httpx.AsyncClient; records what would have been sent."""
    sent: list = []
    reply = _Resp(200, {"text": "אני חייבת לעבוד היום על Meira"})

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, data=None, files=None):
        _FakeClient.sent.append({"url": url, "data": data, "files": files})
        return _FakeClient.reply


class SttRouteTest(unittest.TestCase):
    def setUp(self):
        rate_limit.reset()
        _FakeClient.sent = []
        _FakeClient.reply = _Resp(200, {"text": "אני חייבת לעבוד היום על Meira"})
        self._key = patch.object(config, "GROQ_API_KEY", "gsk_test")
        self._http = patch("stt.httpx.AsyncClient", _FakeClient)
        self._key.start()
        self._http.start()

    def tearDown(self):
        self._http.stop()
        self._key.stop()

    def _post(self, hint=""):
        with _signed_in():
            return client.post("/app/stt", headers=AUTH, files={"file": AUDIO},
                               data={"hint": hint} if hint else {})

    def test_requires_sign_in(self):
        r = client.post("/app/stt", files={"file": AUDIO})
        self.assertEqual(r.status_code, 401)

    def test_mixed_hebrew_english_comes_back_as_text(self):
        r = self._post()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"text": "אני חייבת לעבוד היום על Meira"})

    def test_language_is_never_pinned(self):
        """Pinning a language is the exact bug the app had."""
        self._post()
        self.assertNotIn("language", _FakeClient.sent[0]["data"])

    def test_the_file_name_matches_the_recorded_format(self):
        self._post()
        name, _, mime = _FakeClient.sent[0]["files"]["file"]
        self.assertEqual(name, "voice.m4a")
        self.assertEqual(mime, "audio/mp4")

    def test_hint_becomes_a_capped_whisper_prompt(self):
        self._post(hint="  Meira,   Ceva  , " + "x" * 1000)
        prompt = _FakeClient.sent[0]["data"]["prompt"]
        self.assertTrue(prompt.startswith(stt.PRIMER))
        self.assertIn("Meira, Ceva", prompt)
        self.assertLessEqual(len(prompt), stt.MAX_PROMPT_CHARS)

    def test_task_titles_and_questions_never_reach_whisper(self):
        """2026-09-28: her task titles in the hint turned a Hebrew recording into
        English interview questions — "1. Why did you apply? 2. …"."""
        prompt = stt.clean_prompt(
            "Final review for ראיון בטלפון עם אמזון — questions to ask, what to wear, "
            "Why did you apply?, Space Gym, אלנבי 30, Checkpoint")
        self.assertTrue(prompt.startswith(stt.PRIMER))
        self.assertNotIn("Final review", prompt)
        self.assertNotIn("Why", prompt)
        for name in ("Space Gym", "אלנבי 30", "Checkpoint"):
            self.assertIn(name, prompt)

    def test_an_echoed_primer_is_not_speech(self):
        self.assertEqual(stt._without_primer("מאירה, תרשמי לי: אימון ב-6"), "אימון ב-6")
        self.assertEqual(stt._without_primer("מאירה, תרשמי לי"), "")

    def test_silence_is_no_speech_not_an_empty_success(self):
        _FakeClient.reply = _Resp(200, {"text": "   "})
        r = self._post()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["error"], "no_speech")
        self.assertNotIn("text", r.json())

    def test_provider_refusal_is_named(self):
        _FakeClient.reply = _Resp(401, text="invalid api key")
        r = self._post()
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["error"], "provider_failed")
        self.assertIn("401", r.json()["detail"])

    def test_missing_key_is_named(self):
        with patch.object(config, "GROQ_API_KEY", ""):
            r = self._post()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"], "stt_not_configured")
        self.assertEqual(_FakeClient.sent, [], "no provider call without a key")

    def test_oversized_upload_is_refused_before_the_provider(self):
        with _signed_in(), patch("routes_app.STT_MAX_BYTES", 8):
            r = client.post("/app/stt", headers=AUTH, files={"file": AUDIO})
        self.assertEqual(r.status_code, 413)
        self.assertEqual(_FakeClient.sent, [])

    def test_whatsapp_signature_is_unchanged(self):
        """The webhook still gets str | None from transcribe()."""
        text = asyncio.run(stt.transcribe(b"ogg-bytes", "audio/ogg; codecs=opus"))
        self.assertEqual(text, "אני חייבת לעבוד היום על Meira")
        self.assertEqual(_FakeClient.sent[0]["files"]["file"][0], "voice.ogg")
        _FakeClient.reply = _Resp(500, text="boom")
        self.assertIsNone(asyncio.run(stt.transcribe(b"ogg-bytes")))


class PhantomSpeechTest(unittest.TestCase):
    """Five silent seconds on her phone came back as "Ckep, Pekka, and the rest
    of the team." — and the voice planner tried to plan it."""

    def test_silence_that_whisper_filled_in_is_dropped(self):
        body = {"text": "Ckep, Pekka, and the rest of the team.",
                "segments": [{"text": "Ckep, Pekka, and the rest of the team.",
                              "no_speech_prob": 0.72, "avg_logprob": -1.3}]}
        self.assertEqual(stt.heard_text(body), "")

    def test_what_she_said_is_kept_next_to_a_phantom(self):
        body = {"segments": [
            {"text": "אימון ב 6 בערב", "no_speech_prob": 0.02, "avg_logprob": -0.3},
            {"text": "Thank you for watching!", "no_speech_prob": 0.4, "avg_logprob": -0.6},
        ]}
        self.assertEqual(stt.heard_text(body), "אימון ב 6 בערב")

    def test_confident_speech_in_a_quiet_room_is_kept(self):
        body = {"segments": [{"text": "קריוקי באלנבי 30", "no_speech_prob": 0.7,
                              "avg_logprob": -0.2}]}
        self.assertEqual(stt.heard_text(body), "קריוקי באלנבי 30")

    def test_no_segments_falls_back_to_text(self):
        self.assertEqual(stt.heard_text({"text": " יוגה ב-11 "}), "יוגה ב-11")


class HebrewRetryTest(unittest.TestCase):
    """Twice on her phone a Hebrew recording came back as unsure English:
    "…Khmer, Madagascar, Badawad". Ask again in Hebrew and keep the surer one."""

    GUESSED = {"language": "english", "text": "Khmer, Madagascar, Badawad",
               "segments": [{"text": "Khmer, Madagascar, Badawad", "no_speech_prob": 0.1,
                             "avg_logprob": -1.2}]}
    HEBREW = {"language": "hebrew", "text": "אימון ב 6 בערב",
              "segments": [{"text": "אימון ב 6 בערב", "no_speech_prob": 0.05,
                            "avg_logprob": -0.25}]}

    def setUp(self):
        self.replies = []
        self.sent = []
        test = self

        class _Seq(_FakeClient):
            async def post(self, url, headers=None, data=None, files=None):
                test.sent.append(data)
                return test.replies.pop(0)

        self.patches = [patch.object(stt.httpx, "AsyncClient", _Seq),
                        patch.object(stt.config, "GROQ_API_KEY", "k")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_unsure_english_is_asked_again_in_hebrew(self):
        self.replies = [_Resp(200, self.GUESSED), _Resp(200, self.HEBREW)]
        res = asyncio.run(stt.transcribe_detailed(b"m4a", "audio/mp4"))
        self.assertEqual(res.text, "אימון ב 6 בערב")
        self.assertEqual(self.sent[1].get("language"), "he")

    def test_confident_english_is_left_alone(self):
        sure = {"language": "english", "text": "call Dana at five",
                "segments": [{"text": "call Dana at five", "no_speech_prob": 0.02,
                              "avg_logprob": -0.2}]}
        self.replies = [_Resp(200, sure)]
        res = asyncio.run(stt.transcribe_detailed(b"m4a", "audio/mp4"))
        self.assertEqual(res.text, "call Dana at five")
        self.assertEqual(len(self.sent), 1)


if __name__ == "__main__":
    unittest.main()
