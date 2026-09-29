"""routine_match — "קיקבוקס" is already in her week. Read it from there.

Koral, 2026-09-28: "I wrote 'קיקבוקס'. I expected Meira to know where it is —
Yigal Alon 94, Tel Aviv. I ride by bike. It has a time, 20:30-21:30 — it's in
my routines!"

It was. profile.routinesNotes held the hour and the address, and the only
things that read it were check_availability (as prose handed to the model) and
a gap-filler on the phone. A task named after a routine was created with no
hour, no place and no route, and then the chat asked her where the gym is.

This module answers one question: which line of her routines is THIS task,
and what does that line already say — hour, length, days, address?

Two strengths of match, because they license different things:
  exact   — the task names the routine's own activity ("קיקבוקס" in a line
            that says קיקבוקס). Hour AND address may be taken.
  concept — the same kind of activity (yoga vs a kickboxing line, both
            fitness). Only the ADDRESS may be taken: same gym, different class,
            different hour. Borrowing the kickboxing hour for yoga would be a
            confidently wrong alarm.

Pure: text in, dict out. Callers do the storage and the geocoding.

Dependencies: known_places (activity keys, tokens). Consumed by
lumi_agent.infer_task_details. Mirrored in src/utils/routines.ts
(routineForTask) for tasks typed into the app.
"""
from __future__ import annotations

import re
from datetime import date as _date
from typing import Optional

import known_places

# Split into routines on newlines, semicolons and bullets. Commas are split too,
# but a comma piece that is only a city ("תל אביב") is glued back to the line
# before it — "יגאל אלון 94, תל אביב" is one address, not a routine.
_LINE_SPLIT = re.compile(r"[;\n•]+")
_COMMA_SPLIT = re.compile(r",")

_RANGE = re.compile(r"(\d{1,2})[:.](\d{2})\s*(?:-|–|—|עד|to|until)\s*(\d{1,2})[:.](\d{2})")
_CLOCK = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)")

_WEEKDAYS_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]   # 0 = Sunday
_WEEKDAYS_EN = [("sunday", "sun"), ("monday", "mon"), ("tuesday", "tue", "tues"),
                ("wednesday", "wed"), ("thursday", "thu", "thur", "thurs"),
                ("friday", "fri"), ("saturday", "sat")]
_EVERY_DAY = re.compile(r"every ?day|daily|כל יום|יומיומי", re.IGNORECASE)

# Words that say when, never what or where.
_WHEN_WORDS = {
    "כל", "יום", "ימי", "בימי", "ביום", "בשעה", "שעה", "עד", "בין", "מ", "ב",
    "בערב", "בבוקר", "בצהריים", "בלילה", "ערב", "בוקר", "וחצי", "ורבע", "רבע",
    "every", "at", "from", "to", "until", "on", "evening", "morning", "weekly",
    "שבועי", "פעם", "בשבוע", "פעמיים",
}
# Words that introduce an address and are not part of it.
_ADDRESS_LEADS = {"רחוב", "רח", "רח׳", "רח'", "שדרות", "שד", "כתובת", "street", "st"}
_CITIES = [
    "תל אביב-יפו", "תל אביב", "ת\"א", "ת״א", "רמת גן", "גבעתיים", "הרצליה", "רעננה",
    "חיפה", "ירושלים", "בני ברק", "חולון", "בת ים", "פתח תקווה", "ראשון לציון",
    "tel aviv", "ramat gan", "givatayim", "herzliya", "raanana", "haifa", "jerusalem",
]


def _weekdays(text: str) -> list:
    """Days of the week a line names; [] = it named none (every day it applies)."""
    if _EVERY_DAY.search(text):
        return list(range(7))
    found = set()
    for i, name in enumerate(_WEEKDAYS_HE):
        # No \b: it is ASCII-only. A Hebrew weekday may carry a ו / ב / ה prefix.
        if re.search(rf"(?:^|[^֐-׿])[ובה]?{name}(?:[^֐-׿]|$)", text):
            found.add(i)
    low = text.lower()
    for i, names in enumerate(_WEEKDAYS_EN):
        if any(re.search(rf"\b{n}\b", low) for n in names):
            found.add(i)
    return sorted(found)


def _when(text: str) -> dict:
    """{time, end, minutes} from an explicit clock or a range in the line."""
    m = _RANGE.search(text)
    if m:
        start = f"{int(m.group(1)):02d}:{m.group(2)}"
        end = f"{int(m.group(3)):02d}:{m.group(4)}"
        s = int(m.group(1)) * 60 + int(m.group(2))
        e = int(m.group(3)) * 60 + int(m.group(4))
        if e <= s:
            e += 24 * 60
        return {"time": start, "end": end, "minutes": max(15, e - s)}
    m = _CLOCK.search(text)
    if m and int(m.group(1)) <= 23:
        return {"time": f"{int(m.group(1)):02d}:{m.group(2)}"}
    return {}


def _word(token: str) -> str:
    return token.strip(".,;:!?()[]\"")


def _script(word: str) -> str:
    return "he" if re.search(r"[֐-׿]", word) else "latin"


def address_in(text: str) -> Optional[str]:
    """A street address in a line of prose — "<street words> <house number>" —
    or None. Deliberately needs the house number: a routine line is full of
    words, and without a number any two of them would look like a street.

    The Hebrew preposition ב is peeled off the street's first word
    ("ביגאל אלון 94" → "יגאל אלון 94"), the same rule utils/hebrewPlace
    applies on the phone.
    """
    tokens = [t for t in re.split(r"\s+", text or "") if t]
    for idx, raw in enumerate(tokens):
        tok = _word(raw)
        if not re.fullmatch(r"\d{1,4}[א-ת]?", tok):
            continue
        words: list = []
        j = idx - 1
        while j >= 0 and len(words) < 3:
            w = _word(tokens[j])
            bare = re.sub(r"^ב-?", "", w) if re.match(r"^ב-?[֐-׿]{3,}", w) else w
            if (not re.fullmatch(r"[֐-׿A-Za-z'\"׳״\-]{2,}", w)
                    or w.lower() in _WHEN_WORDS or bare in _WHEN_WORDS
                    or bare.lower() in _ADDRESS_LEADS
                    or _weekdays(w)
                    # "Space Gym, יגאל אלון 94": a comma closes the name before
                    # the street, and a street is written in one alphabet —
                    # without these the gym's name became "Gym יגאל אלון 94".
                    or re.search(r"[,;]$", tokens[j])
                    or (words and _script(w) != _script(words[0]))):
                break
            words.insert(0, w)
            j -= 1
        if not words:
            continue
        # The preposition belongs to the first word only.
        first = words[0]
        if re.match(r"^ב-?[֐-׿]{3,}", first):
            words[0] = re.sub(r"^ב-?", "", first)
        address = " ".join(words + [tok])
        rest = " ".join(_word(t) for t in tokens[idx + 1: idx + 4])
        city = next((rest[:len(c)] for c in _CITIES if rest.lower().startswith(c.lower())), None)
        return f"{address}, {city}" if city else address
    return None


# One activity, two alphabets. She writes the routine once, in whichever
# language came to hand, and the task in the other.
_ALIASES = {
    "kickbox": "קיקבוקס", "kickboxing": "קיקבוקס", "boxing": "איגרוף", "אגרוף": "איגרוף",
    "yoga": "יוגה", "pilates": "פילאטיס", "gym": "כושר", "crossfit": "קרוספיט",
    "swim": "שחייה", "swimming": "שחייה", "run": "ריצה", "running": "ריצה",
    "dance": "ריקוד", "ריקודים": "ריקוד", "guitar": "גיטרה", "piano": "פסנתר",
}


def _significant(text: str) -> list:
    """Her words for the activity: tokens minus times, when-words and stop words,
    each folded to one spelling across languages."""
    toks = re.findall(r"[^\W\d_]+", str(text or "").lower(), re.UNICODE)
    return [_ALIASES.get(t, t) for t in toks
            if len(t) > 2 and t not in _WHEN_WORDS and t not in known_places._STOP
            and not _weekdays(t)]


def parse(notes: Optional[str]) -> list:
    """Her routines, one dict per line: {text, weekdays, time?, end?, minutes?, address?}."""
    lines: list = []
    for line in _LINE_SPLIT.split(notes or ""):
        pieces: list = []
        for piece in _COMMA_SPLIT.split(line):
            piece = piece.strip()
            if not piece:
                continue
            only_city = any(piece.lower() == c.lower() for c in _CITIES)
            if pieces and (only_city or not _significant(piece)):
                pieces[-1] = f"{pieces[-1]}, {piece}"
            else:
                pieces.append(piece)
        lines.extend(pieces)
    out = []
    for text in lines:
        if len(text) < 3:
            continue
        entry = {"text": text, "weekdays": _weekdays(text), **_when(text)}
        addr = address_in(text)
        if addr:
            entry["address"] = addr
            name = name_before(text, addr)
            if name:
                entry["name"] = name
        out.append(entry)
    return out


def name_before(text: str, address: str) -> Optional[str]:
    """What she calls the place: the words before its address, minus hours,
    days and when-words. "Space Gym - Yigal Alon 94" → "Space Gym".

    The name and the address are different things and travel separately: the
    address is what gets geocoded, the name is what the card shows. Geocoding
    "Space Gym Yigal Alon 94" as one string is how a gym's name ends up glued
    onto its street.
    """
    street = (address or "").split(",")[0].strip()
    at = text.find(street) if street else -1
    if at <= 0:
        return None
    head = _CLOCK.sub(" ", _RANGE.sub(" ", text[:at]))
    # len > 1: the ב of "ביגאל" is left behind when the street is found inside it.
    keep = [w for w in (_word(t) for t in head.split())
            if len(w) > 1 and not re.fullmatch(r"[-–—:|/]+", w)
            and w.lower() not in _WHEN_WORDS and w.lower() not in _ADDRESS_LEADS
            and not _weekdays(w)]
    name = " ".join(keep).strip(" -–—,:")
    return name or None


def notes_of(profile: Optional[dict]) -> str:
    """Every routine she has told us, wherever she said it.

    Two sources, neither allowed to erase the other: what she told Meira in the
    chat (save_profile → routinesNotes) and what she typed into the app's
    Profile screen (appRoutinesNotes, sent with each chat turn)."""
    profile = profile or {}
    parts = [profile.get("routinesNotes"), profile.get("appRoutinesNotes")]
    return "\n".join(p.strip() for p in parts if isinstance(p, str) and p.strip())


def _weekday(iso: Optional[str]) -> Optional[int]:
    """0 = Sunday … 6 = Saturday, the convention the routines use."""
    try:
        return (_date.fromisoformat(str(iso)[:10]).weekday() + 1) % 7
    except (TypeError, ValueError):
        return None


def find(task_text: str, notes: Optional[str], task_date: Optional[str] = None) -> Optional[dict]:
    """The routine this task IS, or None.

    Returns the parsed line plus:
      match       'exact' | 'concept'
      time_applies  True when the hour may be used for THIS date — an exact
                    match on a day the routine runs (or a routine with no days)
    """
    mine = _significant(task_text)
    if not mine:
        return None
    task_concept = known_places.concept_of(task_text)
    if not task_concept:
        folded = " ".join(mine)
        task_concept = known_places.concept_of(folded)
    day = _weekday(task_date)
    exact = concept = None
    for entry in parse(notes):
        theirs = set(_significant(entry["text"]))
        if mine[0] in theirs or any(len(w) >= 4 and w in theirs for w in mine):
            if exact is None:
                applies = (bool(entry.get("time"))
                           and (not entry["weekdays"] or day is None or day in entry["weekdays"]))
                exact = {**entry, "match": "exact", "time_applies": applies}
        elif (task_concept and task_concept not in known_places._GENERIC
              and known_places.concept_of(entry["text"]) == task_concept
              and entry.get("address") and concept is None):
            concept = {**entry, "match": "concept", "time_applies": False}
    if exact and not exact.get("address") and concept:
        # "קיקבוקס 20:30-21:30" on one line, "חדר כושר - יגאל אלון 94" on
        # another: the hour is the class's, the address is the gym's.
        exact = {**exact, "address": concept["address"],
                 **({"name": concept["name"]} if concept.get("name") else {})}
    hit = exact or concept
    if hit and hit.get("name"):
        words = _significant(hit["name"])
        # "קיקבוקס 20:30 ביגאל אלון 94" names the CLASS, not the place: no name
        # for the kickboxing task itself, and none for a yoga class borrowing
        # the address either. "Space Gym" has a word that is no activity.
        if set(words) <= set(mine) or all(known_places.concept_of(w) for w in words):
            hit = {k: v for k, v in hit.items() if k != "name"}
    return hit


def same_hour_of_day(said: Optional[str], routine_time: Optional[str]) -> bool:
    """Does "8:30" (as she typed it) name the routine's 20:30? Twelve-hour
    agreement is enough — nobody writes 'בערב' after a class she has every week."""
    if not said or not routine_time:
        return False
    try:
        sh, sm = (int(x) for x in said.split(":"))
        rh, rm = (int(x) for x in routine_time.split(":"))
    except ValueError:
        return False
    return sm == rm and sh % 12 == rh % 12


def home_city(home: Optional[str]) -> Optional[str]:
    """The city of a stored home address, for completing a bare street.

    "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo, Tel Aviv District" → "Tel Aviv-Yafo".
    """
    if not home or "," not in home:
        return None
    parts = [p.strip() for p in home.split(",")[1:]]
    keep = [p for p in parts
            if p and not re.search(r"\d", p)
            and not re.search(r"district|מחוז|israel|ישראל|street|רחוב", p, re.IGNORECASE)]
    return keep[0] if keep else None


def complete_address(address: str, home: Optional[str]) -> str:
    """"יגאל אלון 94" → "יגאל אלון 94, Tel Aviv-Yafo" when it names no city.

    She never writes her own city, and a bare street name geocodes to whichever
    town Google likes best — there is a Yigal Alon street in a dozen of them."""
    if not address or "," in address:
        return address
    city = home_city(home)
    return f"{address}, {city}" if city else address
