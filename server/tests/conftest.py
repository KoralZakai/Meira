"""Give the test run its own DATA_DIR, before anything imports config.

Every JSON store on this server (tasks, profiles, travel prefs, reminders,
sessions) resolves its path ONCE at import time from config.DATA_DIR, which
defaults to ".". Most test modules set DATA_DIR themselves before importing —
but a module that forgets writes into the repo, and one did: importing `main`
in test_multi_trip_chain runs a route through travel_prefs.remember, which
edited the tracked server/travel_prefs.json. That file has been showing up as
an uncommitted change ever since, holding a real phone's learned travel modes
with test counts added on top.

conftest.py is imported by pytest before any test module, which makes it the
only place that can set this for everyone. A temp directory per run also means
no test can see what a previous run left behind — the reason a suite starts
passing or failing depending on what ran before it.

Tests that set DATA_DIR themselves use os.environ.setdefault, so this wins
without any of them changing.
"""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="lumi-tests-")
os.environ["DATA_DIR"] = _TMP


# ── The suite runs at NOON of the real day ─────────────────────────────────
# tz.resolve_date_at reads the clock: before 05:00 "tomorrow" is the coming
# morning (Koral, 20.10 00:51). Tests written for the calendar rule then pass
# or fail by the hour they are run — five did, at 02:00. Every test now sees
# noon of today; a test about the night patches tz.now_il itself, which wins.
import datetime as _dt  # noqa: E402

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _noon_clock(monkeypatch):
    import tz
    real = tz.now_il()
    noon = real.replace(hour=12, minute=0, second=0, microsecond=0)
    monkeypatch.setattr(tz, "now_il", lambda: noon)
    yield
