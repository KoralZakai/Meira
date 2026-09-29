"""task_extract — free text in, structured tasks out, for the app's capture flow.

The phone used to do this: `TaskParser.ts` sent the user's sentence to Nebius
with the API key compiled into the APK, parsed the JSON, and then re-derived
dates, categories and times in TypeScript that had drifted from the server's
version of the same logic. This is that job, moved to the one place that can
hold a secret and the one place the WhatsApp channel already runs.

The division of labour is the point of the whole consolidation:

    the MODEL  reads the sentence and says what the tasks ARE
    the CODE   decides the date, the label, the duration and the clock time

So a model that answers `[]` for a perfectly clear Hebrew sentence — which is
exactly what happened, repeatedly — can no longer make a task disappear: the
fallback keeps the sentence as one task and the deterministic passes still fill
in everything they can. And a model that cheerfully invents "24.7" for the day
after 26.7 can no longer put an appointment in the past, because it is not the
one holding the calendar.

Uses the CHEAP model (config.LLM_MODEL_CHEAP) when one is configured: this is
Tier-1 extraction, not reasoning, and it was previously paying flagship prices.

Dependencies: config, categorize, day_schedule, tz, llm_usage. Consumed by
routes_app.POST /app/tasks/extract.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date as _date
from typing import Optional

from openai import AsyncOpenAI

import categorize
import config
import model_router
import day_schedule
import llm_usage
import tz as _tz

logger = logging.getLogger(__name__)

_client: Optional[AsyncOpenAI] = None

_SYSTEM = (
    "You are Lumi's task extractor. Reply with JSON only, no prose: "
    '{"tasks":[{"text":"short task title","fixed_time":"HH:MM start time if a clock '
    'time is given, else null","duration_minutes":"length in minutes when a RANGE is '
    'given (\'7pm-8pm\', \'משבע עד שמונה\') else null","date_expression":"the user\'s own '
    "words for when — מחר / next Monday / 21.7 — else null\","
    '"location":"place or address as said, else null","is_recurring":false,'
    '"recurrence_type":"daily|weekly|monthly or null","recurrence_days":null}]}\n'
    "\n"
    "ONE REAL-WORLD COMMITMENT = ONE TASK. Never split one commitment into several. "
    "These are NOT tasks and must never appear in the array:\n"
    " - reminders, alerts or alarms about a task ('remind me', 'תזכיר לי', 'התראה')\n"
    " - preparing for, leaving for, or travelling to a task\n"
    " - the end time of a range\n"
    "'Yoga class at the studio 7pm-8pm, remind me before' is exactly ONE task: "
    '{"text":"Yoga class","fixed_time":"19:00","duration_minutes":60}.\n'
    "\n"
    "Keep the user's own wording and language — Hebrew stays Hebrew. Do NOT resolve "
    "dates yourself, copy the expression; the server holds the calendar. Do NOT "
    "invent a category or a priority; the server labels the task. "
    "'every day for 5 days' is ONE recurring task, not five. "
    "Earlier messages are context only — extract tasks ONLY from the LAST user "
    'message. If nothing actionable was said, reply {"tasks":[]}.'
)

# 'ב-9', 'בשעה 14:30', 'at 9', '09:00' — the same shapes main.py's wake parser
# handles. No \b anywhere near the Hebrew: it does not match Hebrew letters, and
# that is how an earlier number parser quietly became dead code.
_EXPLICIT_TIME = re.compile(r"(\d{1,2}):(\d{2})")
# "ב 8" with a space is how a phone keyboard writes it, and it matched nothing.
# The ב must START a word, or "רחוב 8" would read as eight o'clock.
_BARE_TIME = re.compile(r"(?:\bat\b|בשעה|(?<![\u0590-\u05FF])ו?ב-?\s?(?=\d))\s*(\d{1,2})(?!\d|:)",
                        re.IGNORECASE)
# And a number followed by a month is a DAY: "מילואים ב 8 באוקטובר" was read as
# eight in the morning. Applied on top of the match, see _bare_hour.
_DAY_OF_MONTH_AFTER = re.compile(rf"(?:{_tz.MONTH_WORD_AFTER})", re.IGNORECASE)

# Things that take the working day when no hour is given. "מילואים ב 8 באוקטובר"
# is a day on base — she said "from the morning until the afternoon" — not a
# 30-minute task at some hour.
_DAY_LONG = re.compile(r"מילואים|miluim|reserve duty|יום גיבוש|יום עיון", re.IGNORECASE)
DAY_LONG_START, DAY_LONG_MINUTES = "08:00", 8 * 60


def day_long(text: str) -> bool:
    """Does this, with no hour said, take the working day (08:00–16:00)?"""
    return bool(_DAY_LONG.search(text or ""))


def _bare_hour(text: str):
    """The first "ב 8" / "at 8" that is an HOUR — not the 8 of "8 באוקטובר"."""
    for m in _BARE_TIME.finditer(text or ""):
        if not _DAY_OF_MONTH_AFTER.match(text, m.end()):
            return m
    return None


# "ב 8 וחצי", "ב-7 ורבע", "ברבע ל-9" — how an hour is actually said in Hebrew.
# Without these, "קיקבוקס ב 8 וחצי" became a task with no hour at all: the bare
# number matched nothing because a word, not ":30", followed it.
_HALF = re.compile(r"^\s*(?:ו)?חצי")
_QUARTER_PAST = re.compile(r"^\s*(?:ו)?רבע")
_QUARTER_TO = re.compile(r"(?:ב)?רבע\s*ל-?\s*(\d{1,2})(?!\d|:)")


_PM = re.compile(r"(?<![a-z])(?:pm|p\.m\.)(?![a-z])|evening|בערב|אחה[\"״]?צ|אחר\s*הצהריים|בצהריים",
                 re.IGNORECASE)
_NIGHT = re.compile(r"בלילה|tonight", re.IGNORECASE)
_AM = re.compile(r"(?<![a-z])(?:am|a\.m\.)(?![a-z])|morning|בבוקר", re.IGNORECASE)


def _meridiem(text: str) -> str:
    """'pm' | 'night' | 'am' | '' — which half of the day a phrase names.

    'night' is its own answer: "11 בלילה" is 23:00 but "1 בלילה" is 01:00, and
    folding בלילה into "evening" put a 1 a.m. call at 13:00. Mirrors
    meridiemOf in src/utils/timeParser.ts."""
    if _PM.search(text or ""):
        return "pm"
    if _NIGHT.search(text or ""):
        return "night"
    if _AM.search(text or ""):
        return "am"
    return ""


def _to_24h(hour: int, mer: str, bare: bool = True) -> int:
    """A spoken hour → 24h. With no marker, a BARE 1–6 is the afternoon: "אימון
    ב6 עד 7" is 18:00. It was 06:00 here and 18:00 on the phone — one sentence,
    two different hours depending on which door she used."""
    if mer == "pm":
        return hour + 12 if hour < 12 else hour
    if mer == "night":
        return hour + 12 if 6 <= hour < 12 else (0 if hour == 12 else hour)
    if mer == "am":
        return 0 if hour == 12 else hour
    return hour + 12 if bare and 1 <= hour <= 6 else hour


# SPOKEN HOURS. Whisper writes what she SAID: "שיחה עם דותן משתיים עד שתיים
# וחצי". Every parser below reads digits, so on 28.9 that call had no hour, the
# rescue saw no time, and nothing was saved — while Meira's reply drew a lovely
# day around it. The words become digits first, then the digit parsers run.
# An hour word counts only where an hour is meant: after ב/מ/ל/עד/בשעה, or
# followed by וחצי/ורבע/בערב… — "שלוש משימות" and "לשלוש שעות" stay words.
_HOUR_WORDS_HE = {
    "אחת עשרה": 11, "אחד עשרה": 11, "שתים עשרה": 12, "שתיים עשרה": 12,
    "אחת": 1, "שתיים": 2, "שתים": 2, "שלוש": 3, "ארבע": 4, "חמש": 5, "שש": 6,
    "שבע": 7, "שמונה": 8, "תשע": 9, "עשר": 10,
}
_MINUTES_HE = {"חצי": 30, "רבע": 15, "עשרה": 10, "עשרים": 20, "חמישה": 5,
               "עשרים וחמישה": 25, "שלושים": 30, "ארבעים": 40, "ארבעים וחמישה": 45,
               "חמישים": 50}
_TO_HE = {"רבע": 15, "עשרה": 10, "חמישה": 5, "עשרים": 20}
_HOUR_WORDS_EN = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
                  "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}
_MINUTES_EN = {"o'clock": 0, "fifteen": 15, "thirty": 30, "forty five": 45,
               "forty-five": 45}


def _alt(words) -> str:
    return "|".join(sorted(map(re.escape, words), key=len, reverse=True))


_NOT_AN_HOUR_AFTER = (r"(?!\s*(?:שעות|שעה|דקות|ימים|שבועות|חודשים|פעמים|אנשים|משימות"
                      r"|hours?|minutes?|mins?|days?|weeks?|times|people|of|points?|more)(?![a-z]))"
                      # "באחת הפגישות" is in one of the meetings, not at one.
                      r"(?!\s+(?:ה(?!ערב|בוקר|צהריים|לילה)|מה|מהן|מהם)[֐-׿])")
_SPOKEN_HE = re.compile(
    r"(?<![֐-׿])(?P<pre>ו?(?:(?:בשעה|השעה|עד|בין)\s+(?:ה-?)?|[במל]-?))?"
    r"(?P<h>" + _alt(_HOUR_WORDS_HE) + r")(?![֐-׿])"
    r"(?:(?P<plus>\s+ו(?:" + _alt(_MINUTES_HE) + r"))(?![֐-׿])"
    r"|(?P<minus>\s+פחות\s+(?:" + _alt(_TO_HE) + r"))(?![֐-׿]))?"
    + _NOT_AN_HOUR_AFTER)
_SPOKEN_HE_MARKER = re.compile(r"\s*(?:בערב|בבוקר|בלילה|בצהריים|אחה[\"״]?צ|אחר הצהריים)")
_SPOKEN_EN = re.compile(
    r"(?P<pre>\b(?:at|from|to|until|till|between|by)\s+)?"
    r"(?P<half>half\s+past\s+|quarter\s+past\s+|quarter\s+to\s+)?"
    r"\b(?P<h>" + _alt(_HOUR_WORDS_EN) + r")\b"
    r"(?P<plus>\s+(?:" + _alt(_MINUTES_EN) + r"))?" + _NOT_AN_HOUR_AFTER,
    re.IGNORECASE)
_SPOKEN_EN_MARKER = re.compile(r"\s*(?:am|pm|a\.m\.|p\.m\.|in the (?:morning|evening|afternoon)|tonight)\b",
                               re.IGNORECASE)


def _said(pre: str, hour: int, minute: int, marked: Optional[re.Match]) -> str:
    hour = _to_24h(hour, _meridiem(marked.group(0)) if marked else "", bare=True)
    return f"{pre}{hour}" + (f":{minute:02d}" if minute else "")


def spoken_hours(text: str) -> str:
    """Hours said in words → digits, only where an hour is meant.

    "משתיים עד שתיים וחצי" → "מ14 עד 14:30"; "בשמונה בערב" → "ב20 בערב";
    "ברבע לשלוש" → "ב14:45"; "from two to half past two" → "from 14 to 14:30".
    The hour comes out on the 24-hour clock by the same rule as a typed one
    (_to_24h: bare 1–6 is the afternoon), because "14:45" read later has no
    way to know it was said as "רבע לשלוש". Idempotent; a no-op on text with no
    hour words, so every parser can call it on whatever it was given."""
    def he(m: re.Match) -> str:
        pre, word = m.group("pre") or "", m.group("h")
        plus, minus = m.group("plus"), m.group("minus")
        marked = _SPOKEN_HE_MARKER.match(m.string, m.end())
        if not (pre or plus or minus or marked):
            return m.group(0)
        hour, minute = _HOUR_WORDS_HE[word], 0
        if plus:
            minute = _MINUTES_HE[plus.strip()[1:]]
        elif minus:
            hour, minute = (hour - 2) % 12 + 1, 60 - _TO_HE[minus.split()[-1]]
        return _said(pre, hour, minute, marked)

    def en(m: re.Match) -> str:
        pre, half, word, plus = (m.group("pre") or ""), m.group("half"), m.group("h"), m.group("plus")
        marked = _SPOKEN_EN_MARKER.match(m.string, m.end())
        if not (pre or half or plus or marked):
            return m.group(0)
        hour, minute = _HOUR_WORDS_EN[word.lower()], 0
        if half:
            kind = half.lower().split()[0]
            if kind == "half":
                minute = 30
            elif "to" in half.lower().split():
                hour, minute = (hour - 2) % 12 + 1, 45
            else:
                minute = 15
        elif plus:
            minute = _MINUTES_EN[" ".join(plus.lower().split())]
        return _said(pre, hour, minute, marked)

    text = text or ""
    # "רבע לשלוש" is a quarter to THREE: the hour belongs to the word after ל.
    text = re.sub(r"(?<![֐-׿])(?P<pre>[במ]-?)?(?P<q>רבע|עשרה|חמישה|עשרים)\s+ל(?P<h>"
                  + _alt(_HOUR_WORDS_HE) + r")(?![֐-׿])",
                  lambda m: _said(m.group("pre") or "", (_HOUR_WORDS_HE[m.group("h")] - 2) % 12 + 1,
                                  60 - _TO_HE[m.group("q")],
                                  _SPOKEN_HE_MARKER.match(m.string, m.end())), text)
    text = _SPOKEN_HE.sub(he, text)
    return _SPOKEN_EN.sub(en, text)


_MER = r"(am|pm|a\.m\.|p\.m\.|בערב|בבוקר|בלילה|בצהריים|אחה[\"״]?צ)?"
_TIME_RANGE = re.compile(
    r"(from\s+|between\s+|(?<![֐-׿])(?:ב|בשעה|מ)-?\s*|בין\s+)?"
    r"(\d{1,2})(?::(\d{2}))?\s*" + _MER + r"\s*"
    r"(?:-|–|—|to|until|till|and|עד|ל-?)\s*(\d{1,2})(?::(\d{2}))?(?!\d)\s*" + _MER +
    r"(?!\s*(?:שעות|דקות|ימים|שבועות|hours?|mins?|minutes?|days?|weeks?))",
    re.IGNORECASE)


def parse_time_range(text: str) -> Optional[dict]:
    """"ב 6 בערב עד 8 בערב" → {start: '18:00', end: '20:00', minutes: 120}, or None.

    Only a CLOCK range: one side needs minutes, a day-half marker, or a
    preposition in front ("ב6 עד 7") — "2-3 שעות" is a length and "רחוב 8-10"
    is an address. Mirrors the range branch of parseTimeExpression."""
    m = _TIME_RANGE.search(spoken_hours(text))
    return _range_of(m) if m else None


def ranges_in(text: str) -> list:
    """Every clock range in `text`, in order — one message can hold several."""
    return [r for r in map(_range_of, _TIME_RANGE.finditer(spoken_hours(text))) if r]


def _range_of(m: re.Match) -> Optional[dict]:
    prep, sh, sm, smer, eh, em, emer = m.groups()
    smer, emer = _meridiem(smer or ""), _meridiem(emer or "")
    if not (prep or sm is not None or em is not None or smer or emer):
        return None
    start_h = _to_24h(int(sh), smer or emer)
    end_h = _to_24h(int(eh), emer or smer)
    if not emer and not smer and start_h >= 12 and end_h < 12:
        end_h += 12      # the end is in the same half of the day as the start
    start_m, end_m = int(sm or 0), int(em or 0)
    if start_h > 23 or end_h > 23 or start_m > 59 or end_m > 59:
        return None
    minutes = end_h * 60 + end_m - (start_h * 60 + start_m)
    if minutes <= 0:
        minutes += 24 * 60
    return {"start": f"{start_h:02d}:{start_m:02d}", "end": f"{end_h:02d}:{end_m:02d}",
            "minutes": minutes}


def parse_clock_time(text: str) -> Optional[str]:
    """The clock time stated in `text` as HH:MM, or None. Hebrew and English."""
    text = spoken_hours(text)
    ranged = parse_time_range(text)
    if ranged:
        return ranged["start"]
    explicit = _EXPLICIT_TIME.search(text)
    bare = _bare_hour(text)
    quarter_to = _QUARTER_TO.search(text)
    if explicit and (not bare or explicit.start() <= bare.start()):
        hour, minute = int(explicit.group(1)), int(explicit.group(2))
        return f"{hour:02d}:{minute:02d}" if hour <= 23 and minute <= 59 else None
    minute = 0
    if quarter_to and (not bare or quarter_to.start() <= bare.start()):
        hour, minute = int(quarter_to.group(1)) - 1, 45
    elif bare:
        hour = int(bare.group(1))
        tail = text[bare.end():]
        if _HALF.match(tail):
            minute = 30
        elif _QUARTER_PAST.match(tail):
            minute = 15
    else:
        return None
    if not 0 <= hour <= 23:
        return None
    hour = _to_24h(hour, _meridiem(text), bare=True)
    return f"{hour:02d}:{minute:02d}"


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    return _client


def _resolve_date(expression: Optional[str], text: str, today: _date) -> str:
    """The task's real date: the model's own words first, then the sentence
    itself, then today. tz.resolve_date is the single parser — the same one
    main.py uses to overrule a hallucinated date, so the two cannot disagree."""
    for candidate in (expression, text):
        if not candidate:
            continue
        match = _tz.REL_DATE_RE.search(str(candidate))
        source = match.group(0) if match else (candidate if candidate is expression else None)
        if not source:
            continue
        resolved = _tz.resolve_date(source, today)
        if resolved:
            return resolved.isoformat()
    return today.isoformat()



# Hebrew marks place with the prefix ב ("in/at"), and marks the clock with the
# SAME letter — "בנהריה" is a town, "ב10" and "בבוקר" are a time. Extraction
# lived only in the model, so whenever the model step failed (no key, a
# timeout, a refusal) every task came back with location None and the whole
# sentence as its title. "מחר לחתום אבטלה בנהריה ב10 בבוקר" produced a task in
# no place at all.
_TIME_WORDS_HE = (
    "בוקר", "צהריים", "צהריהם", "ערב", "לילה", "שעה", "חצות", "דקות", "שעות",
)
# A Hebrew place must LOOK like one. "ב + any word" was the rule, and it read
# "לסדר באגים" as a trip to "אגים", "בלו״ז" as a place called "לו״ז" and
# "באחת הפגישות" as an address. Now: a street with a house number ("ביגאל אלון
# 94") or an address word ("ברחוב…") always; a bare name ("בנהריה", "בתל אביב")
# only in a sentence that is an appointment or names an hour — something that
# happens somewhere. Mirrors src/utils/hebrewPlace.ts.
_PLACE_HE = re.compile(r"(?<![\u0590-\u05FF])ב-?([\u0590-\u05FF\"״'׳]{2,}(?:\s+[\u0590-\u05FF\"״'׳]{2,}){0,2})"
                       r"(?:\s+(\d{1,4})(?![\d:]))?")
_ADDRESS_LEAD_HE = ("רחוב", "רח׳", "שדרות", "שד׳", "כתובת")
_APPOINTMENT_HE = re.compile(r"ראיון|פגישה|תור(?![\u0590-\u05FF])|רופא|מרפאה|הרצאה|כנס")
_PLACE_EN = re.compile(r"\b(?:in|at)\s+([A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*){0,2})")


def extract_place(text: str) -> Optional[str]:
    """The place named in a sentence, or None. Deterministic; no model."""
    if not text:
        return None
    somewhere = bool(_APPOINTMENT_HE.search(text) or parse_clock_time(text))
    for match in _PLACE_HE.finditer(text):
        candidate = match.group(1).strip()
        head = candidate.split()[0]
        if match.group(2):
            candidate = f"{candidate} {match.group(2)}"
        elif head not in _ADDRESS_LEAD_HE and not somewhere:
            continue
        if head in _TIME_WORDS_HE:
            continue
        # "בבוקר" splits to "בוקר" after the prefix; also skip bare weekdays.
        if head in ("יום", "ימים"):
            continue
        return candidate
    match = _PLACE_EN.search(text)
    return match.group(1).strip() if match else None


def strip_place(text: str, place: Optional[str]) -> str:
    """Remove the place phrase from a title once it has its own field."""
    if not text or not place:
        return text
    cleaned = re.sub(r"\bב-?" + re.escape(place), " ", text)
    cleaned = re.sub(r"\b(?:in|at)\s+" + re.escape(place), " ", cleaned, flags=re.IGNORECASE)
    return re.sub(r"\s{2,}", " ", cleaned).strip(" ,.-") or text


# Words that say WHEN, not what. Removed from a fallback title once the date
# and clock have been read into their own fields.
_WHEN_PHRASES = re.compile(
    r"\b(?:מחר|מחרתיים|היום|הערב|אתמול|בבוקר|בצהריים|בערב|בלילה)\b"
    r"|\bב-?\d{1,2}(?::\d{2})?\b"
    r"\b|\b(?:tomorrow|today|tonight|this morning|this evening)\b"
    r"|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b",
    re.IGNORECASE,
)


def strip_when(text: str) -> str:
    """Drop date/clock words from a title that already has date + time fields."""
    if not text:
        return text
    cleaned = _WHEN_PHRASES.sub(" ", text)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" ,.-")
    return cleaned or text


def finalize(raw: dict, text: str, today: _date, learned: Optional[dict] = None) -> dict:
    """Turn one model-shaped entry into a real task. Deterministic end to end —
    this function never asks anything, it decides."""
    task_text = str(raw.get("text") or text).strip()
    # When the model gave no cleaned title we are holding the raw sentence, so
    # the when and the where are still inside it: "מחר לחתום אבטלה בנהריה ב10
    # בבוקר" became a task literally called that. Those parts now have their own
    # fields, so take them out of the name — but only when we fell back, never
    # over a title the model wrote.
    # Keep the uncleaned sentence: the date still has to be read OUT of it.
    # Stripping first removed "מחר" before _resolve_date ever saw it, and the
    # task landed on today.
    dated_text = task_text
    if not raw.get("text"):
        task_text = strip_when(strip_place(task_text, extract_place(task_text)))
    labelled = categorize.merge(task_text, {}, learned)
    if day_schedule.is_study({"text": task_text, "category": labelled["category"]}):
        labelled["duration_minutes"] = max(labelled["duration_minutes"],
                                           day_schedule.MIN_STUDY_BLOCK_MINUTES)
    # A stated RANGE ("7pm-8pm") is the user's own number and beats both the
    # category default and the study floor — she said how long it is.
    try:
        stated = int(raw.get("duration_minutes") or 0)
    except (TypeError, ValueError):
        stated = 0
    if stated > 0:
        labelled["duration_minutes"] = stated

    fixed = raw.get("fixed_time")
    fixed = day_schedule.hhmm(fixed) or parse_clock_time(task_text) or parse_clock_time(text)
    recurrence = str(raw.get("recurrence_type") or "").lower()
    return {
        "text": task_text,
        "category": labelled["category"],
        "priority": labelled["priority"],
        "duration_minutes": labelled["duration_minutes"],
        "fixed_time": fixed,
        "date": _resolve_date(raw.get("date_expression"), dated_text or text, today),
        "location": raw.get("location") or extract_place(task_text) or extract_place(text),
        # Recurrence stays the model's call — "every day for 5 days" is ONE task,
        # and the client expands it. Anything unrecognised is simply not recurring.
        "is_recurring": bool(raw.get("is_recurring")) and recurrence in ("daily", "weekly", "monthly"),
        "recurrence_type": recurrence if recurrence in ("daily", "weekly", "monthly") else None,
        "recurrence_days": raw.get("recurrence_days") if isinstance(raw.get("recurrence_days"), int) else None,
    }


async def extract(text: str, today: Optional[_date] = None,
                  learned: Optional[dict] = None,
                  history: Optional[list] = None) -> list[dict]:
    """Tasks found in `text`. Never returns [] for a non-empty message: if the
    model finds nothing, the sentence itself becomes the task, because silently
    dropping what the user just said is the worst outcome available."""
    text = (text or "").strip()
    if not text:
        return []
    today = today or _tz.today_il()

    # The last few turns are context ("actually make it tomorrow"); the prompt
    # says tasks come from the newest message only.
    turns = []
    for turn in (history or [])[-6:]:
        if isinstance(turn, dict) and turn.get("text"):
            role = "user" if turn.get("role") in ("user", "human") else "assistant"
            turns.append({"role": role, "content": str(turn["text"])})

    entries: list[dict] = []
    _model = config.LLM_MODEL_CHEAP or model_router.pick(
        "task_extract", prompt_chars=len(_SYSTEM) + len(text) + sum(len(t["content"]) for t in turns))
    try:
        response = await _get_client().chat.completions.create(
            model=_model,
            messages=[{"role": "system", "content": _SYSTEM}, *turns,
                      {"role": "user", "content": text}],
            temperature=0,
            response_format={"type": "json_object"},
            timeout=20,
        )
        usage = response.usage
        if usage:
            llm_usage.record("task_extract", usage.prompt_tokens or 0,
                             usage.completion_tokens or 0, _model)
        payload = json.loads(response.choices[0].message.content or "{}")
        entries = [e for e in (payload.get("tasks") or []) if isinstance(e, dict)]
    except Exception as exc:  # noqa: BLE001 — the fallback below is the point
        logger.warning("task_extract model step failed, using the sentence itself: %s", exc)

    if not entries:
        # Deliberately NOT {"text": text}: an empty entry tells finalize the
        # title is the raw sentence, so it strips the when and the where that
        # now have their own fields. Handing the sentence over as a "title"
        # made it indistinguishable from one the model had actually written.
        entries = [{}]
    return [finalize(entry, text, today, learned) for entry in entries]


if __name__ == "__main__":   # self-check: python server/task_extract.py
    from datetime import date
    today = date(2026, 9, 6)          # a Sunday
    one = finalize({"text": "ראיון עבודה במר גרופ", "date_expression": "מחר",
                    "fixed_time": "13:00"}, "", today)
    assert one["category"] == "interview" and one["priority"] == "must"
    assert one["date"] == "2026-09-07" and one["fixed_time"] == "13:00"
    assert parse_clock_time("תעירי אותי ב-7") == "07:00"
    assert parse_clock_time("פגישה בשעה 14:30") == "14:30"
    assert parse_clock_time("dinner at 8 tonight") == "20:00"
    assert finalize({}, "לקנות חלב", today)["date"] == "2026-09-06"
    print("task_extract self-check OK:", one)
