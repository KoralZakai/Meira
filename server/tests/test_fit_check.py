"""fit_check — a saved meeting that cannot be reached is said, with the nearest hour that can.

Koral, 28.10: many meetings, another comes in — does it fit? If not, warn and
ask: keep it anyway, or a new time.
"""
import asyncio

import fit_check


def run(coro):
    return asyncio.run(coro)


ROAD = {("tel aviv", "haifa"): 80, ("haifa", "tel aviv"): 80, ("tel aviv", "ramat gan"): 15,
        ("ramat gan", "tel aviv"): 15}


async def travel(a, b, _arrive):
    return ROAD.get((a.lower(), b.lower()))


async def unknown(_a, _b, _arrive):
    return None


def row(id_, text, start, minutes, place):
    return {"id": id_, "text": text, "fixed_time": start, "duration_minutes": minutes,
            "location": place, "status": "pending", "date": "2026-10-29"}


DAY = [row("a", "Standup", "09:00", 60, "Tel Aviv"), row("b", "Client", "13:00", 60, "Tel Aviv")]


def test_overlap_is_not_a_fit():
    new = row("n", "Dentist", "13:30", 30, "Tel Aviv")
    v = run(fit_check.judge(new, "13:30", DAY + [new], travel))
    assert not v["fits"] and v["kind"] == "overlap" and "Client" in v["reason_en"]


def test_no_overlap_but_no_time_to_drive_there():
    # Ends 14:00 in Tel Aviv, Haifa at 14:15 is 80 min away — the clock alone says "free".
    new = row("n", "Haifa meeting", "14:15", 45, "Haifa")
    v = run(fit_check.judge(new, "14:15", DAY + [new], travel))
    assert not v["fits"] and v["kind"] == "travel_in" and "80" in v["reason_en"]


def test_no_time_to_get_to_the_next_one():
    new = row("n", "Haifa meeting", "10:30", 60, "Haifa")   # standup ends 10:00, Haifa is 80 min away
    assert run(fit_check.judge(new, "10:30", DAY + [new], travel))["fits"] is False
    later = row("n", "Haifa meeting", "11:30", 60, "Haifa")  # 10:00+80=11:20 ok; ends 12:30, +80 = 13:50 > 13:00
    v = run(fit_check.judge(later, "11:30", DAY + [later], travel))
    assert not v["fits"] and v["kind"] == "travel_out"


def test_a_video_call_needs_no_trip():
    new = row("n", "Zoom sync", "14:05", 30, "Zoom")
    assert run(fit_check.judge(new, "14:05", DAY + [new], travel))["fits"]


def test_unmeasured_trip_is_said_never_zero():
    new = row("n", "Haifa meeting", "14:15", 45, "Haifa")
    v = run(fit_check.judge(new, "14:15", DAY + [new], unknown))
    assert v["fits"] and v["unchecked"] is True


def test_alternative_is_checked_by_the_same_rule():
    new = row("n", "Haifa meeting", "14:15", 45, "Haifa")
    alt = run(fit_check.find_alternative(new, "14:15", DAY + [new], fit_check.cached(travel)))
    assert alt is not None
    assert run(fit_check.judge(new, alt, DAY + [new], travel))["fits"]
    assert alt >= "15:20"   # 14:00 + 80 min, on the 15-minute grid


def test_question_and_answers_in_hebrew():
    new = row("n", "פגישה בחיפה", "14:15", 45, "Haifa")
    v = run(fit_check.judge(new, "14:15", DAY + [new], travel))
    q = fit_check.question(new, v, "15:30", he=True)
    assert "לא נכנס" in q and "15:30" in q and "לשמור בכל זאת" in q
    assert fit_check.replies("15:30", True) == ["לשמור בכל זאת", "לקבוע ב-15:30"]
    pending = {"alt": "15:30"}
    assert fit_check.reading("לקבוע ב-15:30", pending) == "move"
    assert fit_check.reading("לשמור בכל זאת", pending) == "keep"
    assert fit_check.reading("Keep it anyway", pending) == "keep"
    assert fit_check.reading("מה יש לי מחר?", pending) is None


def test_done_tasks_do_not_block():
    done = dict(DAY[1], status="complete")
    new = row("n", "Dentist", "13:30", 30, "Tel Aviv")
    assert run(fit_check.judge(new, "13:30", [DAY[0], done, new], travel))["fits"]


def test_only_her_answer_moves_the_task():
    # A different request that happens to carry the hour or the verb must not move THIS task.
    pending = {"alt": "15:30"}
    assert fit_check.reading("תזכירי לי ב-15:30 להתקשר לאמא", pending) is None
    assert fit_check.reading("להזיז את הפגישה עם דני", pending) is None
    assert fit_check.reading("remind me at 15:30 to call mom", pending) is None
    assert fit_check.reading("15:30", pending) == "move"
    assert fit_check.reading("Move to 15:30", pending) == "move"
    assert fit_check.reading("בכל זאת", {"alt": None}) == "keep"


def test_geocode_is_paid_once_per_address(monkeypatch):
    import geo
    calls = []

    async def fake(address, bounds=None):
        calls.append(address)
        return {"formatted": address, "lat": 32.0, "lng": 34.8, "place_id": None, "partial": False}
    monkeypatch.setattr(geo, "_geocode_uncached", fake)
    geo._geocode_cache.clear()
    run(geo.geocode("Dizengoff 50, Tel Aviv"))
    run(geo.geocode("dizengoff 50, tel aviv "))
    assert calls == ["Dizengoff 50, Tel Aviv"]
    geo._geocode_cache.clear()
