"""profile_extract — onboarding answers → profile fields, server-side.

The onboarding agent ran on the phone with the API key in the bundle, and its
prompt was the app's alone: the server had its own `save_profile` tool with
different field names and its own idea of what "morning routine" meant, so the
two halves of one product learned different things about the same person. This
moves the extraction to the server and, in the same motion, writes what it
learns into the profile the WhatsApp brain already reads.

The reply shape is exactly what OnboardingScreen already renders — camelCase,
`missingFields`, `followUpQuestion`, `isComplete` — because the screen's job is
now to render an answer, not to compute one. Required fields are decided here,
in code, rather than trusted from the model: `isComplete` was a field the model
could simply assert, and a model in a hurry ended an onboarding that had
collected nothing.

Dependencies: config, llm_usage, user_profile. Consumed by
routes_app.POST /app/profile/extract.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

from openai import AsyncOpenAI

import ai_gate
import config
import model_router
import llm_usage
import user_profile

logger = logging.getLogger(__name__)

_client: Optional[AsyncOpenAI] = None

# Asked in this order, one at a time, until every one is covered (8.10, Koral):
#   the morning — what she does, when she wakes — then "so it takes you about
#   40 minutes?"; her routines (a workout, a class) — where, which days, what
#   hour, how she gets there; work — where, how she gets there; home, car, sleep.
# "No car", "no routines" and "I don't work" are answers that close a question.
REQUIRED = ("name", "wakeTime", "morningHabitsOrTotal", "morningConfirmed", "routines",
            "workAddress", "workTransport", "homeAddress", "hasCar", "sleepTime")
ROUTINE_PARTS = ("place", "days", "time", "transport")

# Her words, not the model's: the next question is chosen and phrased HERE, so
# it is always about what is actually missing and always sounds the same.
QUESTIONS = {
    "he": {
        "name": "איך קוראים לך?",
        "wakeTime": "מתי את קמה בדרך כלל?",
        "morningHabitsOrTotal": "ומה את עושה בבוקר עד שאת יוצאת מהבית?",
        "morningConfirmed": "אז לוקח לך בערך {minutes} דקות להתארגן?",
        "routines": "מה הרוטינות שלך ביום-יום? את מתאמנת? יש לך חוג?",
        "place": "{what} — איפה זה?",
        "days": "ובאילו ימים יש לך {what}?",
        "time": "{what} — באיזו שעה?",
        "transport": "ואיך את מגיעה ל{what} בדרך כלל?",
        "workAddress": "איפה את עובדת?",
        "workTransport": "ואיך את נוסעת לעבודה בדרך כלל?",
        "homeAddress": "איפה את גרה? מספיק רחוב ועיר.",
        "hasCar": "יש לך אוטו?",
        "sleepTime": "ובאיזו שעה את הולכת לישון בדרך כלל?",
    },
    "en": {
        "name": "What's your name?",
        "wakeTime": "When do you usually wake up?",
        "morningHabitsOrTotal": "And what do you do in the morning before you leave?",
        "morningConfirmed": "So getting ready takes you about {minutes} minutes?",
        "routines": "What are your everyday routines? Do you work out? A class?",
        "place": "{what} — where is it?",
        "days": "Which days do you have {what}?",
        "time": "{what} — what time?",
        "transport": "And how do you usually get to {what}?",
        "workAddress": "Where do you work?",
        "workTransport": "And how do you usually get to work?",
        "homeAddress": "Where do you live? Street and city is enough.",
        "hasCar": "Do you have a car?",
        "sleepTime": "And what time do you usually go to sleep?",
    },
}
_ACKS = {"he": ("מעולה.", "סגור, רשמתי.", "יופי.", "הבנתי."),
         "en": ("Great.", "Got it.", "Lovely.", "Noted.")}

_SYSTEM = "\n".join([
    "You are Meira, a warm and friendly AI time assistant doing a first-time onboarding conversation.",
    "",
    "The user just answered one of your onboarding questions.",
    "",
    "Extract as much profile information as you can from their answer. Return ONLY valid JSON:",
    "{",
    '  "name": string or null,',
    '  "wakeTime": string (HH:MM) or null,',
    '  "morningHabits": [ { "habit": string, "estimatedMinutes": number } ] or [],',
    '  "totalMorningMinutesEstimate": number or null,',
    '  "morningConfirmed": true if they confirmed the morning length you proposed (a corrected number goes in totalMorningMinutesEstimate and also confirms) | null,',
    '  "routines": [ { "what": string, "place": string|null, "days": "the days as they said them"|null, "time": "HH:MM or HH:MM-HH:MM"|null, "transport": "car|bus|train|bike|walk"|null } ] | "none" if they have none | [],',
    '  "workAddress": string | "none" if they do not work or study at a fixed place | null,',
    '  "workTransport": "car|bus|train|bike|walk" | null,',
    '  "workStartTime": string (HH:MM) or null,',
    '  "transportMode": "car" | "foot" | "bicycle" | "transit" | null,',
    '  "hasCar": true | false | null,',
    '  "homeAddress": string or null,',
    '  "sleepTime": string (HH:MM) or null,',
    '  "routinesNotes": string or null,',
    '  "followUpQuestion": "your next warm question for what is still missing, or empty string"',
    "}",
    "",
    "A routine's details may arrive one at a time ('on Sundays and Tuesdays', 'at",
    "seven', 'by bike'): put them on the routine the last question was about, by",
    "its 'what', and repeat the routines already known with every field you have.",
    "",
    "routinesNotes: constraints and habits IN THEIR WORDS — a school pickup, a",
    "standing class, an hour that is never free, 'I cannot do mornings'. These",
    "never appear on a calendar and they are the reason a technically valid plan",
    "is still wrong.",
    "",
    "If they give a rough total for their morning ('about an hour') and no specific",
    "habits, set totalMorningMinutesEstimate and leave morningHabits empty.",
    "",
    "One question at a time, warm and short. The opening question asked for",
    "everything at once, so most people answer several fields in one breath: read",
    "the WHOLE answer before deciding what is missing. Asking again for something",
    "they just said is the fastest way to lose them.",
    "Answer in the language the user wrote in.",
])


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        # One retry, not two: 3 x 25 s outlasted the app's 60 s (9.10, a slow Nebius).
        _client = ai_gate.client().with_options(max_retries=1)
    return _client


def _clean_time(value) -> Optional[str]:
    import re
    if not isinstance(value, str):
        return None
    match = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", value)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    return f"{hour:02d}:{minute:02d}" if hour <= 23 and minute <= 59 else None


def morning_minutes(merged: dict) -> int:
    """Her morning, in minutes: the habits added up, else her own estimate."""
    habits = merged.get("morningHabits") or []
    total = sum(int(h.get("estimatedMinutes") or 0) for h in habits if isinstance(h, dict))
    return int(merged.get("totalMorningMinutesEstimate") or total or 0)


def missing_fields(merged: dict) -> list:
    """What onboarding still needs, in the order it is asked. Decided HERE,
    never taken from the model — `isComplete` used to be something the model
    could simply assert. A routine's missing detail reads 'routine:<i>:<part>'."""
    missing = []
    for f in REQUIRED:
        if f == "morningHabitsOrTotal":
            if not morning_minutes(merged):
                missing.append(f)
        elif f == "morningConfirmed":
            if morning_minutes(merged) and merged.get("morningConfirmed") is not True:
                missing.append(f)
        elif f == "routines":
            routines = merged.get("routines")
            if routines == "none":
                continue
            if not routines:
                missing.append(f)
                continue
            for i, r in enumerate(routines):
                for part in ROUTINE_PARTS:
                    if not r.get(part):
                        missing.append(f"routine:{i}:{part}")
        elif f == "workTransport":
            if merged.get("workAddress") not in (None, "", "none") and not merged.get("workTransport"):
                missing.append(f)
        elif f == "hasCar":
            if not isinstance(merged.get("hasCar"), bool):
                missing.append(f)
        elif not merged.get(f):
            missing.append(f)
    return missing


def next_question(missing: list, lang: str, answered: int = 0, merged: Optional[dict] = None) -> str:
    """A short thanks for what she said, then the ONE next thing missing."""
    if not missing:
        return ""
    lang = "he" if lang == "he" else "en"
    merged = merged or {}
    field = missing[0]
    what = ""
    if field.startswith("routine:"):
        _, i, field = field.split(":")
        what = str((merged.get("routines") or [{}])[int(i)].get("what") or "")
    q = QUESTIONS[lang][field].format(what=what, minutes=morning_minutes(merged))
    ack = _ACKS[lang][answered % len(_ACKS[lang])] + " " if answered else ""
    return ack + q


_MODE_HE = {"car": "באוטו", "bus": "באוטובוס", "train": "ברכבת", "bike": "באופניים", "walk": "ברגל",
            "transit": "בתחבורה ציבורית", "foot": "ברגל", "bicycle": "באופניים"}
_MODE_EN = {"car": "by car", "bus": "by bus", "train": "by train", "bike": "by bike", "walk": "on foot",
            "transit": "by public transport", "foot": "on foot", "bicycle": "by bike"}


_TRAINING = re.compile(r"(אימון|אימונים|חדר כושר|כושר|להתאמן|מתאמנת|קיקבוקס|פילאטיס|יוגה|ריצה|שחייה|קרוספיט|gym|workout|pilates|yoga|kickbox)", re.I)


def echo_line(known: dict, merged: dict, lang: str) -> str:
    """What she just told Meira, said back in Meira's words (8.10, Koral:
    "repeat after me — 'I understood, no car so you go by public transport;
    you train Sunday to Tuesday in the evening'"). Built from what CHANGED in
    this answer, field by field — never a model's paraphrase, so it can only
    say what was actually saved. Empty when nothing new was understood."""
    he = lang == "he"
    known = known or {}
    parts = []

    def new(key):
        v = merged.get(key)
        return v if v not in (None, "", []) and v != known.get(key) else None

    if new("name"):
        parts.append(f"נעים מאוד, {merged['name']}" if he else f"nice to meet you, {merged['name']}")
    if new("wakeTime"):
        parts.append(f"את קמה ב-{merged['wakeTime']}" if he else f"you wake up at {merged['wakeTime']}")
    mins = morning_minutes(merged)
    if mins and mins != morning_minutes(known) and merged.get("morningConfirmed"):
        parts.append(f"הבוקר לוקח לך {mins} דקות" if he else f"your morning takes {mins} minutes")
    car_new = isinstance(merged.get("hasCar"), bool) and merged.get("hasCar") != known.get("hasCar")
    mode = merged.get("transportMode")
    if car_new and merged["hasCar"] is False:
        parts.append(("אין לך אוטו, אז את " + _MODE_HE.get(mode, "בתחבורה ציבורית")) if he
                     else ("no car, so you go " + _MODE_EN.get(mode, "by public transport")))
    elif car_new:
        parts.append("יש לך אוטו" if he else "you have a car")
    elif new("transportMode"):
        parts.append(f"את מתניידת {_MODE_HE.get(mode, mode)}" if he else f"you get around {_MODE_EN.get(mode, mode)}")
    old_r = {str(r.get("what")): r for r in (known.get("routines") if isinstance(known.get("routines"), list) else [])}
    if merged.get("routines") == "none" and known.get("routines") != "none":
        parts.append("אין לך רוטינות קבועות" if he else "no fixed routines")
    for r in merged.get("routines") if isinstance(merged.get("routines"), list) else []:
        before = old_r.get(str(r.get("what"))) or {}
        added = [k for k in ROUTINE_PARTS if r.get(k) and r.get(k) != before.get(k)]
        if not added and before:
            continue
        what = str(r.get("what"))
        if he and _TRAINING.search(what):
            # "את מתאמנת" for a workout; the name only when it says more.
            generic = what.strip().lower() in ("אימון", "אימונים", "כושר", "חדר כושר", "להתאמן", "gym", "workout")
            bits = ["את מתאמנת" + ("" if generic else f" ב{what}")]
        else:
            bits = [f"יש לך {what}" if he else what]
        if r.get("days"):
            bits.append(f"{'בימים' if he else 'on'} {r['days']}")
        if r.get("time"):
            t = str(r["time"])
            bits.append(f"ב-{t}" if he and re.match(r"^\d", t) else f"ב{t}" if he else f"at {t}")
        if r.get("place"):
            bits.append(f"{'ב' if he else 'at '}{r['place']}")
        if r.get("transport"):
            bits.append(_MODE_HE.get(r["transport"], r["transport"]) if he else _MODE_EN.get(r["transport"], r["transport"]))
        parts.append(" ".join(bits))
    if new("workAddress"):
        parts.append("את לא עובדת במקום קבוע" if (he and merged["workAddress"] == "none") else
                     "no fixed workplace" if merged["workAddress"] == "none" else
                     (f"את עובדת ב{merged['workAddress']}" if he else f"you work at {merged['workAddress']}"))
    if new("workTransport"):
        t = merged["workTransport"]
        parts.append(f"נוסעת לשם {_MODE_HE.get(t, t)}" if he else f"get there {_MODE_EN.get(t, t)}")
    if new("homeAddress"):
        parts.append(f"את גרה ב{merged['homeAddress']}" if he else f"you live at {merged['homeAddress']}")
    if new("sleepTime"):
        parts.append(f"הולכת לישון ב-{merged['sleepTime']}" if he else f"you go to sleep at {merged['sleepTime']}")
    if not parts:
        return ""
    if len(parts) > 1:
        body = ", ".join(parts[:-1]) + (" ו" if he else " and ") + parts[-1]
    else:
        body = parts[0]
    return (f"הבנתי — {body}." if he else f"Got it — {body}.")


def routine_line(r: dict) -> str:
    """One routine as the line routine_match and the phone already read."""
    words = {"car": "באוטו", "bus": "באוטובוס", "train": "ברכבת", "bike": "באופניים", "walk": "ברגל"}
    parts = [r.get("what"), r.get("days"), r.get("time"), r.get("place"),
             words.get(str(r.get("transport") or ""), r.get("transport"))]
    return " · ".join(str(p) for p in parts if p)


def routine_lines_to_save(routines: list) -> list:
    """The routine lines worth writing: a named routine with at least a day or an hour."""
    return [routine_line(r) for r in routines or []
            if isinstance(r, dict) and r.get("what") and (r.get("days") or r.get("time"))]


def _share_training_place(routines: list) -> None:
    """One gym, several sessions (9.10, Koral: "evening workout Sun–Tue at 20:00,
    Friday at 11:00, my gym is at Yigal Alon 94, by bike" became two routines
    and Meira asked "evening workout — where is it?"). A workout with no place
    or transport takes them from another workout that has them."""
    trainings = [r for r in routines if _TRAINING.search(str(r.get("what") or ""))]
    for part in ("place", "transport"):
        given = next((r[part] for r in trainings if r.get(part)), None)
        if given:
            for r in trainings:
                if not r.get(part):
                    r[part] = given


# "I don't work right now" — said, and still missed by the model (9.10). A
# closed question must not depend on the model noticing it.
_NO_WORK = re.compile(
    r"(לא\s+עובד(?:ת)?|אין\s+לי\s+עבודה|מובטל(?:ת)?|בין\s+עבודות|מחפש(?:ת)?\s+עבודה"
    r"|\bI\s+(?:don'?t|do\s+not)\s+work\b|\bnot\s+working\b|\bunemployed\b|\bbetween\s+jobs\b)", re.I)


def says_no_work(transcript: str) -> bool:
    return bool(_NO_WORK.search(transcript or ""))


# She said she moved / where she lives — the only way an existing home changes.
_HOME_WORDS = re.compile(r"(גר(?:ה|ים)?\b|עבר(?:תי|נו)\s+דירה|הבית\s+שלי|כתובת\s+הבית|בית\s+חדש"
                         r"|\bI\s+live\b|\bmoved\b|\bmy\s+home\b|\bhome\s+address\b)", re.I)


def route_to_question(extracted: dict, known: dict, transcript: str) -> None:
    """An answer belongs to the question that was asked (11.10, Koral: Meira
    asked "work out — where is it?", she said "Yigal Alon 96", and the model
    filed it as her HOME — her real home was overwritten and the workout
    stayed without a place). Decided in code from what was missing, before the
    model's labels are trusted:
      · a routine's place / transport that came back as home or work goes to
        the routine;
      · a home she already has changes only when she says she lives there."""
    pending = (missing_fields(known) or [""])[0]
    routines = known.get("routines") if isinstance(known.get("routines"), list) else []
    if pending.startswith("routine:"):
        _, i, part = pending.split(":")
        r = routines[int(i)] if int(i) < len(routines) else {}
        what = r.get("what")
        got = extracted.get("routines") if isinstance(extracted.get("routines"), list) else []
        has_part = any(isinstance(x, dict) and x.get(part) for x in got)
        if what and not has_part:
            value = None
            if part == "place":
                for key in ("homeAddress", "workAddress"):
                    v = str(extracted.get(key) or "").strip()
                    if v and v.lower() != "none" and v != known.get(key):
                        value = v
                        extracted[key] = None
                        break
            elif part == "transport":
                v = extracted.get("workTransport")
                if v and v != "none":
                    value, extracted["workTransport"] = v, None
            if value:
                extracted["routines"] = [*got, {"what": what, part: value}]
    home = str(extracted.get("homeAddress") or "").strip()
    if home and known.get("homeAddress") and home != known["homeAddress"] \
            and pending != "homeAddress" and not _HOME_WORDS.search(transcript or ""):
        logger.warning("profile_extract: kept her home — the answer did not say she lives elsewhere")
        extracted["homeAddress"] = None
    elif home and known.get("homeAddress"):
        # 13.10: "מורדי הגטאות 23" with no city geocoded to Be'er Sheva and a
        # Haifa interview was planned from there. A home re-said without a
        # town keeps the town of the home before it.
        import routine_match
        extracted["homeAddress"] = routine_match.complete_address(home, known["homeAddress"])


def _routines_from_her_words(extracted: dict, transcript: str) -> None:
    """Her days and hours, read from her words by code, beat the model's reading of them.

    21.10: "יוגה ביום שלישי ב 8 בערב שעה וחצי ובשישי בבוקר 11 עד 12 וחצי" came back from the
    model as 08:00-09:30 on Sun-Tue (the days of ANOTHER line), and Friday was lost because a
    routine holds one hour. Each day-clause becomes its own routine, named after its day when
    one activity has several."""
    try:
        import routine_text
        said = routine_text.routines_from_text(transcript)
    except Exception as exc:  # noqa: BLE001
        logger.warning("routine_text failed: %s", exc)
        return
    said = [r for r in said if r.get("days") and r.get("time")]
    if not said:
        return
    model = extracted.get("routines") if isinstance(extracted.get("routines"), list) else []
    base = next((m for m in model if isinstance(m, dict) and routine_text._activity(str(m.get("what") or ""))
                 == routine_text._activity(said[0]["what"])), None) or {}
    kept = [m for m in model if m is not base]
    for r in said:
        name = r["what"] if len(said) == 1 else f"{r['what']} {routine_text._days_he(r['days'])}"
        time = f"{r['time']}-{r['end']}" if r.get("end") else r["time"]
        kept.append({"what": name, "place": base.get("place"), "days": routine_text._days_he(r["days"]),
                     "time": time, "transport": base.get("transport")})
    extracted["routines"] = kept


def merge(known: dict, extracted: dict) -> dict:
    """Known profile + what this answer added. A null never erases what we have."""
    known = known or {}
    merged = dict(known)
    for key in ("name", "transportMode", "homeAddress",
                "routinesNotes", "morningHabits", "totalMorningMinutesEstimate"):
        value = extracted.get(key)
        if value not in (None, "", []):
            merged[key] = value
    for key in ("wakeTime", "workStartTime", "sleepTime"):
        value = _clean_time(extracted.get(key))
        if value:
            merged[key] = value
    if extracted.get("morningConfirmed") is True or (
            known.get("totalMorningMinutesEstimate") and extracted.get("totalMorningMinutesEstimate")
            and extracted["totalMorningMinutesEstimate"] != known["totalMorningMinutesEstimate"]):
        merged["morningConfirmed"] = True
    for key in ("workAddress", "workTransport"):
        value = str(extracted.get(key) or "").strip()
        if value:
            merged[key] = "none" if value.lower() in ("none", "no", "אין", "לא") else value
    if merged.get("workAddress") == "none":
        # No workplace, no way of getting to it (9.10: a routine's "by bike"
        # was echoed again as how she gets to work).
        merged.pop("workTransport", None)
    routines = extracted.get("routines")
    if routines == "none" or (isinstance(routines, str) and routines.strip() in ("אין", "no")):
        if not known.get("routines") or known.get("routines") == "none":
            merged["routines"] = "none"
    elif isinstance(routines, list) and routines:
        have = [dict(r) for r in (known.get("routines") or []) if isinstance(r, dict)] \
            if isinstance(known.get("routines"), list) else []
        for r in routines:
            if not isinstance(r, dict) or not str(r.get("what") or "").strip():
                continue
            same = next((h for h in have if str(h.get("what")).strip() == str(r["what"]).strip()), None)
            if same is None:
                have.append({k: r.get(k) for k in ("what",) + ROUTINE_PARTS})
            else:
                for k in ROUTINE_PARTS:
                    if r.get(k):
                        same[k] = r[k]
        _share_training_place(have)
        merged["routines"] = have
    if not merged.get("transportMode") and merged.get("workTransport") not in (None, "none"):
        merged["transportMode"] = {"bus": "transit", "train": "transit", "bike": "bicycle",
                                   "walk": "foot"}.get(merged["workTransport"], merged["workTransport"])
    if isinstance(extracted.get("hasCar"), bool):
        merged["hasCar"] = extracted["hasCar"]
    elif merged.get("transportMode") == "car" and not isinstance(merged.get("hasCar"), bool):
        merged["hasCar"] = True          # "I drive everywhere" answers the car question
    return merged


async def extract(transcript: str, known: Optional[dict] = None,
                  phone: Optional[str] = None, lang: str = "", asked: str = "") -> dict:
    """One onboarding answer → the fields it carried, plus what is still missing."""
    known = known or {}
    extracted: dict = {}
    follow_up = ""
    _model = config.LLM_MODEL_CHEAP or model_router.pick(
        "profile_extract", prompt_chars=len(_SYSTEM) + len(transcript))
    try:
        response = await _get_client().chat.completions.create(
            model=_model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user",
                 "content": f"Current known profile fields: {json.dumps(known, ensure_ascii=False)}"
                            f"\n\nYour last question: {asked or '(the opening)'}"
                            f"\n\nUser answer: {transcript}"},
            ],
            temperature=0.2,
            response_format={"type": "json_object"},
            timeout=25,
        )
        usage = response.usage
        if usage:
            llm_usage.record("profile_extract", usage.prompt_tokens or 0,
                             usage.completion_tokens or 0, _model)
        extracted = json.loads(response.choices[0].message.content or "{}")
        follow_up = str(extracted.get("followUpQuestion") or "")
    except Exception as exc:  # noqa: BLE001 — the client keeps its local fallback
        logger.warning("profile_extract failed: %s", exc)
        raise

    route_to_question(extracted, known, transcript)
    _routines_from_her_words(extracted, transcript)
    if says_no_work(transcript):
        extracted["workAddress"] = "none"
        extracted["workTransport"] = None
    merged = merge(known, extracted)
    missing = missing_fields(merged)

    # Write it where the WhatsApp brain reads it, so onboarding done in the app
    # is onboarding the whole product knows about — the divergence this
    # consolidation exists to end.
    if phone:
        try:
            user_profile.update_profile(
                phone,
                name=merged.get("name"),
                homeAddress=merged.get("homeAddress"),
                transportType={"transit": "bus", "foot": "walk"}.get(
                    merged.get("transportMode"), merged.get("transportMode")),
                morningRoutineMinutes=merged.get("totalMorningMinutesEstimate"),
                routinesNotes=merged.get("routinesNotes"),
                hasCar=merged.get("hasCar") if isinstance(merged.get("hasCar"), bool) else None,
                defaultWakeTime=merged.get("wakeTime"),
                sleepTime=merged.get("sleepTime"),
                onboarded=not missing or None,
            )
        except Exception as exc:  # noqa: BLE001 — never fail onboarding on a write
            logger.warning("profile write skipped: %s", exc)

        # Routines and work become what Meira already reads: routine lines
        # (routine_match: hour, days, address) and known places.
        try:
            import known_places
            all_routines = merged.get("routines") if isinstance(merged.get("routines"), list) else []
            done = [r for r in all_routines if all(r.get(p) for p in ROUTINE_PARTS)]
            # A routine with its name and a day or an hour is already something Meira can show on
            # that day. Writing only the COMPLETE ones (all four parts) left "yoga on Thursday at
            # 18:00" unsaved because the place or the way was not said — 21.10: "I told her which
            # workout it is and nothing changed".
            lines = routine_lines_to_save(all_routines)
            if lines:
                user_profile.update_profile(phone, routinesNotes="\n".join(lines))
            for r in done:
                known_places.remember(phone, r["what"], r["place"])
            if merged.get("workAddress") not in (None, "", "none"):
                known_places.remember(phone, "עבודה", merged["workAddress"])
                user_profile.update_profile(phone, workAddress=merged["workAddress"])
            elif merged.get("workAddress") == "none" and known.get("workAddress") not in (None, "", "none"):
                # She no longer works there: the old place must stop being "work".
                user_profile.update_profile(phone, workAddress="")
                known_places.forget(phone, "עבודה")
        except Exception as exc:  # noqa: BLE001 — never fail onboarding on a write
            logger.warning("routines / work place not saved: %s", exc)

    # The next question is code's, about the first thing still missing; the
    # model's own question is used only when code has nothing to ask.
    # Meira answers in the language she SPOKE, not the app's setting (9.10:
    # Hebrew answers on an English phone came back as "Got it — יום ראשון, on
    # אימון בערב…"). The setting decides only when the words cannot.
    import tts
    lang = tts.language_of(transcript, lang)
    answered = sum(1 for f in REQUIRED if f not in missing) - sum(
        1 for f in REQUIRED if f not in missing_fields(known or {}))
    # Said back first, then the next question — no "Great." when there is
    # something real to repeat.
    heard = echo_line(known or {}, merged, "he" if lang == "he" else "en")
    question = next_question(missing, lang, 0 if heard else max(answered, 0), merged)
    follow_up = " ".join(p for p in (heard, question) if p) or ("" if not missing else follow_up)
    return {**merged, "missingFields": missing, "followUpQuestion": follow_up,
            "heardLine": heard, "isComplete": not missing}


if __name__ == "__main__":   # self-check: python server/profile_extract.py
    known = {"name": "קורל"}
    merged = merge(known, {"transportMode": "transit", "name": None,
                           "workStartTime": "9:00", "sleepTime": "24:30"})
    assert merged["name"] == "קורל", "a null must never erase what we know"
    assert merged["transportMode"] == "transit"
    assert merged["workStartTime"] == "09:00"
    assert "sleepTime" not in merged, "24:30 is not a time"
    assert "sleepTime" in missing_fields(merged)
    print("profile_extract self-check OK")
