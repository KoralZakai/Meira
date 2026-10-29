"""history_stats — "how many times did I work out this week?" answered by code.

Counting, summing and comparing are arithmetic. They are not the model's job
(CLAUDE.md → "What is deliberately NOT the model's job"): the model reads the
number this file computed and says it, in one short line.

Two inputs, both already opened (no I/O here, so every rule is unit-tested):
  tasks   rows of the tasks table: status, category, date, text, duration,
          actualDurationMinutes, movedFromDate, location.travelMinutes
  events  rows of lumi_history (history_store): moved / completed / missed /
          trip / study, each with a day and, where it has one, minutes

The tasks table forgets every move but the last, so reschedules come from the
event log. It never sees a focus session or a real door-to-door time, so those
come from the log too. Everything else the table already knows.

The coach is FIRM (Koral, 20.10): name the number, name the gap, offer one
concrete next step. Never a speech.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Iterable, Optional

METRICS = ("workouts", "learning_minutes", "road_minutes", "reschedules", "completed")

_WORKOUT_WORDS = (
    "אימון", "כושר", "חדר כושר", "ריצה", "יוגה", "פילאטיס", "שחייה", "קיקבוקס",
    "אגרוף", "טיפוס", "spinning", "ספינינג", "crossfit", "קרוספיט",
    "gym", "workout", "training", "run", "running", "yoga", "pilates", "swim",
    "kickbox", "boxing", "climbing", "cycling", "hiit",
    "זומבה", "zumba", "ספינינג", "ריקוד", "dance",
)
_STUDY_WORDS = (
    "ללמוד", "למידה", "לימוד", "לימודים", "שיעורי בית", "מבחן", "בחינה", "הרצאה",
    "תרגיל", "עבודה להגשה", "סמינר", "קורס",
    "study", "studying", "homework", "exam", "lecture", "assignment", "course", "revise",
)
_WORKOUT_CATS = {"gym"}
_STUDY_CATS = {"course", "class"}


def _has_word(text: str, words: Iterable[str]) -> bool:
    low = f" {str(text or '').lower()} "
    for w in words:
        if re.search(r"[a-z]", w):
            if re.search(rf"\b{re.escape(w)}(?:ing|s|es)?\b", low):
                return True
        elif w in low:
            return True
    return False


def is_workout(task: dict) -> bool:
    return task.get("category") in _WORKOUT_CATS or _has_word(task.get("text"), _WORKOUT_WORDS)


def is_study(task: dict) -> bool:
    return task.get("category") in _STUDY_CATS or _has_word(task.get("text"), _STUDY_WORDS)


# ─── periods ────────────────────────────────────────────────────────────────

def _week_start(d: date) -> date:
    """Israel's week starts on Sunday."""
    return d - timedelta(days=(d.weekday() + 1) % 7)


def period(expr: Optional[str], today: date) -> dict:
    """'this week' / 'שבוע שעבר' / 'החודש' / 'last 30 days' → {from, to, label, prev_from, prev_to}.
    Anything unrecognised is THIS WEEK, and the label says so — never a silent guess."""
    e = str(expr or "").strip().lower()
    # "…today? Not today, this week" (29.10): what she took back is not the period.
    e = re.sub(r"(?:\bnot\s+|לא\s+)(today|this\s+month|היום|החודש)", " ", e)
    if max(e.rfind("week"), e.rfind("שבוע")) > max(e.rfind("today"), e.rfind("היום")) >= 0:
        e = re.sub(r"today|היום", " ", e)        # she corrected herself: the last word wins

    def out(a: date, b: date, label: str, pa: date, pb: date) -> dict:
        return {"from": a.isoformat(), "to": b.isoformat(), "label": label,
                "prev_from": pa.isoformat(), "prev_to": pb.isoformat()}

    ws = _week_start(today)
    if any(k in e for k in ("last week", "שבוע שעבר", "השבוע שעבר", "שבוע הקודם")):
        a = ws - timedelta(days=7)
        return out(a, ws - timedelta(days=1), "last_week", a - timedelta(days=7), a - timedelta(days=1))
    if any(k in e for k in ("last month", "חודש שעבר", "החודש שעבר", "חודש הקודם")):
        first = today.replace(day=1)
        b = first - timedelta(days=1)
        a = b.replace(day=1)
        pb = a - timedelta(days=1)
        return out(a, b, "last_month", pb.replace(day=1), pb)
    if any(k in e for k in ("this month", "החודש", "month", "חודש")):
        a = today.replace(day=1)
        pb = a - timedelta(days=1)
        return out(a, today, "this_month", pb.replace(day=1), pb)
    m = re.search(r"(?<!\d)(\d{1,3})\s*(days|ימים)", e)
    if m:
        n = max(1, min(int(m.group(1)), 90))
        a = today - timedelta(days=n - 1)
        return out(a, today, f"last_{n}_days", a - timedelta(days=n), a - timedelta(days=1))
    if any(k in e for k in ("today", "היום")):
        y = today - timedelta(days=1)
        return out(today, today, "today", y, y)
    label = "this_week" if (not e or any(k in e for k in ("week", "שבוע"))) else "this_week_default"
    a = ws - timedelta(days=7)
    return out(ws, today, label, a, a + timedelta(days=(today - ws).days))


# ─── the numbers ────────────────────────────────────────────────────────────

def _in(day: Optional[str], a: str, b: str) -> bool:
    return bool(day) and a <= str(day)[:10] <= b


def _minutes(task: dict) -> int:
    for k in ("actualDurationMinutes", "actual_duration_minutes", "durationMinutes", "duration_minutes"):
        v = task.get(k)
        if isinstance(v, (int, float)) and 0 < v < 24 * 60:
            return int(v)
    return 0


def _travel(task: dict) -> int:
    loc = task.get("location")
    if not isinstance(loc, dict):
        return 0
    v = loc.get("travelMinutes") or (loc.get("transitPlan") or {}).get("totalDurationMinutes")
    return int(v) if isinstance(v, (int, float)) and 0 < v < 600 else 0


def compute(tasks: list, events: list, a: str, b: str) -> dict:
    """Every metric for one period [a, b] (YYYY-MM-DD, inclusive)."""
    done = [t for t in tasks if t.get("status") == "complete" and _in(t.get("date"), a, b)]
    missed = [t for t in tasks if t.get("status") == "missed" and _in(t.get("date"), a, b)]
    ev = [e for e in events if _in(e.get("day"), a, b)]

    workouts = [t for t in done if is_workout(t)]
    study_tasks = [t for t in done if is_study(t)]
    study_ids = {str(t.get("id")) for t in study_tasks}
    # A focus session on a study task is the real time; the task's planned
    # length is the fallback. Never both for the same task.
    sessions = [e for e in ev if e.get("kind") == "study"]
    session_ids = {str(e.get("taskId")) for e in sessions if e.get("taskId")}
    learning = sum(int(e.get("minutes") or 0) for e in sessions) + sum(
        _minutes(t) for t in study_tasks if str(t.get("id")) not in session_ids)

    trips = {str(e.get("taskId")): int(e.get("minutes") or 0)
             for e in ev if e.get("kind") == "trip" and e.get("minutes")}
    planned = {str(t.get("id")): _travel(t) for t in done if _travel(t)}
    road = sum(trips.values()) + sum(m for tid, m in planned.items() if tid not in trips)

    moves = [e for e in ev if e.get("kind") == "moved"]
    per_task: dict[str, dict] = {}
    for e in moves:
        k = str(e.get("taskId") or e.get("text") or "?")
        row = per_task.setdefault(k, {"taskId": e.get("taskId"), "text": e.get("text"), "moves": 0})
        row["moves"] += 1
    total = len(done) + len(missed)
    return {
        "from": a, "to": b,
        "workouts": len(workouts),
        "workout_days": sorted({str(t.get("date"))[:10] for t in workouts}),
        "learning_minutes": learning,
        "road_minutes": road,
        "road_estimated": bool(set(planned) - set(trips)),
        "reschedules": len(moves),
        "most_moved": sorted(per_task.values(), key=lambda r: -r["moves"])[:3],
        "completed": len(done),
        "missed": len(missed),
        "completion_rate": round(len(done) / total, 2) if total else None,
        "study_task_ids": sorted(study_ids),
    }


def week_report(tasks: list, events: list, today: date, expr: str = "this week") -> dict:
    p = period(expr, today)
    cur = compute(tasks, events, p["from"], p["to"])
    prev = compute(tasks, events, p["prev_from"], p["prev_to"])
    return {"period": p, "current": cur, "previous": prev}


# ─── which metric a question is about ───────────────────────────────────────

_METRIC_WORDS = {
    "workouts": _WORKOUT_WORDS + ("התאמנתי", "התעמלתי", "worked out", "work out", "exercise"),
    "learning_minutes": _STUDY_WORDS + ("למדתי", "learn", "learned", "studied"),
    "road_minutes": ("כביש", "בדרכים", "נסעתי", "drove", "נסיעה", "נסיעות", "בדרך", "תחבורה", "פקקים",
                     "road", "roads", "commute", "travel", "driving", "on the way"),
    "reschedules": ("דחיתי", "דחייה", "הזזתי", "נדחה", "תזמנתי מחדש", "הזזה",
                    "reschedule", "rescheduled", "postpone", "postponed", "moved"),
    "completed": ("השלמתי", "סיימתי", "ביצעתי", "completed", "finished", "got done", "done"),
}


def metric_for(question: str) -> Optional[str]:
    """The metric a question names, or None (then it is an open question → RAG)."""
    for metric, words in _METRIC_WORDS.items():
        if _has_word(question, words):
            return metric
    return None


_PAST_Q = re.compile(
    r"(כמה\s+(פעמים|זמן|שעות|דקות|ימים)|כמה\s+\S+\s+(השבוע|החודש)|"
    r"\bhow\s+(many|much|long|often)\b)", re.I)
_PAST_VERB = re.compile(
    r"(התאמנתי|התעמלתי|למדתי|נסעתי|דחיתי|הזזתי|סיימתי|השלמתי|ביליתי|הייתי|עשיתי|"
    r"\b(did\s+i|have\s+i|i\s+(spent|worked|studied|did|went|moved|rescheduled))\b)", re.I)


def is_history_question(message: str) -> bool:
    """'How many times did I work out this week?' — a count of HER past.
    Needs both a how-much word and a past-tense first-person verb, so
    'how long is the drive to Haifa?' (future, a route) is not one."""
    m = str(message or "")
    return bool(_PAST_Q.search(m) and _PAST_VERB.search(m))


# ─── saying it ──────────────────────────────────────────────────────────────

_PERIOD_HE = {"this_week": "השבוע", "this_week_default": "השבוע", "last_week": "בשבוע שעבר",
              "this_month": "החודש", "last_month": "בחודש שעבר", "today": "היום"}
_PERIOD_EN = {"this_week": "this week", "this_week_default": "this week", "last_week": "last week",
              "this_month": "this month", "last_month": "last month", "today": "today"}


def period_words(label: str, he: bool) -> str:
    m = re.match(r"last_(\d+)_days", label)
    if m:
        return f"ב-{m.group(1)} הימים האחרונים" if he else f"in the last {m.group(1)} days"
    return (_PERIOD_HE if he else _PERIOD_EN).get(label, "השבוע" if he else "this week")


def _hm(minutes: int, he: bool) -> str:
    h, m = divmod(int(minutes), 60)
    if he:
        return f"{h} ש׳ {m} דק׳" if h and m else (f"{h} ש׳" if h else f"{m} דק׳")
    return f"{h}h {m}m" if h and m else (f"{h}h" if h else f"{m} min")


def say(metric: str, report: dict, he: bool, target: Optional[int] = None) -> str:
    """One or two short lines: the number, the comparison, and — if there is a
    target — the gap. Firm, never a speech."""
    cur, prev = report["current"], report["previous"]
    when = period_words(report["period"]["label"], he)
    v, pv = cur.get(metric) or 0, prev.get(metric) or 0
    if metric == "workouts":
        line = f"{when}: {v} אימונים" if he else f"{when.capitalize()}: {v} workouts"
    elif metric == "learning_minutes":
        line = f"{when}: {_hm(v, he)} למידה" if he else f"{when.capitalize()}: {_hm(v, False)} of learning"
    elif metric == "road_minutes":
        approx = "~" if cur.get("road_estimated") else ""
        line = f"{when}: {approx}{_hm(v, he)} בדרכים" if he else f"{when.capitalize()}: {approx}{_hm(v, False)} on the road"
    elif metric == "reschedules":
        line = f"{when}: דחית {v} פעמים" if he else f"{when.capitalize()}: {v} reschedules"
        top = (cur.get("most_moved") or [None])[0]
        if top and top["moves"] >= 2:
            line += (f" ('{top['text']}' {top['moves']}×)" if top.get("text") else "")
    else:
        line = f"{when}: השלמת {v} משימות" if he else f"{when.capitalize()}: {v} tasks done"

    if metric in ("learning_minutes", "road_minutes"):
        cmp_ = (f" (לפני כן: {_hm(pv, he)})" if he else f" (before: {_hm(pv, False)})")
    else:
        cmp_ = f" (לפני כן: {pv})" if he else f" (before: {pv})"
    line += cmp_

    if target:
        gap = target - v
        if metric == "learning_minutes":
            if gap > 0:
                line += (f"\nחסרות {_hm(gap, he)} ליעד. מתי משבצים?" if he
                         else f"\n{_hm(gap, False)} short of your goal. When do we book it?")
            else:
                line += "\nיעד הושג 💪" if he else "\nGoal hit 💪"
        elif gap > 0:
            line += (f"\nעוד {gap} ליעד של {target}. מתי משבצים?" if he
                     else f"\n{gap} to go for your goal of {target}. When do we book it?")
        else:
            line += "\nיעד הושג 💪" if he else "\nGoal hit 💪"
    return line


def coach_line(report: dict, targets: dict, he: bool) -> Optional[str]:
    """The ONE push for this week: the biggest gap to a target, or a slide
    against last week. None when there is nothing worth pushing."""
    cur, prev = report["current"], report["previous"]
    gaps = []
    for metric, target in (targets or {}).items():
        if metric in ("workouts", "learning_minutes") and target:
            done = cur.get(metric) or 0
            if done < target:
                gaps.append((1 - done / target, metric, target, done))
    if gaps:
        _, metric, target, done = max(gaps)
        if metric == "workouts":
            return (f"אימונים: {done}/{target} השבוע. משבצים את הבא עכשיו?" if he
                    else f"Workouts: {done}/{target} this week. Book the next one now?")
        return (f"למידה: {_hm(done, he)} מתוך {_hm(target, he)}. משבצים בלוק?" if he
                else f"Learning: {_hm(done, False)} of {_hm(target, False)}. Book a block?")
    top = (cur.get("most_moved") or [None])[0]
    if top and top["moves"] >= 3:
        return (f"'{top['text']}' נדחה {top['moves']} פעמים. עכשיו, בקטן, או מוותרים?" if he
                else f"'{top['text']}' moved {top['moves']} times. Now, smaller, or drop it?")
    if (prev.get("completed") or 0) >= 3 and (cur.get("completed") or 0) < prev["completed"] / 2:
        return (f"השלמת {cur['completed']} מול {prev['completed']} בשבוע שעבר. מה הדבר האחד להיום?" if he
                else f"{cur['completed']} done vs {prev['completed']} last week. What's the one thing today?")
    return None


def streak_line(text: str, moves: int, he: bool) -> str:
    """Said the moment a task is moved the 3rd time."""
    return (f"'{text}' נדחה {moves} פעמים. עכשיו, בקטן, או מוותרים?" if he
            else f"'{text}' moved {moves} times. Now, smaller, or drop it?")
