"""place_reminder — "when I get to X, remind me Y" is a place reminder, read in code, both languages."""
import asyncio

import place_reminder as pr


def test_hebrew_arrive_both_orders():
    assert pr.parse("כשאגיע לעבודה תזכירי לי להתקשר לדני") == {
        "trigger": "arrive", "place": "עבודה", "what": "להתקשר לדני", "person": "דני"}  # 29.10: which Dani is asked
    p = pr.parse("תזכירי לי לקנות חלב כשאגיע לסופר")
    assert p["trigger"] == "arrive" and p["place"] == "סופר" and p["what"] == "לקנות חלב"


def test_hebrew_leave():
    p = pr.parse("כשאצא מהבית תזכירי לי לקחת מטען")
    assert p == {"trigger": "leave", "place": "הבית", "what": "לקחת מטען"}
    assert pr.parse("תזכירי לי לנעול את הדלת כשאני יוצאת מהמשרד")["place"] == "המשרד"


def test_english():
    assert pr.parse("When I get to work, remind me to call Danny") == {
        "trigger": "arrive", "place": "work", "what": "call Danny"}
    assert pr.parse("remind me to take the charger when I leave home")["trigger"] == "leave"
    assert pr.parse("when I get home remind me to water the plants")["place"] == "home"


def test_not_a_place_reminder():
    assert pr.parse("תזכירי לי מחר ב-9 להתקשר לדני") is None
    assert pr.parse("remind me at 15:00 to call mom") is None
    assert pr.parse("מה יש לי היום?") is None


def test_home_and_work_kinds():
    assert pr.kind_of("הבית") == "home" and pr.kind_of("Home") == "home"
    assert pr.kind_of("העבודה") == "work" and pr.kind_of("the office") == "work"
    assert pr.kind_of("סופר") is None


def test_unknown_home_asks_instead_of_promising(monkeypatch):
    out = asyncio.run(pr.turn("+972500000000", "כשאגיע הביתה תזכירי לי להשקות", {"homeAddress": ""}))
    assert out and "place_reminders" not in out and "כתובת" in out["text"]


def test_known_home_returns_a_reminder_for_the_phone(monkeypatch):
    import geo

    async def fake(address, bounds=None):
        return {"formatted": address, "lat": 32.07, "lng": 34.78, "place_id": None, "partial": False}
    monkeypatch.setattr(geo, "geocode", fake)
    out = asyncio.run(pr.turn("+972500000000", "כשאצא מהבית תזכירי לי לקחת מטען", {"homeAddress": "הרצל 5 תל אביב"}))
    r = out["place_reminders"][0]
    assert r["trigger"] == "leave" and r["text"] == "לקחת מטען" and r["lat"] == 32.07
    assert "כשתצאי מהבית" in out["text"]


def test_hebrew_prepositions():
    assert pr.he_when("arrive", "הבית", True) == "כשתגיעי הביתה"
    assert pr.he_when("arrive", "העבודה", True) == "כשתגיעי לעבודה"
    assert pr.he_when("arrive", "סופר", False) == "הגעת לסופר"
    assert pr.he_when("leave", "הבית", False) == "יצאת מהבית"


def test_heading_to_a_place_reminds_on_leaving_home_and_names_the_person():
    # Koral 29.10: "Remember me when i am heading to Florentin to return the pc to Moshe"
    p = pr.parse("Remember me when i am heading to Florentin to return the pc to Moshe")
    assert p == {"trigger": "leave", "place": "home", "what": "return the pc to Moshe",
                 "dest": "Florentin", "person": "Moshe"}
    p = pr.parse("תזכירי לי כשאני בדרך לפלורנטין להחזיר את המחשב למשה")
    assert p["trigger"] == "leave" and p["dest"] == "פלורנטין" and p["person"] == "משה"
