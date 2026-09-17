"""task_intent — what the user wants done, decided by rules rather than a model.

The Python twin of `src/services/TaskIntent.ts`, and for the same reason that
file gives:

    picking one of four words is not work for a 235B model, and a wrong rule
    costs the same confirmation tap the wrong guess did.

The app dropped its LLM fallback here months ago. The server did not: every
check-in transcript went to Nebius to be sorted into one of nine intents, so the
phone answered "is this an update?" offline in under a millisecond while the
server paid a network round trip and a token bill for the same question. This is
that classifier, ported, extended to the intents the check-in screen actually
uses, and kept honest by tests/test_checkin_parse.py.

HEBREW AND WORD BOUNDARIES. `\\b` is defined on ASCII word characters, so
`\\bמחר\\b` matches nothing at all — a whole Hebrew branch of the TypeScript was
dead code for exactly this reason. Every Hebrew pattern here uses explicit
`(?:^|\\s)` / `(?=\\s|$)` anchors instead. Do not "tidy" them into `\\b`.

Dependencies: re only — no model, no network, no storage. Consumed by
checkin_parse; safe for anything else that needs the same verdict.
"""
from __future__ import annotations

import re
from typing import Optional

#: The intents the check-in screen renders. Same tuple the wire contract uses.
INTENTS = ("add_tasks", "check_in", "task_update", "conflict", "optimize",
           "wake_up", "profile_update", "empty_list", "classify_group")

_HE = r"(?:^|\s|[.,!?])"          # a Hebrew-safe left anchor
_HE_END = r"(?=\s|$|[.,!?])"      # ...and right

UPDATE_RE = re.compile(
    r"\b(move|change|reschedul\w*|postpone|push back|delay|shift|rename|update|edit)\b"
    rf"|{_HE}(תזיז|הזז|תעביר|העבר|תשנה|שנה|תדחה|דחה|תדחוף|תעדכן|עדכן|תערוך|ערוך|תקדים|הקדם){_HE_END}",
    re.IGNORECASE)

COMPLETE_RE = re.compile(
    r"\b(done( with)?|finished|completed|i did|i've done|mark .* (as )?(done|complete))\b"
    rf"|{_HE}(סיימתי|גמרתי|עשיתי|בוצע|הושלם|ביצעתי|הספקתי){_HE_END}",
    re.IGNORECASE)

DELETE_RE = re.compile(
    r"\b(delete|remove|cancel|drop|forget( about)?|scrap)\b"
    rf"|{_HE}(תמחק|מחק|תבטל|בטל|תוריד|הורד|תסיר|הסר){_HE_END}",
    re.IGNORECASE)

CREATE_RE = re.compile(
    r"\b(add|new task|create|remind me to|i need to|i have to|i've got to)\b"
    rf"|{_HE}(תוסיף|הוסף|תזכיר לי|צריך ל|צריכה ל|יש לי|אני צריך|אני צריכה){_HE_END}",
    re.IGNORECASE)

WAKE_RE = re.compile(
    r"\b(wake me( up)?|set an alarm|alarm for)\b"
    rf"|{_HE}(תעיר אותי|תעירי אותי|תעורר אותי|שעון מעורר|תעירו אותי){_HE_END}",
    re.IGNORECASE)

OPTIMIZE_RE = re.compile(
    r"\b(optimi[sz]e|plan my day|sort my day|organi[sz]e my day|rearrange my day|"
    r"what should i do (first|next))\b"
    rf"|{_HE}(תסדרי? לי את היום|סדר לי את היום|תארגני? לי את היום|תתכנני? לי את היום|"
    rf"מה לעשות קודם|תמיטבי? את היום){_HE_END}",
    re.IGNORECASE)

#: Standing facts about the person, not things to do. These are the sentences
#: that must NOT become tasks — "I usually get up at seven" is a routine.
PROFILE_RE = re.compile(
    r"\b(i (usually|normally|always) (wake|get up|leave|start|finish|sleep)|"
    r"i (live|work) (at|in)|my (home|address|commute|routine|work day|working hours)|"
    r"i (drive|cycle|walk|take the bus|take the train) to)\b"
    rf"|{_HE}(אני גר|אני גרה|אני עובד ב|אני עובדת ב|הכתובת שלי|בדרך כלל אני|"
    rf"אני קם ב|אני קמה ב|אני הולך לישון|אני הולכת לישון|אני נוסע ב|אני נוסעת ב|"
    rf"הרוטינה שלי|שעות העבודה שלי){_HE_END}",
    re.IGNORECASE)

CONFLICT_RE = re.compile(
    r"\b(clash|conflict|overlap|double.?booked|at the same time|i can't be in both)\b"
    rf"|{_HE}(התנגשות|חופף|חופפות|באותה שעה|מתנגש){_HE_END}",
    re.IGNORECASE)

EMPTY_RE = re.compile(
    r"^\s*(nothing|nothing much|no|none|nope|nothing today|didn'?t do anything)\s*[.!]?\s*$"
    r"|^\s*(כלום|שום דבר|לא|לא כלום|כלום היום)\s*[.!]?\s*$",
    re.IGNORECASE)

#: Words that carry no task on their own, stripped before what is left is used
#: as the reference naming an existing task.
_NOISE_RE = re.compile(
    r"\b(the|my|a|an|task|please|it)\b"
    rf"|{_HE}(את|את ה|ה?משימה|של|בבקשה){_HE_END}",
    re.IGNORECASE)
_TIME_WORDS_RE = re.compile(
    r"\b(?:to|at|by)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b"
    r"|(?:ל|לשעה|בשעה|ב-)\s*\d{1,2}(?::\d{2})?"
    r"|\b(?:tomorrow|today|tonight|this (?:morning|afternoon|evening))\b"
    r"|(?:מחרתיים|מחר|היום|הערב|הבוקר|אחה\"צ)",
    re.IGNORECASE)

#: Clause separators for "gym at six and call mum" / "יוגה ב-11, ואז סופר".
_SPLIT_RE = re.compile(
    r"\s*(?:[;\n]|,\s*(?:and|then|ואז|וגם|אחר כך)\s+|\s+(?:and then|ואז)\s+)\s*",
    re.IGNORECASE)

_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def reference(text: str) -> str:
    """The part of the sentence naming a task, with verbs and time words gone.

    'move the gym to 18:00' -> 'gym'. Used to find WHICH existing task a command
    is about, so it must not leave the verb in — 'move gym' matches nothing.
    """
    out = text or ""
    for pattern in (UPDATE_RE, COMPLETE_RE, DELETE_RE, CREATE_RE, WAKE_RE):
        out = pattern.sub(" ", out)
    out = _TIME_WORDS_RE.sub(" ", out)
    out = _NOISE_RE.sub(" ", out)
    return _norm(out)


def extract_patch(text: str) -> dict:
    """What an update sentence wants changed: {"new_deadline": "HH:MM"} today.

    Deliberately narrow. A patch this function is not sure about is a patch the
    screen would apply to the wrong field, and the user would have to undo it —
    worse than asking. Date changes stay with tz.resolve_date at the caller.
    """
    patch: dict = {}
    match = _TIME_RE.search(text or "")
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
        if hour <= 23 and minute <= 59:
            patch["new_deadline"] = f"{hour:02d}:{minute:02d}"
            return patch
    bare = re.search(r"(?:\bat\b|\bto\b|בשעה|ל-|ב-)\s*(\d{1,2})(?!\d|:)", text or "",
                     re.IGNORECASE)
    if bare:
        hour = int(bare.group(1))
        if hour <= 23:
            if hour < 12 and re.search(r"\bpm\b|evening|בערב|בלילה", text or "", re.IGNORECASE):
                hour += 12
            patch["new_deadline"] = f"{hour:02d}:00"
    return patch


def classify(text: str, mode: str = "capture") -> str:
    """One of INTENTS, by rules only.

    Order is the whole design. The specific intents are tested before the
    generic ones, and `create` is tested before `update` because "add a meeting
    and move it to 6" is an add — the TypeScript makes the same call for the
    same reason.
    """
    text = _norm(text)
    if not text or EMPTY_RE.search(text):
        return "empty_list"
    if WAKE_RE.search(text):
        return "wake_up"
    if OPTIMIZE_RE.search(text):
        return "optimize"
    if CONFLICT_RE.search(text):
        return "conflict"
    # A standing fact only wins when nothing in the sentence asks for an action.
    if PROFILE_RE.search(text) and not CREATE_RE.search(text):
        return "profile_update"
    if CREATE_RE.search(text):
        return "add_tasks"
    if COMPLETE_RE.search(text):
        # "I finished the gym" is a check-in against what already exists; it is
        # never a new task.
        return "check_in"
    if DELETE_RE.search(text) or UPDATE_RE.search(text):
        return "task_update"
    # Nothing matched: the mode says what the user came here to do.
    return "check_in" if mode == "review" else "add_tasks"


def split_clauses(text: str) -> list:
    """One transcript → the separate things in it.

    Conservative on purpose: only explicit separators split. Over-splitting
    invents tasks nobody asked for, and 'ראיון עבודה במר גרופ' is one task with
    a place in it, not two.
    """
    parts = [_norm(p) for p in _SPLIT_RE.split(text or "")]
    return [p for p in parts if len(p) > 1]


#: Hebrew glues its prepositions and article onto the front of the word, so
#: "לרופא" (to the doctor) and "הרופא" (the doctor) are the same doctor. Without
#: stripping these, "סיימתי עם הרופא" matched none of ["תור לרופא"] and the
#: check-in silently ticked nothing off.
_HE_PREFIXES = "להבומכשו"


def _stem(word: str) -> str:
    """One leading Hebrew prefix letter removed, when there is a word left."""
    if len(word) > 3 and word[0] in _HE_PREFIXES and "\u0590" <= word[1] <= "\u05ff":
        return word[1:]
    return word


def _tokens(text: str) -> set:
    """Meaningful words, lowercased and Hebrew-stemmed. Two letters or fewer
    carry no signal in either language."""
    words = re.findall(r"[\w֐-׿]+", (text or "").lower())
    return {_stem(w) for w in words if len(w) > 2}


def match_existing(transcript: str, candidates: Optional[list],
                   threshold: float = 0.34) -> list:
    """Which of the user's pending tasks this transcript is talking about.

    Token overlap scored against the CANDIDATE's own length, so a short task
    name inside a long sentence still matches — the review case is exactly
    "I did the gym and the shopping" against ["Gym", "Weekly shop"].
    """
    said = _tokens(transcript)
    if not said:
        return []
    matched = []
    for candidate in candidates or []:
        words = _tokens(str(candidate))
        if not words:
            continue
        overlap = len(words & said) / len(words)
        if overlap >= threshold:
            matched.append((overlap, str(candidate)))
    matched.sort(key=lambda pair: (-pair[0], pair[1]))
    return [text for _, text in matched]


if __name__ == "__main__":   # self-check: python server/task_intent.py
    assert classify("תעירי אותי ב-7") == "wake_up"
    assert classify("move the gym to 18:00") == "task_update"
    assert classify("תזיז את היוגה ל-19:00") == "task_update"
    assert classify("סיימתי עם הרופא") == "check_in"
    assert classify("add a meeting tomorrow") == "add_tasks"
    assert classify("יוגה ב-11:00 ביגאל אלון") == "add_tasks"
    assert classify("כלום") == "empty_list"
    assert classify("אני גר ביגאל אלון 94") == "profile_update"
    assert classify("", "review") == "empty_list"
    assert classify("the doctor", "review") == "check_in"
    assert extract_patch("move the gym to 18:00") == {"new_deadline": "18:00"}
    assert extract_patch("תזיז את היוגה ל-19") == {"new_deadline": "19:00"}
    assert extract_patch("rename the task") == {}
    assert reference("move the gym to 18:00") == "gym"
    assert split_clauses("gym at six and then call mum") == ["gym at six", "call mum"]
    assert split_clauses("ראיון עבודה במר גרופ") == ["ראיון עבודה במר גרופ"]
    assert match_existing("I did the gym", ["Gym", "Weekly shop"]) == ["Gym"]
    # The Hebrew prefix case: "הרופא" must find "תור לרופא".
    assert match_existing("סיימתי עם הרופא", ["תור לרופא", "יוגה"]) == ["תור לרופא"]
    assert match_existing("סיימתי עם הרופא", ["יוגה"]) == [], "no false positives"
    print("task_intent self-check OK")
