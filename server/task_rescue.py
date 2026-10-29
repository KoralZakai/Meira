"""When the model does not save a task the user plainly asked for, save it anyway.

Three times in a row, from the same real message:

    12:46  "לדבר עם יניר מחר ב 16:00"  ->  "✓ עודכן: שיחה עם יניר"
    13:34  "לדבר עם יניר מחר ב 16:00"  ->  "✓ שיחה עם יניר ממתינה ליום שני"
    stores: 30 tasks before, 30 tasks after, no יניר anywhere

Each round of guarding taught the model a new way to sound finished. Blocking
the WORDS is a game that cannot be won — "עודכן" was blocked, so it wrote
"ממתינה" — because the guard argues about prose while the user's problem is
that a thing does not exist.

So this stops arguing. If a message names a TIME and reads like something to do,
and the turn created nothing and updated nothing, the task is created here,
deterministically, from the user's own words. The model's cooperation stops
being required for the one thing Lumi must never get wrong.

Deliberately conservative. It fires only when:
  - the turn saved nothing at all (no create, no successful update), AND
  - the message contains a clock time (an appointment has an hour), AND
  - the message is short enough to be an instruction, not a conversation, AND
  - nothing similar already exists on that date (no duplicate of a real save).

Dates come from tz.resolve_date — the same parser the webhook uses to correct a
hallucinated date, so the rescue and the guard can never disagree.

It also answers the second half of the same request: a task must be SAVED
whatever it is missing, and a task the user already has must be UPDATED rather
than duplicated when they say it again with a new time.

Dependencies: tz, dedup_service (semantic scoring). Consumed by agent_turn.
"""
from __future__ import annotations

import logging
import re
from datetime import date as _date
from typing import Optional

import categorize
import name_skeleton
import task_extract
import task_intent
import tz as _tz

logger = logging.getLogger(__name__)

# "ב-16:00" / "at 16:00" / "16:00" / "ב 6 בערב עד 8 בערב" / "ב 8 וחצי" — the
# time and its preposition, removed from the title so the task reads "אימון",
# not "אימון ב 6 בערב עד 8 בערב". A bare number needs a preposition in front:
# the 30 of "באלנבי 30" is a house, not half past.
_HALF_DAY = r"(?:\s*(?:בערב|בבוקר|בלילה|בצהריים|אחה[\"״]?צ|am|pm))?"
_ONE_TIME = (r"(?:(?:(?<![֐-׿])(?:ב|מ)-?\s*|בשעה\s*|\bat\s+|\bfrom\s+|@\s*)\d{1,2}(?::\d{2})?"
             r"|\b\d{1,2}:\d{2}\b)"
             r"(?:\s*ו?(?:חצי|רבע))?" + _HALF_DAY)
_TIME_PHRASE_RE = re.compile(
    r"\s*" + _ONE_TIME
    + r"(?:\s*(?:-|–|עד|to|until)\s*(?:ה-?|ל-?)?\d{1,2}(?::\d{2})?(?:\s*ו?(?:חצי|רבע))?" + _HALF_DAY + r")?",
    re.IGNORECASE)
# How a second item in the same message starts. "אחר כך קריוקי" is the task
# "קריוקי"; "או ב 7 עד 8" is an ALTERNATIVE hour for the one before, never a task.
_LEAD_RE = re.compile(r"^\s*(?:אחר כך|אחרי זה|ואז|וגם|then|and then|and)\s+", re.IGNORECASE)
_ALTERNATIVE_RE = re.compile(r"^\s*(?:או|or)\b", re.IGNORECASE)
# "לפני האימון ולפני הקריוקי" says WHERE something goes, relative to things she
# already has. It was saved as a flexible task of its own.
_PLACEMENT_RE = re.compile(r"(?:^|\s)ו?(?:לפני|אחרי|before|after)\s+(?:the\s+|my\s+)?\S+",
                           re.IGNORECASE)


def only_placement(text: str) -> bool:
    """Is this nothing but "before X / after Y"? Then it places a task, it is not one.
    "אחרי זה קריוקי" still has a task left over ("קריוקי") and is not this."""
    if not _PLACEMENT_RE.search(text or ""):
        return False
    return not _PLACEMENT_RE.sub(" ", text or "").strip(" ,.;")
# Anything that means "this is for me to do", in either language.
_INTENT_RE = re.compile(
    r"לדבר|לפגוש|פגישה|תור|להתקשר|שיחה|לקבוע|תזכיר|תזכורת|ללכת|לנסוע|להגיע|אימון|שיעור"
    r"|meet|meeting|call|appointment|remind|go to|visit|session|class",
    re.IGNORECASE)
# Longer than this and it is a conversation, not an instruction.
_MAX_WORDS = 14
# A question asks Lumi something; it never asks Lumi to remember something.
# "מה יש לי מחר?" contains no intent word today, but "מתי הפגישה עם יניר?" does.
_QUESTION_RE = re.compile(r"^\s*(?:מה|מתי|איפה|למה|האם|כמה|מי)\b|\?\s*$"
                          r"|^\s*(?:what|when|where|why|how|who|is|are|do|did)\b",
                          re.IGNORECASE)


def clock_time(text: str) -> Optional[str]:
    """The hour the message names, zero-padded, or None.

    task_extract's parser, not a private HH:MM regex: "אימון ב 6 בערב עד 8
    בערב" had no colon, so the rescue saved it with no hour at all — and an
    undated, hourless task is a "flexible" one, which is exactly how it showed
    up on her Today screen."""
    return task_extract.parse_clock_time(text or "")


# The REQUEST around the task: "תוסיפי לי שיחה עם דותן" was saved as a task
# called exactly that. The thing is "שיחה עם דותן"; the rest is her asking.
_REQUEST_RE = re.compile(
    r"^\s*(?:(?:תוסיפי|תוסיף|הוסיפי|תרשמי|תרשום|רשמי|שימי|תשימי|תכניסי|הכניסי|תקבעי|קבעי|"
    r"תזכירי|תזכיר)\s+(?:לי\s+)?(?:את\s+)?|(?:please\s+)?(?:add|put|schedule|remind me(?:\s+about)?)\s+)",
    re.IGNORECASE)
_REQUEST_TAIL_RE = re.compile(r"[,.]?\s*(?:שימי|תשימי|תכניסי|תוסיפי)\s+(?:לי\s+)?(?:את\s+)?(?:זה\s+)?"
                              r"(?:בלו[\"״]?ז|ביומן)\s*$|\s+(?:to|in|on) my (?:schedule|calendar|day)\s*$",
                              re.IGNORECASE)


def title_from(text: str) -> str:
    """The message as a task title: its time and date words taken out."""
    out = _REQUEST_TAIL_RE.sub("", _REQUEST_RE.sub("", text or ""))
    out = _LEAD_RE.sub("", _TIME_PHRASE_RE.sub("", out))
    out = re.sub(_tz.REL_DATE_RE, "", out)
    # Leftover prepositions once their object is gone.
    out = re.sub(r"\s+(ב|ל|את)\s*$", "", out.strip())
    return re.sub(r"\s{2,}", " ", out).strip(" ,.:-")


def clauses(content: str) -> list:
    """The separate things one message asks for, in order, alternatives dropped.

    "אימון ב 6 בערב עד 8 בערב\\nאחר כך קריוקי באלנבי 30" is two tasks. The rescue
    saved it as ONE task titled with both lines and neither hour. "או ב 7 עד 8"
    is the other option for the workout, not a third thing to do."""
    parts = task_intent.split_clauses(content or "") or [content or ""]
    return [p for p in parts if not _ALTERNATIVE_RE.match(p)] or [content or ""]


def looks_like_a_task(text: str) -> bool:
    """Is this an instruction to remember something, rather than talk?

    A clock time is NOT required. "שיחה עם יניר מחר" is a real commitment with
    no hour yet, and refusing to save it until an hour appears is how a thing
    the user said out loud disappears. Without an hour it becomes a task for
    that day and Lumi offers times; without a date it waits in the general
    list. Saved either way — that is the whole point.
    """
    if not text:
        return False
    if len(text.split()) > _MAX_WORDS:
        return False
    if _QUESTION_RE.search(text):
        return False
    if only_placement(text):
        return False
    # A word the category table knows ("קריוקי", "ללמוד") or a stated hour is
    # as much an instruction as "פגישה" — "קריוקי באלנבי 30" was dropped.
    return bool(_INTENT_RE.search(text) or categorize.infer(text)["matched"]
                or task_extract.parse_clock_time(text))


def already_there(tasks: list, title: str, date_iso: str) -> bool:
    """A task with this title already on that day — never duplicate a real save."""
    key = (title or "").strip().lower()
    if not key:
        return False
    for t in tasks or []:
        if str(t.get("date", ""))[:10] != date_iso:
            continue
        other = str(t.get("text", "")).strip().lower()
        if other == key or key in other or other in key:
            return True
    return False


def rescue(content: str, existing: list, default_date: Optional[str] = None) -> Optional[dict]:
    """The task this message asked for, when nothing else saved it. Or None.

    Returns a task dict in the same shape infer_task_details produces, so every
    downstream step — memory, the Supabase mirror, provenance, the app — handles
    it identically to one the model created.
    """
    # Hours said in words become digits first, so the title loses them too.
    content = task_extract.spoken_hours(content)
    if not looks_like_a_task(content):
        return None
    time_hhmm = clock_time(content)
    title = title_from(content)
    if not title:
        return None

    # The date the user actually named. NO date is a real answer, not a
    # failure: it becomes an undated task in the general list rather than being
    # dumped on today, where it would be "late" by the evening for no reason.
    matches = re.findall(_tz.REL_DATE_RE, content or "")
    target = _tz.resolve_date_at(matches[0]) if matches else None
    if target is None and default_date:
        target = _date.fromisoformat(default_date)   # the day named above this line
    if target is None and time_hhmm:
        # "אימון ב 6 בערב" names an hour and no day: today. Undated AND timed
        # made it a "flexible task, no fixed hour" — the hour she said, dropped.
        target = _tz.today_il()
    date_iso = target.isoformat() if target else None

    if date_iso and already_there(existing, title, date_iso):
        return None

    logger.warning(
        "task rescue: the model saved nothing — creating one (date=%s time=%s)",
        date_iso, time_hhmm)
    labelled = categorize.merge(title, {})
    ranged = task_extract.parse_time_range(content or "")
    task = {
        "text": title,
        "category": labelled["category"],
        "priority": labelled["priority"],
        # "עד 8 בערב" is the length she gave; the table's default is a guess.
        "duration_minutes": ranged["minutes"] if ranged else labelled["duration_minutes"],
        "rescued": True,
    }
    if date_iso:
        task["date"] = date_iso
    if time_hhmm:
        task["fixed_time"] = time_hhmm
    return task


# ── "is this the same thing I already have?" ────────────────────────────────
#
# dedup_service.pair_score cannot answer this: it returns 0.0 the moment two
# dates differ, which is exactly the case here — the user is saying the same
# commitment again WITH A NEW TIME. So intent is scored on wording alone, using
# the same embeddings when they are configured and the same lexical fallback
# when they are not, and the decision about WHEN is made afterwards.
#
# Two scales, because the two scorers do not share one.
#
# Measured against this account's only embedding model (Qwen/Qwen3-Embedding-8B,
# which does work in Hebrew) on real tasks from her list:
#
#     0.946  לדבר עם יניר   ~ שיחה עם יניר      the same thing, reworded
#     0.912  אימון בוקר     ~ אימון ערב         TWO DIFFERENT WORKOUTS
#     0.878  תור לרופא      ~ ביקור אצל רופא    probably the same
#     0.775  פגישה עם משה   ~ פגישה עם יניר     different people
#     0.691  יוגה           ~ אימון כושר
#     0.623  תור לרופא רן קידר ~ כנס האקריות    unrelated
#     0.415  חתונה          ~ ללמוד לראיון      unrelated
#
# Cosine here is compressed into roughly 0.4–0.95, so the lexical thresholds do
# not transfer: 0.62 would have called a doctor's appointment and a conference
# "maybe the same". And 0.912 for morning-vs-evening training is why auto-merge
# has to sit ABOVE it — merging those two silently deletes a workout.
EMBED_SAME = 0.93
EMBED_MAYBE = 0.80
# The lexical fallback keeps dedup_service's own scale.
LEXICAL_SAME = 0.82
LEXICAL_MAYBE = 0.62

# Kept as the names the rest of the code reads; resolved per scorer below.
SAME_INTENT = LEXICAL_SAME
MAYBE_INTENT = LEXICAL_MAYBE


async def find_same_intent(title: str, existing: list) -> tuple:
    """(task, score, embedded) for the open task that means the same thing.

    Only open tasks are considered — finishing something and then planning it
    again is a new commitment, not an edit of the old one.
    """
    import dedup_service

    candidates = [t for t in (existing or [])
                  if str(t.get("status", "pending")) not in ("complete", "moved")
                  and (t.get("text") or "").strip()]
    if not title or not candidates:
        return None, 0.0, False

    texts = [title] + [t["text"] for t in candidates]
    vec = None
    try:
        vectors = await dedup_service.embed_texts(texts)
        if vectors:
            vec = dict(zip(texts, vectors))
    except Exception as exc:  # noqa: BLE001 — lexical fallback is fine
        logger.info("intent embedding unavailable (%s) — using lexical score", exc)

    best, best_score = None, 0.0
    for t in candidates:
        other = t["text"]
        if vec and title in vec and other in vec:
            score = dedup_service.cosine(vec[title], vec[other])
        else:
            score = dedup_service.text_similarity(title, other)
        # "יוגה" and "אימון כושר" score 0.691 — barely above two unrelated
        # tasks — because they share no words and mean the same thing only if
        # you know her. known_places already knows: both resolve to @fitness.
        # A curated synonym beats a model that is guessing.
        if same_activity(title, other):
            score = max(score, maybe_threshold(bool(vec)))
        if score > best_score:
            best, best_score = t, score
    hit = best_score >= maybe_threshold(bool(vec))
    return (best if hit else None), best_score, bool(vec)


def same_threshold(embedded: bool) -> float:
    """Auto-update above this — the bar for changing something without asking."""
    return EMBED_SAME if embedded else LEXICAL_SAME


def maybe_threshold(embedded: bool) -> float:
    """Ask above this. Below it, the two are simply different things."""
    return EMBED_MAYBE if embedded else LEXICAL_MAYBE


def same_activity(a: str, b: str) -> bool:
    """Do both name the same known activity ("@fitness")? Curated, not inferred."""
    try:
        import known_places
        ka, kb = known_places.activity_key(a), known_places.activity_key(b)
        return bool(ka) and ka == kb
    except Exception:  # noqa: BLE001 — the map is an optimisation, never a requirement
        return False


def _minutes(hhmm) -> Optional[int]:
    try:
        h, m = str(hhmm)[:5].split(":")
        return int(h) * 60 + int(m)
    except (TypeError, ValueError):
        return None


def already_planned(existing: list, task: dict) -> Optional[dict]:
    """The task she already has that THIS one repeats, or None.

    Koral, 2026-09-28: "the karaoke shows twice — if I said it and it is
    already on the schedule, it does not need to be there twice." She said
    "ואחר כך הקריוקי" about the "קריוקי באלנבי 30" already on her day, and the
    turn created "לקריוקי" beside it: the model was told to find_task first and
    did not, and nothing in code checked.

    Same day, open, the words line up once Hebrew's glued prefixes are off
    ("לקריוקי" is "קריוקי"), and no two different hours — "אימון בוקר" and
    "אימון ערב" stay two workouts."""
    date = str(task.get("date") or "")[:10]
    mine = task_intent._tokens(task.get("text", ""))
    if not date or not mine:
        return None
    at = _minutes(task.get("fixed_time"))
    for t in existing or []:
        if str(t.get("date") or "")[:10] != date or t.get("status") in ("complete", "moved"):
            continue
        # The same person in two scripts at the same minute is one meeting
        # ("שיחה עם סגית" beside Google's "Sagit/Koral- intro", 1.10).
        if at is not None and _minutes(t.get("fixed_time")) == at \
                and name_skeleton.shares_a_name(task.get("text"), t.get("text")):
            return t
        theirs = task_intent._tokens(t.get("text", ""))
        if not theirs or len(mine & theirs) / min(len(mine), len(theirs)) < 0.7:
            continue
        other = _minutes(t.get("fixed_time"))
        if at is not None and other is not None and abs(at - other) > 90:
            continue
        return t
    return None


_DAY_WORDS = {"ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "יום", "היום", "מחר",
              "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
              "today", "tomorrow", "שבתות"}


def hollow_title(text: Optional[str]) -> bool:
    """A title that says WHEN and nothing else: '🗓️ שבת | |'. 18.10: a templated
    message lost its subject, the task was saved with only the day left, and
    every re-send matched it as a twin and never repaired it."""
    words = re.findall(r"[^\W\d_]+", str(text or ""), re.UNICODE)
    return not [w for w in words if w.lower() not in _DAY_WORDS]


def changed_fields(existing_task: dict, new_task: dict) -> dict:
    """What the user just said that differs from what is stored.

    The WHEN and WHERE — the title is what matched, so rewriting it with a
    slightly different phrasing would churn the task for no gain. The one
    exception: a stored title that names no activity at all (hollow_title) is
    replaced by one that does.
    """
    patch = {}
    new_text = str(new_task.get("text") or "").strip()
    if new_text and hollow_title(existing_task.get("text")) and not hollow_title(new_text):
        patch["text"] = new_text
    if new_task.get("notes") and not existing_task.get("notes") and not existing_task.get("progress"):
        patch["notes"] = new_task["notes"]
    for field in ("date", "fixed_time", "location"):
        new_value = new_task.get(field)
        if new_value and new_value != existing_task.get(field):
            patch[field] = new_value
    return patch


# ── "when shall we do it?" ──────────────────────────────────────────────────

# Hours worth offering. Early morning and late night are not proposals, they
# are what you fall back to when a day is already full.
_SLOT_HOURS = [9, 10, 11, 12, 14, 16, 17, 19, 20]


def free_slots(existing: list, date_iso: str, now_hhmm: str = "", limit: int = 3) -> list:
    """Up to `limit` free hours on that date, as HH:MM.

    A task with no time is not a failure to be nagged about — it is a decision
    not yet made. Offering three concrete hours turns an open question into a
    tap, which is the difference between a plan and a list.
    """
    taken = set()
    for t in existing or []:
        if str(t.get("date", ""))[:10] != date_iso:
            continue
        hhmm = str(t.get("fixed_time") or "")[:5]
        if len(hhmm) == 5:
            taken.add(int(hhmm[:2]))
    out = []
    for hour in _SLOT_HOURS:
        if hour in taken:
            continue
        slot = f"{hour:02d}:00"
        if now_hhmm and slot <= now_hhmm:
            continue   # never propose an hour that has already gone
        out.append(slot)
        if len(out) >= limit:
            break
    return out
