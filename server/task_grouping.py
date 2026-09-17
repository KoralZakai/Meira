"""task_grouping — one message, one subject.

A message like

    משימות למחר- להכין lean canvas model
    לפתוח ללומי חשבון gmail
    להכין אתר - דף נחיתה
    לשנות את העיצוב: אייקונים, liquid glass, font heebo
    icons for סינון drop down
    i frame - show the map on the app

is not eight unrelated errands. It is one body of work, written down in one
breath, and it arrived as eight flat rows with nothing tying them together —
so the tasks screen showed eight separate notes and Lumi had no idea they were
the same project.

This gives the batch a shared `subgroup` label, which is exactly what the app
already groups its task board by (MyTasks.groupBySubject). Nothing is renamed,
nothing is nested, nothing is deleted: one extra field, and the batch reads as
the project it is.

Deliberately conservative — a label is only assigned when

  * the message produced at least MIN_TASKS tasks (a pair is not a project), and
  * either the message opened with a heading ("משימות למחר-", "Tomorrow:") or
    enough of the tasks share one recognisable theme.

When neither holds it returns None and the tasks stay exactly as they were.

Pure and dependency-free, so tests/test_task_grouping.py can drive it.
Consumed by agent_turn.persist_agent_tasks.
"""
from __future__ import annotations

import re
from typing import Optional

# Fewer than this is not a project, it is a couple of errands.
MIN_TASKS = 3
# How much of the batch must share a theme for the theme to be the label.
THEME_SHARE = 0.5

# Themes are the words people write, not category ids. Each entry is
# (label_he, label_en, pattern).
_THEMES = [
    ("עיצוב UX/UI", "UX/UI design",
     r"ux|ui|design|עיצוב|icons?|אייקונ|font|פונט|figma|dribbble|dribble|landing|"
     r"דף נחיתה|mockup|mock ?up|wireframe|liquid glass|components?|קומפוננט"),
    ("חיפוש עבודה", "Job hunt",
     r"interview|ראיון|cv|קורות ?חיים|linkedin|לינקדאין|recruit|משרה|משרות|hiring"),
    ("לימודים", "Studies",
     r"study|לימוד|ללמוד|exam|מבחן|בחינה|homework|תרגיל|course|קורס|הרצאה|lecture"),
    ("הבית", "Home",
     r"clean|ניקיון|לנקות|laundry|כביסה|groceries|קניות|סופר|dishes|כלים|לתקן|repair"),
    ("בריאות", "Health",
     r"doctor|רופא|dentist|שיניים|clinic|מרפאה|תור ל|blood test|בדיקות דם|therap|פסיכולוג"),
    ("כסף", "Money",
     r"invoice|חשבונית|לשלם|payment|תשלום|bank|בנק|ביטוח|insurance|מס |taxes?"),
    ("טיול", "Trip",
     r"flight|טיסה|hotel|מלון|pack|לארוז|passport|דרכון|visa|ויזה|booking|להזמין כרטיס"),
]

# "משימות למחר-", "Tasks for tomorrow:", "מחר:" — a heading, not a task.
_HEADING_RE = re.compile(
    r"^\s*(?:משימות\s*(?:ל)?\w*|רשימה\s*\w*|tasks?\s*(?:for\s*\w+)?|todo|to ?do\s*list)"
    r"\s*[-–—:]\s*",
    re.IGNORECASE,
)


def heading_of(content: str) -> Optional[str]:
    """The heading a batch was written under, without its punctuation.

    Only the FIRST line counts, and only when it actually looks like a heading:
    "משימות למחר- להכין lean canvas" opens with one, "לקנות חלב" does not.
    """
    first = next((l.strip() for l in (content or "").splitlines() if l.strip()), "")
    if not first:
        return None
    match = _HEADING_RE.match(first)
    if not match:
        return None
    label = first[: match.end()].strip(" -–—:\t")
    return label or None


def theme_of(texts: list, lang: str = "he") -> Optional[str]:
    """The subject shared by most of these tasks, or None."""
    if not texts:
        return None
    best_label = None
    best_hits = 0
    for label_he, label_en, pattern in _THEMES:
        probe = re.compile(pattern, re.IGNORECASE)
        hits = sum(1 for t in texts if probe.search(str(t or "")))
        if hits > best_hits:
            best_hits, best_label = hits, (label_he if lang == "he" else label_en)
    if best_label and best_hits >= max(2, round(len(texts) * THEME_SHARE)):
        return best_label
    return None


def group_label(texts: list, content: str = "", lang: str = "he") -> Optional[str]:
    """The label to stamp on this batch, or None to leave the tasks alone.

    The theme wins over the heading when both exist: "משימות למחר" says WHEN
    they were written, "עיצוב UX/UI" says what they ARE, and only the second is
    still true the day after tomorrow.
    """
    if len(texts) < MIN_TASKS:
        return None
    return theme_of(texts, lang) or heading_of(content)


if __name__ == "__main__":  # pragma: no cover — self-check
    batch = [
        "להכין lean canvas model",
        "לפתוח ללומי חשבון gmail",
        "להכין אתר - דף נחיתה",
        "לשנות את העיצוב: אייקונים לפי icons8 ios 27, liquid glass components",
        "font - heebo hebrew / assistant",
        "icons for סינון drop down",
        "dribble - דוגמאות של ux ui",
        "i frame - show the map on the app",
    ]
    assert group_label(batch, "משימות למחר- להכין lean canvas model") == "עיצוב UX/UI", \
        group_label(batch, "")
    assert group_label(["לקנות חלב", "להתקשר לאמא"], "") is None, "a pair is not a project"
    assert heading_of("משימות למחר- להכין lean canvas") == "משימות למחר"
    assert heading_of("לקנות חלב") is None
    print("task_grouping self-check OK")
