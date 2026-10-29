"""Where "yoga class" actually IS — learned once, reused forever.

Koral's ask, in her words:

    enough for me to write once "yoga class" / "אימון בחדר כושר" in יגאל אלון 94
    next time "yoga class on 11:00" automatically location known and bike

travel_prefs already learns HOW she travels, but only once an address is in the
message. Without one there is nothing to route to, so "yoga class at 11:00"
still produces a task with no place, no route and no alarm. This is the other
half: the activity NAME resolves to the address she gave it last time.

The hard part is that the same place arrives under different words, and across
two languages — "yoga class", "אימון בחדר כושר", "יוגה בערב" are one gym. Her
brief calls for embeddings ("yoga class" ≈ "training" ≈ "workout"), but
EMBED_MODEL is unset in production and every embedding call returns None, so
matching here is lexical and bilingual instead:

  1. a CONCEPT lexicon maps both languages onto one key — this is what lets
     "yoga class" find what "אימון בחדר כושר" saved;
  2. failing that, token overlap catches same-language variants
     ("yoga class" / "evening yoga").

Structured so an embedding pass can slot in as step 3 later without moving
anything: resolve() already returns the best candidate above a threshold.

Dependencies: config (DATA_DIR). Written by main when a task carries both a
name and a resolved address; read there before deciding a task has no place.
"""
import json
import logging
import os
import re
from typing import Optional

import config
import database_service
import secure_store

logger = logging.getLogger(__name__)
_PATH = os.path.join(config.DATA_DIR, "known_places.json")

# One key per real-world activity, listed in both languages. Deliberately small
# and hand-written: these are the things she actually does, and a wrong merge
# here sends her to the wrong address, so breadth is not worth the risk.
# One key per real-world activity, listed in both languages. Deliberately small
# and hand-written: these are the things she actually does, and a wrong merge
# here sends her to the wrong address, so breadth is not worth the risk.
#
# gym/yoga/workout/training are ONE key on purpose. Her brief says so directly
# — "'yoga class' and 'training' 'workout' on the same time and location
# probably mean the same" — and in her data they are all יגאל אלון 94. The more
# general form of this is to infer the link from a shared address rather than
# declare it, which is the right thing to build once there is enough history;
# until then, declaring what she has already told us beats asking her again.
_CONCEPTS: dict = {
    # Kickboxing added 2026-09-28: "קיקבוקס" matched nothing here, so the one
    # class she does at יגאל אלון 94 every week could never find its own gym.
    "fitness": ["gym", "workout", "training", "fitness", "yoga", "pilates",
                "kickbox", "kickboxing", "boxing", "crossfit",
                "חדר כושר", "כושר", "אימון", "אימונים", "התעמלות", "יוגה",
                "פילאטיס", "קיקבוקס", "קיק בוקס", "איגרוף", "אגרוף", "קרוספיט"],
    "pool": ["pool", "swim", "swimming", "בריכה", "שחייה"],
    "work": ["work", "office", "עבודה", "משרד"],
    "doctor": ["doctor", "clinic", "dentist", "רופא", "מרפאה", "שיניים", "רופאה"],
    "therapy": ["therapy", "therapist", "psychologist", "טיפול", "פסיכולוג", "מטפלת"],
    # Generic containers. Only used when nothing specific matched — otherwise
    # "yoga class" resolves as "class" (the longer word) and a yoga session
    # lands wherever the last unrelated course was.
    "class": ["class", "course", "lecture", "שיעור", "קורס", "הרצאה", "חוג"],
}

# Concepts that describe the CONTAINER, not the activity.
_GENERIC = {"class"}

# Activities that only ever happen at their place: a workout is at the gym
# whether or not she said an hour. "work" is deliberately absent — "עבודה על
# המצגת" is not a trip to the office.
_PLACE_BOUND = {"fitness", "pool", "doctor", "therapy"}


def place_bound(text: str) -> bool:
    """Does this activity happen somewhere in particular, hour or no hour?"""
    return concept_of(text) in _PLACE_BOUND

# Words that carry no identity — dropped before token comparison so
# "שיעור יוגה בערב" and "יוגה" still line up.
_STOP = {
    "the", "a", "an", "at", "in", "on", "to", "with", "my", "for", "and",
    "evening", "morning", "afternoon", "night", "today", "tomorrow", "class",
    "של", "עם", "את", "אל", "לי", "לה", "לו", "ב", "ל", "מ", "ה", "ו",
    "בערב", "בבוקר", "בצהריים", "בלילה", "היום", "מחר", "אחהצ",
}

_TIME_RE = re.compile(r"\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}[./]\d{1,2}\b")


def _digits(phone: str) -> str:
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


def _key(phone: str) -> str:
    """Last 9 digits — same rule as supabase_tasks and travel_prefs, so a place
    learned from '0542902729' is found under '972542902729'."""
    d = _digits(phone)
    return d[-9:] if len(d) >= 9 else d


def _tokens(text: str) -> set:
    t = (text or "").lower()
    t = _TIME_RE.sub(" ", t)
    words = re.findall(r"[^\W\d_]+", t, re.UNICODE)
    return {w for w in words if len(w) > 1 and w not in _STOP}


def concept_of(text: str) -> Optional[str]:
    """The activity this text names, if it is one we know bilingually.

    Longest term first, so "חדר כושר" wins over the bare "כושר" and a
    two-word English term is not beaten by one of its halves.
    """
    t = (text or "").lower()

    def _match(names):
        best, best_len = None, 0
        for concept in names:
            for term in _CONCEPTS[concept]:
                if term in t and len(term) > best_len:
                    best, best_len = concept, len(term)
        return best

    specific = [c for c in _CONCEPTS if c not in _GENERIC]
    return _match(specific) or _match(list(_GENERIC))


def activity_key(text: str) -> str:
    """The stable key for an activity: its concept when known, else its
    meaningful words sorted (so word order never forks a place).

    A GENERIC concept is qualified by what makes it specific. "class" says only
    that something is a lesson, so "חוג קרמיקה של נועה" and "שיעור גיטרה" both
    collapsed to @class — and the ceramics studio on Shenkin then answered for
    a guitar lesson. This module's own comment warns that "a wrong merge here
    sends her to the wrong address"; that was one, and it lived in the fallback
    where nothing specific matched, which is most hobbies.

    A real activity key is still shared on purpose: gym / yoga / workout are
    one place and are meant to be.

    Found 2026-09-17 by tests/run-known-places.ts while porting this to the
    phone. Changing the key means entries already stored under a bare @class
    stop resolving — they degrade to asking once more, which is the right
    direction to fail in.
    """
    concept = concept_of(text)
    if concept:
        if concept not in _GENERIC:
            return f"@{concept}"
        # Everything the container word does not already say.
        own = {w for term in _CONCEPTS[concept] for w in _tokens(term)}
        rest = sorted(_tokens(text) - own)
        return f"@{concept}:{' '.join(rest)}"[:60] if rest else f"@{concept}"
    toks = sorted(_tokens(text))
    return " ".join(toks)[:60]


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: home/work/gym addresses. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


def remember(phone: str, activity: str, address: str,
             lat: Optional[float] = None, lng: Optional[float] = None,
             name: Optional[str] = None) -> None:
    """Record that this activity happens at this address.

    `name` is what she calls the place ("Space Gym") — shown on the card, never
    geocoded. Kept until a new one is given."""
    key = _key(phone)
    akey = activity_key(activity)
    if not key or not akey or not address:
        return
    data = _load()
    mine = data.setdefault(key, {})
    entry = mine.setdefault(akey, {"address": address, "lat": lat, "lng": lng,
                                   "count": 0, "words": []})
    # A later address wins — she moved gyms, or gave a better one. The count
    # still rises, because it is confidence in the ACTIVITY, not the string.
    entry["address"] = address
    if name:
        entry["name"] = name
    if lat is not None:
        entry["lat"] = lat
    if lng is not None:
        entry["lng"] = lng
    entry["count"] = int(entry.get("count", 0)) + 1
    # Remember her actual wording too, so an unknown-concept activity can still
    # be matched by overlap next time.
    words = set(entry.get("words") or []) | _tokens(activity)
    entry["words"] = sorted(words)[:24]
    _save(data)
    database_service.shadow_write(
        database_service.remember_place(key, akey, address, lat, lng,
                                        uses=entry["count"]))


def _overlap(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def resolve(phone: str, activity: str, threshold: float = 0.6) -> Optional[dict]:
    """The address this activity happens at, or None to ask.

    Concept match first (it crosses languages), then word overlap for
    same-language variants. Returns {address, lat, lng, key}.
    """
    key = _key(phone)
    if not key:
        return None
    mine = _load().get(key) or {}
    if not mine:
        return None

    akey = activity_key(activity)
    hit = mine.get(akey)
    if hit and hit.get("address"):
        return {"address": hit["address"], "lat": hit.get("lat"),
                "lng": hit.get("lng"), "key": akey, "name": hit.get("name")}

    # No exact key. Compare her words against what each place has been called.
    toks = _tokens(activity)
    best, best_score = None, 0.0
    for stored_key, entry in mine.items():
        if not entry.get("address"):
            continue
        score = _overlap(toks, set(entry.get("words") or []))
        if score > best_score:
            best, best_score = (stored_key, entry), score
    if best and best_score >= threshold:
        stored_key, entry = best
        return {"address": entry["address"], "lat": entry.get("lat"),
                "lng": entry.get("lng"), "key": stored_key, "name": entry.get("name")}
    return None


def recall_line(address: str, lang: str) -> str:
    """Said out loud whenever a place came from memory rather than the message —
    the same rule travel_prefs follows. A silent recall is a guess."""
    return (f"📍 מניחה {address} כמו בפעם הקודמת — תגידי אם לא."
            if lang == "he" else
            f"📍 Assuming {address}, like last time — tell me if not.")


def forget(phone: str, activity: str) -> bool:
    """Drop one remembered place ("עבודה" when she says she no longer works
    there, 9.10). True when something was removed. The cloud row is left for
    the next remember() of that activity to overwrite: reads come from here."""
    key, akey = _key(phone), activity_key(activity)
    data = _load()
    mine = data.get(key) or {}
    if not akey or akey not in mine:
        return False
    del mine[akey]
    _save(data)
    return True
