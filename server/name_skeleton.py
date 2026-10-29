"""name_skeleton — "סגית" and "Sagit" are one person.

Twin of src/utils/nameSkeleton.ts; parity pinned by tests/fixtures/same-name.json
(tests/run-same-name.ts + server/tests/test_same_name.py).

1.10: "שיחה עם סגית" (typed by her) and "Sagit/Koral- intro" (from Google) sat
side by side at 20:30 — one call, two cards, and Meira counted two — because the
only test for "the same meeting" was the same WORDS. A name crosses scripts;
its consonants survive the trip. Only ever asked about two things on the same
day at the same minute, and blind to the words every meeting shares.
"""
from __future__ import annotations

import re

_HE = {
    "א": "", "ב": "b", "ג": "g", "ד": "d", "ה": "", "ו": "", "ז": "z", "ח": "K",
    "ט": "t", "י": "", "כ": "K", "ך": "K", "ל": "l", "מ": "m", "ם": "m", "נ": "n",
    "ן": "n", "ס": "s", "ע": "", "פ": "p", "ף": "p", "צ": "ts", "ץ": "ts", "ק": "K",
    "ר": "r", "ש": "S", "ת": "t",
}
_HE_PREFIX = set("בהוכלמש")
_LATIN_PAIRS = [(re.compile("sh"), "S"), (re.compile("ch|kh|ck"), "K"), (re.compile("tz"), "ts"),
                (re.compile("th"), "t"), (re.compile("ph"), "p")]
_LATIN = {"c": "K", "k": "K", "q": "K", "f": "p", "v": "b", "w": "b", "x": "Ks",
          "a": "", "e": "", "i": "", "o": "", "u": "", "y": ""}
_HEBREW = re.compile(r"[א-ת]")


def _latin(word: str) -> str:
    w = word.lower()
    initial_h = "h" if w.startswith("h") and not w.startswith("sh") else ""
    for rx, to in _LATIN_PAIRS:
        w = rx.sub(to, w)
    body = "".join("" if ch == "h" else _LATIN.get(ch, ch) for ch in w)
    return initial_h + re.sub(r"^h", "", body)


def _hebrew(word: str) -> str:
    return ("h" if word.startswith("ה") else "") + "".join(_HE.get(ch, "") for ch in word)


def skeletons_of(word: str) -> list:
    if _HEBREW.search(word):
        out = [_hebrew(word)]
        if len(word) >= 4 and word[0] in _HE_PREFIX:
            out.append(_hebrew(word[1:]))
        return out
    return [_latin(word)]


_COMMON = [
    "meeting", "meet", "call", "intro", "sync", "zoom", "teams", "chat", "interview", "lunch",
    "coffee", "with", "and", "the", "for", "catch", "up", "online", "video", "phone", "review",
    "שיחה", "שיחת", "עם", "פגישה", "פגישת", "זום", "ראיון", "קפה", "צהריים", "טלפון", "וידאו",
    "אונליין", "סינק", "היכרות", "של", "את",
]
_COMMON_SKELETONS = {sk for w in _COMMON for sk in skeletons_of(w)}


def _name_skeletons(text) -> set:
    out = set()
    for word in re.findall(r"[^\W\d_]+", str(text or "")):
        if len(word) < 2:
            continue
        proper = bool(re.match(r"[A-Z]", word)) or bool(_HEBREW.search(word))
        if not proper and len(word) < 3:
            continue
        for sk in skeletons_of(word):
            if sk in _COMMON_SKELETONS:
                continue
            if len(sk) >= 3 or (proper and len(sk) == 2):
                out.add(sk)
    return out


def shares_a_name(a, b) -> bool:
    """Do two titles name the same person or thing, across Hebrew and English?"""
    left = _name_skeletons(a)
    return bool(left) and bool(left & _name_skeletons(b))
