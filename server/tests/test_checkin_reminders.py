"""Check-in reminders scheduled in Python, not by the model.

Covers the 7/27 failure: 'תבדקי אותי ב 13:00 וב 14:00' produced a '✅ נבדוק ב
13:00' reply with no reminder behind it. Also pins the work-range exclusion
(the '13:00 עד 17:00' window must not become two pings) and history stamping.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))

import asyncio  # noqa: E402
import main  # noqa: E402
import reminders  # noqa: E402
import user_memory  # noqa: E402
from lumi_agent import _sanitize_history  # noqa: E402
from tz import IL  # noqa: E402

PHONE = "_test_checkin_"


def _run(content, now_hhmm="11:49"):
    """Call the fast-path with a frozen 'now' and a captured reminder store."""
    scheduled = []
    real_now, real_sched, real_tasks = reminders.now_il, reminders.schedule, user_memory.tasks_for_phone
    now = datetime.now(IL).replace(hour=int(now_hhmm[:2]), minute=int(now_hhmm[3:]),
                                   second=0, microsecond=0)
    main_now = main.__dict__

    def fake_schedule(phone, hhmm, text, day=None, dest_key=None):
        fire = now.replace(hour=int(hhmm[:2]), minute=int(hhmm[3:]))
        if fire <= now:
            return False
        scheduled.append(hhmm)
        return True

    reminders.now_il = lambda: now
    reminders.schedule = fake_schedule
    user_memory.tasks_for_phone = lambda p: [
        {"text": "להגיש פוסטר על לומי", "status": "pending", "date": "2026-07-26"}]
    import tz
    real_tz_now = tz.now_il
    tz.now_il = lambda: now
    try:
        reply = asyncio.run(main._try_relative_reminder(PHONE, content, "he"))
    finally:
        reminders.now_il, reminders.schedule = real_now, real_sched
        user_memory.tasks_for_phone = real_tasks
        tz.now_il = real_tz_now
        assert main_now is main.__dict__
    return reply, scheduled


def test_absolute_times_are_scheduled():
    reply, sched = _run("תבדקי אותי ב 13:00 וב 14:00 אם התחלתי")
    assert sched == ["13:00", "14:00"], sched
    assert "13:00" in reply and "14:00" in reply


def test_work_range_is_not_a_reminder():
    # The window says when to WORK; only the times after the verb are pings.
    reply, sched = _run("בין 13:00 עד 17:00 תבדקי אותי ב 13:00 וב 14:00")
    assert sched == ["13:00", "14:00"], sched


def test_range_only_message_schedules_nothing():
    reply, sched = _run("בין 13:00 עד 17:00")
    assert sched == [] and reply is None


def test_relative_still_works():
    reply, sched = _run("תזכירי לי בעוד שעה")
    assert sched == ["12:49"], sched


def test_past_times_are_reported_not_faked():
    reply, sched = _run("תבדקי אותי ב 09:00", now_hhmm="11:49")
    assert sched == []
    assert "09:00" in reply and "עבר" in reply


def test_history_is_stamped_and_ts_key_dropped():
    out = _sanitize_history([
        {"role": "user", "content": "תבדקי אותי ב 13:00", "ts": "2026-07-26T13:00"},
        {"role": "user", "content": "no ts here"},
    ])
    assert out[0]["content"].startswith("[26/07 13:00] ")
    assert "ts" not in out[0]
    assert out[1]["content"] == "no ts here"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
