"""place_reminder — "when I get to work, remind me to call Danny" / "כשאצא מהבית תזכירי לי מטען".

Koral, 28.10: Meira should remind by PLACE, not only by hour. set_reminder
takes a clock time; nothing could hold "when I arrive". Read in code (rule:
lookups and patterns are not the model's job), resolved to a real place
(home / work from her profile, a place she taught Meira, else Google), and
handed to the phone, which watches it with a geofence (GeofenceService) —
the server never learns when she arrives anywhere.

`parse` is pure. `resolve_place` and `turn` do the I/O.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

_REMIND_HE = r"(?:תזכיר(?:י|ו)?\s+לי|להזכיר\s+לי|תזכורת(?:\s+ל(?=\S+\s))?)"
_ARRIVE_HE = r"(?:כש|כאשר\s+|ברגע\s+ש|אחרי\s+ש)(?:אני\s+)?(?:אגיע|מגיעה|מגיע|אהיה|נגיע)\s+(?:ל|ב|אל\s+|(?=הביתה))"
_LEAVE_HE = r"(?:כש|כאשר\s+|ברגע\s+ש)(?:אני\s+)?(?:אצא|יוצאת|יוצא|אעזוב|עוזבת)\s+(?:מ|את\s+)"
_REMIND_EN = r"remind\s+me\s+(?:to\s+)?"
_ARRIVE_EN = r"when\s+i\s+(?:get\s+to|arrive\s+(?:at|in)|reach|am\s+at|get\s+home)"
_LEAVE_EN = r"when\s+i\s+(?:leave|get\s+out\s+of)"

_PLACE = r"(?P<place>[^,.!?]+?)"
_WHAT = r"(?P<what>[^.!?]+?)"
_END = r"\s*[.!?]*\s*$"

_PATTERNS = [
    ("arrive", re.compile(rf"^\s*{_ARRIVE_HE}{_PLACE}\s*,?\s*{_REMIND_HE}\s*{_WHAT}{_END}", re.I)),
    ("leave", re.compile(rf"^\s*{_LEAVE_HE}{_PLACE}\s*,?\s*{_REMIND_HE}\s*{_WHAT}{_END}", re.I)),
    ("arrive", re.compile(rf"^\s*{_REMIND_HE}\s*{_WHAT}\s+{_ARRIVE_HE}{_PLACE}{_END}", re.I)),
    ("leave", re.compile(rf"^\s*{_REMIND_HE}\s*{_WHAT}\s+{_LEAVE_HE}{_PLACE}{_END}", re.I)),
    ("arrive", re.compile(rf"^\s*{_ARRIVE_EN}\s*{_PLACE}?\s*,?\s*{_REMIND_EN}{_WHAT}{_END}", re.I)),
    ("leave", re.compile(rf"^\s*{_LEAVE_EN}\s+{_PLACE}\s*,?\s*{_REMIND_EN}{_WHAT}{_END}", re.I)),
    ("arrive", re.compile(rf"^\s*{_REMIND_EN}{_WHAT}\s+{_ARRIVE_EN}\s*{_PLACE}?{_END}", re.I)),
    ("leave", re.compile(rf"^\s*{_REMIND_EN}{_WHAT}\s+{_LEAVE_EN}\s+{_PLACE}{_END}", re.I)),
]

HOME_WORDS = {"בית", "הבית", "הביתה", "home", "my home", "the house"}
WORK_WORDS = {"עבודה", "העבודה", "משרד", "המשרד", "work", "the office", "office", "my office"}


def _clean_place(p: str) -> str:
    return (p or "").strip().strip("\"'״׳")


def parse(text: str) -> Optional[dict]:
    """{trigger: 'arrive'|'leave', place, what} or None. "when I get home" has no separate place word."""
    t = (text or "").strip()
    if not t or len(t) > 200:
        return None
    for trigger, rx in _PATTERNS:
        m = rx.match(t)
        if not m:
            continue
        place = _clean_place(m.groupdict().get("place") or "")
        if not place and re.search(r"get\s+home", t, re.I):
            place = "home"
        what = (m.group("what") or "").strip().strip(",")
        if not place or not what:
            continue
        return {"trigger": trigger, "place": place, "what": what}
    return None


def kind_of(place: str) -> Optional[str]:
    p = place.strip().lower()
    if p in HOME_WORDS:
        return "home"
    if p in WORK_WORDS:
        return "work"
    return None


async def resolve_place(phone: str, place: str, profile: dict) -> Optional[dict]:
    """{label, lat, lng} — home / work from her profile, a place she taught Meira, else Google. None = ask her."""
    import geo
    import known_places
    kind = kind_of(place)
    address = None
    if kind == "home":
        address = profile.get("homeAddress")
    elif kind == "work":
        address = profile.get("workAddress")
    if kind and not address:
        return None
    if not kind:
        hit = known_places.resolve(phone, place)
        if hit and hit.get("lat") and hit.get("lng"):
            return {"label": hit.get("name") or place, "lat": hit["lat"], "lng": hit["lng"]}
        address = hit.get("address") if hit else place
    found = await geo.geocode(address)
    if not found or not found.get("lat") or not found.get("lng"):
        return None
    label = {"home": "הבית", "work": "העבודה"}.get(kind or "", place) if re.search(r"[֐-׿]", place) \
        else {"home": "home", "work": "work"}.get(kind or "", place)
    return {"label": label, "lat": found["lat"], "lng": found["lng"]}


def he_when(trigger: str, label: str, future: bool) -> str:
    """'כשתגיעי הביתה' / 'כשתגיעי לעבודה' / 'כשתצאי מהבית' — 'ל' + 'הבית' is not Hebrew."""
    bare = label[1:] if label.startswith("ה") and len(label) > 2 else label
    if trigger == "arrive":
        verb = "כשתגיעי" if future else "הגעת"
        return f"{verb} הביתה" if bare == "בית" else f"{verb} ל{bare}"
    return f"{'כשתצאי' if future else 'יצאת'} מ{label}"


async def turn(phone: str, content: str, profile: dict) -> Optional[dict]:
    """A whole reply when the message is a place reminder, else None (the turn goes on as usual)."""
    parsed = parse(content)
    if not parsed:
        return None
    he = bool(re.search(r"[֐-׿]", content or ""))
    try:
        where = await resolve_place(phone, parsed["place"], profile)
    except Exception as exc:  # noqa: BLE001 — say it, never claim it
        logger.warning("place reminder: place lookup failed: %s", type(exc).__name__)
        where = None
    if not where:
        kind = kind_of(parsed["place"])
        ask = ({"home": "מה כתובת הבית שלך? אחרי זה אוכל להזכיר לך כשתגיעי.",
                "work": "איפה את עובדת? תני לי כתובת ואזכיר לך כשתגיעי."}.get(kind or "")
               or f"לא מצאתי איפה '{parsed['place']}' — מה הכתובת?") if he else \
              ({"home": "What's your home address? Then I can remind you when you get there.",
                "work": "Where do you work? Give me the address and I'll remind you there."}.get(kind or "")
               or f"I couldn't find where '{parsed['place']}' is — what's the address?")
        return {"text": ask, "type": "answer", "tasks": [], "departures": []}
    reminder = {"id": f"pr-{uuid.uuid4().hex[:12]}", "text": parsed["what"], "trigger": parsed["trigger"],
                **where}
    if he:
        text = f"אזכיר לך {he_when(parsed['trigger'], where['label'], future=True)}: {parsed['what']} ✓"
    else:
        verb = "when you get to " if parsed["trigger"] == "arrive" else "when you leave "
        text = f"I'll remind you {verb}{where['label']}: {parsed['what']} ✓"
    logger.warning("place reminder set (%s)", parsed["trigger"])
    return {"text": text, "type": "answer", "tasks": [], "departures": [], "place_reminders": [reminder]}
