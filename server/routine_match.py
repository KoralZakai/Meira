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
_WEEKDAYS_EN = [("sunday", "sundays", "sun"), ("monday", "mondays", "mon"),
                ("tuesday", "tuesdays", "tue", "tues"), ("wednesday", "wednesdays", "wed"),
                ("thursday", "thursdays", "thu", "thur", "thurs"), ("friday", "fridays", "fri"),
                ("saturday", "saturdays", "sat")]
_DAY_LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"]   # א׳ = Sunday … ש׳ = Saturday
_EN_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

# ── Which days a line names (6.10) ────────────────────────────────────────────
# ONE spec with src/utils/routines.ts readDays, pinned by the hand-written
# tests/fixtures/weekday-lines.json. The two used to disagree on "בשלישי",
# "שני ורביעי", ranges and "Tuesdays", and [] meant both "she never said" and
# "every day". `from` now says which: 'unsaid' is a question for her.
_GERESH = "['׳’]"
_NOT_HE = "(?:^|[^א-ת])"
_EVERY_DAY = re.compile(
    r"\b(?:every ?day|daily|each day|every (?:morning|evening|night))\b"
    r"|כל יום|כל יומ|יומיומי|כל בוקר|כל ערב|כל לילה", re.IGNORECASE)
_VARIES = re.compile(r"ימים משתנים|משתנה כל שבוע|\bdays vary\b|\bvaries (?:each|every) week\b", re.IGNORECASE)
_WORKWEEK = re.compile(r"\bweekdays\b|ימי חול|באמצע השבוע", re.IGNORECASE)   # Israel: Sun–Thu
_WEEKEND = re.compile(r"\bweekends?\b|סוף ה?שבוע|סופ[\"״]ש", re.IGNORECASE)
_HE_PER_WEEK = re.compile(r"(?:(\d+)\s*פעמים|(פעמיים)|(פעם אחת|פעם))\s*ב?שבוע")
_EN_PER_WEEK = re.compile(r"\b(?:(\d+)\s*(?:x|times)|(twice)|(once))\s*(?:a|per|each|/)?\s*week\b", re.IGNORECASE)
_EN_DAY = r"(sun|mon|tue|wed|thu|fri|sat)[a-z]*"
_EN_RANGE = re.compile(rf"\b{_EN_DAY}\s*(?:-|–|to|until|through|thru)\s*{_EN_DAY}\b", re.IGNORECASE)
_HE_NAMES = "|".join(_WEEKDAYS_HE)
_HE_RANGE = re.compile(rf"{_NOT_HE}[מב]?({_HE_NAMES})\s*(?:-|–|עד)\s*[הל]?({_HE_NAMES})(?![א-ת])")
# "א-ה" and "א׳–ה׳" are ranges; "ו-ד׳" is "and Wednesday": both letters carry
# a geresh or neither does.
_LETTER_RANGE = re.compile(rf"{_NOT_HE}([אבגדהוש])({_GERESH})?\s*(?:-|–|עד)\s*([אבגדהוש])({_GERESH})?(?![א-ת])")
# A single letter is a day only WITH its geresh: "ב 8 וחצי" is not Monday.
_LETTER_DAY = re.compile(rf"{_NOT_HE}(?:ו-?)?([אבגדהוש]){_GERESH}(?![א-ת])")
_HE_DAY_RES = [re.compile(rf"{_NOT_HE}(?:וב|ומ|ול|[ובמל])?{name}(?![א-ת])") for name in _WEEKDAYS_HE]
_EN_DAY_RES = [re.compile(rf"\b(?:{'|'.join(names)})\b", re.IGNORECASE) for names in _WEEKDAYS_EN]


def _add_range(found: set, start: int, end: int) -> None:
    if start < 0 or end < 0:
        return
    for i in range(7):
        day = (start + i) % 7
        found.add(day)
        if day == end:
            break


def _en_index(word: str) -> int:
    w = word.lower()
    for i, names in enumerate(_WEEKDAYS_EN):
        if any(w.startswith(n) for n in names):
            return i
    return -1


def read_days(text: str) -> dict:
    """{days, from, per_week?} — which days a line names, and whether it named any.

    from: 'said' | 'unsaid' | 'varies'. Named days win over "every day": "כל יום
    שלישי" is every TUESDAY."""
    text = str(text or "")
    if _VARIES.search(text):
        return {"days": [], "from": "varies"}
    found: set = set()
    for m in _EN_RANGE.finditer(text):
        _add_range(found, _en_index(m.group(1)), _en_index(m.group(2)))
    for m in _HE_RANGE.finditer(text):
        _add_range(found, _WEEKDAYS_HE.index(m.group(1)), _WEEKDAYS_HE.index(m.group(2)))
    for m in _LETTER_RANGE.finditer(text):
        if bool(m.group(2)) == bool(m.group(4)):
            _add_range(found, _DAY_LETTERS.index(m.group(1)), _DAY_LETTERS.index(m.group(3)))
    for m in _LETTER_DAY.finditer(text):
        found.add(_DAY_LETTERS.index(m.group(1)))
    for i, rx in enumerate(_HE_DAY_RES):
        if rx.search(text):
            found.add(i)
    for i, rx in enumerate(_EN_DAY_RES):
        if rx.search(text):
            found.add(i)
    if _WORKWEEK.search(text):
        found.update(range(5))
    if _WEEKEND.search(text):
        found.update((5, 6))
    if found:
        return {"days": sorted(found), "from": "said"}
    if _EVERY_DAY.search(text):
        return {"days": list(range(7)), "from": "said"}
    he, en = _HE_PER_WEEK.search(text), _EN_PER_WEEK.search(text)
    per_week = None
    if he:
        per_week = int(he.group(1)) if he.group(1) else (2 if he.group(2) else 1)
    elif en:
        per_week = int(en.group(1)) if en.group(1) else (2 if en.group(2) else 1)
    return {"days": [], "from": "unsaid", **({"per_week": per_week} if per_week else {})}


# ── Writing her answer back into her line (same phrase as the phone) ──────────
_DAYS_PHRASE = re.compile(
    r"\s*·\s*(?:ימי\s[^·]+|כל יום|ימים משתנים|every day|days vary"
    r"|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:\s*[&/–-]\s*(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat))*)\s*$")


def _is_run(days: list) -> bool:
    return len(days) >= 3 and all(d == days[i - 1] + 1 for i, d in enumerate(days) if i)


def days_phrase(days, script: str) -> str:
    """The days as a short phrase in her script ('he' | 'en'), or 'varies'. No commas."""
    if days == "varies":
        return "· ימים משתנים" if script == "he" else "· days vary"
    ds = sorted({int(d) for d in days if 0 <= int(d) <= 6})
    if not ds:
        return ""
    if len(ds) == 7:
        return "· כל יום" if script == "he" else "· every day"
    if script == "he":
        L = lambda d: f"{_DAY_LETTERS[d]}׳"   # noqa: E731
        if _is_run(ds):
            return f"· ימי {L(ds[0])}–{L(ds[-1])}"
        if len(ds) == 1:
            return f"· ימי {L(ds[0])}"
        return f"· ימי {' '.join(L(d) for d in ds[:-1])} ו-{L(ds[-1])}"
    if _is_run(ds):
        return f"· {_EN_ABBR[ds[0]]}–{_EN_ABBR[ds[-1]]}"
    if len(ds) == 2:
        return f"· {_EN_ABBR[ds[0]]} & {_EN_ABBR[ds[1]]}"
    return "· " + "/".join(_EN_ABBR[d] for d in ds)


def strip_days_phrase(text: str) -> str:
    """Her line without a days phrase Meira appended (her own words are kept)."""
    return _DAYS_PHRASE.sub("", str(text or "")).strip()


def with_days(line: str, days) -> str:
    """Her line with these days written into it, in the line's own script."""
    base = strip_days_phrase(line)
    phrase = days_phrase(days, "he" if re.search(r"[֐-׿]", base) else "en")
    return f"{base} {phrase}" if phrase else base

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
    """Days of the week a line names; [] = it named none (read as every day —
    read_days says whether that was said or is a question)."""
    return read_days(text)["days"]


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
    # An hour said the way people say it ("ב 8 בערב", "11 עד 12 וחצי"): routine_text.
    try:
        import routine_text
        return routine_text.read_hours(text)
    except Exception:  # noqa: BLE001 — a reader that fails is the old behaviour, not an error
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
        read = read_days(text)
        entry = {"text": text, "weekdays": read["days"], "days_from": read["from"], **_when(text)}
        if read.get("per_week"):
            entry["per_week"] = read["per_week"]
        # The place and its name come from her words, not from "· ימי ג׳".
        bare = strip_days_phrase(text)
        addr = address_in(bare)
        if addr:
            entry["address"] = addr
            name = name_before(bare, addr)
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
    # A street WITH a number only (13.10): a venue name is found by the geocoder
    # near her; ", Tel Aviv" sent "רפאל מכון דוד" (Haifa) to the wrong city.
    if not re.search(r"\d", address):
        return address
    city = home_city(home)
    return f"{address}, {city}" if city else address


# ── One routine, said many ways ──────────────────────────────────────────────
# 11.10, Koral: one workout (Sun–Tue 20:00, Fri 11:00, Yigal Alon 94), told to
# Meira by voice, chat and typing, was kept as twelve lines and drawn as five
# cards. Mirrors utils/routines.ts sameRoutine — a new line that says the same
# routine again REPLACES the old one instead of being added beside it.
_FITNESS = re.compile(
    r"gym|work ?out|training|\btrain\b|fitness|yoga|pilates|kickbox|boxing|crossfit|חדר כושר|כושר|אימו[נן]"
    r"|להתאמן|מתאמ[נן]|יוגה|פילאטיס|קיקבוקס|קיק בוקס|איגרוף|אגרוף|קרוספיט", re.IGNORECASE)
_NAMED_FITNESS = [("yoga", re.compile(r"yoga|יוגה", re.I)), ("pilates", re.compile(r"pilates|פילאטיס", re.I)),
                  ("kickbox", re.compile(r"kickbox|קיקבוקס|קיק בוקס", re.I)),
                  ("boxing", re.compile(r"boxing|איגרוף|אגרוף", re.I)),
                  ("crossfit", re.compile(r"crossfit|קרוספיט", re.I))]


def _concept(text: str) -> Optional[str]:
    return "fitness" if _FITNESS.search(text or "") else known_places.concept_of(text or "")


def _named(text: str) -> Optional[str]:
    return next((k for k, rx in _NAMED_FITNESS if rx.search(text or "")), None)


def same_routine(a: str, b: str) -> bool:
    """Two routine lines that are ONE routine: the same kind of thing, on a
    shared day (or one names none), at the same hour (or one has none). Two
    named workouts must be the same kind; a named one and a plain "workout"
    are one only on the same day at the same hour."""
    ca, cb = _concept(a), _concept(b)
    if not ca or ca != cb:
        return False
    na, nb = _named(a), _named(b)
    if na and nb and na != nb:
        return False
    strict = bool(na) != bool(nb)
    ta, tb = _when(a).get("time"), _when(b).get("time")
    if strict and not (ta and ta == tb):
        return False
    if ta and tb and ta != tb:
        return False
    da = read_days(a)
    db = read_days(b)
    days_a = set(da["days"]) if da.get("from") == "said" else set()
    days_b = set(db["days"]) if db.get("from") == "said" else set()
    shared = bool(days_a & days_b)
    if strict and not shared:
        return False
    if days_a and days_b and not shared:
        return False
    return True


_TRAVEL_WORDS = re.compile(
    r"\b(?:by\s+)?(?:bicycle|bike|car|bus|train|walk|on foot)\b|באופניים|ברגל|באוטובוס|ברכבת|באוטו|ברכב|מגיע(?:ה)?",
    re.IGNORECASE)


def _is_fragment(piece: str) -> bool:
    """A comma piece that is only a place, a city or how she gets there —
    part of the routine before it, never a routine of its own."""
    rest = piece
    addr = address_in(piece)
    if addr:
        rest = rest.replace(addr, " ")
    for city in _CITIES:
        rest = re.sub(re.escape(city), " ", rest, flags=re.IGNORECASE)
    rest = _TRAVEL_WORDS.sub(" ", rest)
    return not _significant(rest)


def restate(line: str, item: str) -> Optional[str]:
    """`line` without every piece that is `item`'s routine (and the place /
    travel scraps glued after it); None when the line never mentioned it.
    "" = the whole line was that routine."""
    pieces = [e["text"] for e in parse(line)]
    kept, hit = [], False
    for piece in pieces:
        if same_routine(piece, item):
            hit = True
            continue
        kept.append(piece)
    if not hit:
        return None
    return ", ".join(p for p in kept if not _is_fragment(p))
