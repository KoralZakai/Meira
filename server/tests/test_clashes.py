

def test_online_place_survives_a_preposition():
    """1.10: a call "בזום" drew "routing…" — the Hebrew preposition hid Zoom."""
    import clashes as c
    for w in ("בזום", "ב-זום", "בטימס", "on Zoom", "via Teams", "בטלפון", "phone"):
        assert c.is_online_only_place(w), w
    for w in ("בזל 5", "Zoom Cafe, Dizengoff 50", "טלפונים 4 תל אביב"):
        assert not c.is_online_only_place(w), w


def test_her_work_during_a_call_is_an_overlap():
    # 6.10: the mock-interview prep ran to 15:37 over the 15:00 Datadog call.
    import clashes as c
    prep = {"id": "prep", "text": "Prepare for: Mock interview", "fixed_time": "13:53",
            "duration_minutes": 104, "category": "course", "date": "2026-10-06"}
    call = {"id": "dd", "text": "Meira <> Datadog Intro", "fixed_time": "15:00",
            "duration_minutes": 60, "category": "call", "date": "2026-10-06",
            "meeting_url": "https://meet.google.com/abc"}
    assert c.clash_kind(prep, call, 37) == "overlap"
    assert c.clash_kind(call, prep, 37) == "overlap"
    assert c.clash_kind(prep, call, 10) == "parallel"
