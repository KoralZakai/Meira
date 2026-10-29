"""The profile store, keyed by the user's WhatsApp phone.

Holds the parameters Lumi needs to compute wake/leave times (home address,
transport, morning routine) plus the routines and constraints a calendar never
shows.

The JSON file is still the authoritative write — it is what every reader here
uses today — but every update is now ALSO shadowed into Postgres
(lumi_profiles, migration 0007) through database_service. That shadow is the
migration: once the table has the rows and the readers move, the file becomes
the offline mirror instead of the only copy. It matters more than it sounds —
user_profiles held zero rows for months, and an empty homeAddress is why routes
silently stopped being computed at all.

Dependencies: config (DATA_DIR). Consumed by lumi_agent (save_profile tool,
plan_departure origin/transport defaults, onboarding prompt) and main.py
(shared-location updates via currentAddress/currentLat/currentLng).
"""
import json
import logging
import os
import re
from typing import Iterable, Optional, Union

import config
import database_service
import identity_keys
import secure_store

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "profiles.json")

_DEFAULTS = {
    "name": "there",
    "language": "en",
    "homeAddress": "",
    "transportType": "car",
    "morningRoutineMinutes": 45,
    "wakeBufferMinutes": 10,
    "hobbies": "",
    # Constraints and habits in her own words — "kids 16:00 every day", "gym
    # Mon/Wed 18:00". The app has collected these since onboarding; the server
    # had nowhere to put them, so WhatsApp planned as if the week were empty
    # around the tasks it could see.
    "routinesNotes": "",
    "mbtiType": "",
    "onboarded": False,
    "routineVerified": False,
    "currentAddress": "",
    "currentLat": None,
    "currentLng": None,
    "currentAt": None,     # a shared pin expires (privacy.CURRENT_TTL_S)
}

# Values that are never a real answer. A model filling save_profile(...) from
# a half-formed thought has written all of these into a field at some point;
# the live store still holds name="save_profile" for one user, which is worse
# than an empty field because missing_fields() then considers the name KNOWN
# and Lumi never asks again. Rejected on write, and treated as missing on read
# so an already-poisoned profile repairs itself the next time she says her name.
_JUNK_VALUES = {
    "save_profile", "infer_task_details", "update_task", "none", "null",
    "n/a", "na", "unknown", "undefined", "string", "true", "false",
}


def _is_junk(key: str, value) -> bool:
    """True when `value` is a model artefact rather than something the user said."""
    if not isinstance(value, str):
        return False
    probe = value.strip().lower()
    # A field whose value is its own name ("name": "name") is the same artefact.
    return probe in _JUNK_VALUES or probe == key.strip().lower()


# Fields we want collected during onboarding, with friendly labels.
ONBOARDING_FIELDS = {
    "name": "your name",
    "homeAddress": "your home address",
    "transportType": "how you get around (car/bus/walk/bike)",
    "morningRoutineMinutes": "how long your morning routine takes",
    "hobbies": "a few hobbies / things you love",
}


def missing_fields(phone: str) -> list:
    """Which onboarding fields are still empty/default for this user."""
    prof = get_profile(phone)
    missing = []
    for key, label in ONBOARDING_FIELDS.items():
        val = prof.get(key)
        if _is_junk(key, val):
            missing.append(label)
        elif key == "name" and val in ("", "there", None):
            missing.append(label)
        elif not val:
            missing.append(label)
    return missing


def _load() -> dict:
    """Read the store, decrypting when LUMI_DATA_KEY is set.

    Sensitive: home address, name, phone. Encryption at rest lives in secure_store;
    a DecryptionError propagates rather than silently emptying the store."""
    return secure_store.read_json(_PATH, {})


def _save(data) -> None:
    """Write the store, encrypted when LUMI_DATA_KEY is set.

    Atomic (temp file + os.replace) — a crash mid-write can no longer
    truncate the file into something that reads back as empty."""
    secure_store.write_json(_PATH, data)


# ── One person, one profile (6.10) ────────────────────────────────────────────
# identity_keys explains why a person could sit under three keys. A profile is
# READ as the union of every record she has and WRITTEN under the brain key;
# the first write marks the older records as merged, so a stale value there can
# never come back over one she has since changed.

_MERGED_INTO = "_mergedInto"


def _unset(field: str, value) -> bool:
    """Nothing she said: empty, or only the default this module fills in."""
    return value in (None, "", [], {}) or (field in _DEFAULTS and value == _DEFAULTS[field])


def _union(data: dict, key: str) -> tuple[str, dict]:
    """(brain key, her profile across every record she has been stored under).

    The brain record's value wins unless it is unset and an older record holds
    something she actually said ("bus" over the default "car"). Routines are
    joined line by line rather than picked, so nothing she told Meira on either
    channel is dropped.
    """
    keys = identity_keys.keys_of(key) or [str(key)]
    brain = keys[0]
    prof: dict = {}
    routines = ""
    for k in keys:
        rec = data.get(k)
        if not isinstance(rec, dict) or (k != brain and rec.get(_MERGED_INTO)):
            continue
        for field, value in rec.items():
            if field in ("routinesNotes", _MERGED_INTO):
                continue
            if field not in prof or (_unset(field, prof[field]) and not _unset(field, value)):
                prof[field] = value
        routines = merge_routine_lines(routines, str(rec.get("routinesNotes") or ""))
    prof["routinesNotes"] = routines
    return brain, {**_DEFAULTS, **prof}


def get_profile(phone: str) -> dict:
    """Profile for any of her keys with _DEFAULTS filled in — never returns None.
    A WhatsApp-shared pin older than 30 minutes reads as unknown (privacy)."""
    import privacy
    return privacy.without_stale_current(_union(_load(), phone)[1])


def update_profile(phone: str, *, replace_routines: bool = False, **fields) -> dict:
    """Merge non-None fields into the stored profile and return the result.
    None values are skipped so callers can pass every kwarg unconditionally.
    Junk values (tool names, "null", the field's own name) are skipped too —
    they used to overwrite good data and then look like a completed field.

    routinesNotes is ADDED TO, never replaced (merge_routine_lines): the agent
    used to resend only the newest routine and wipe the rest, and so did the
    voice check-in. `replace_routines=True` is for the explicit line edits
    below, which have already worked out the whole text."""
    data = _load()
    brain, prof = _union(data, phone)
    for k, v in fields.items():
        if v is None:
            continue
        if _is_junk(k, v):
            logger.warning("profile %s: refusing junk value for %s: %r", brain[-4:], k, v)
            continue
        if k == "routinesNotes" and not replace_routines:
            v = merge_routine_lines(prof.get("routinesNotes") or "", str(v))
        prof[k] = v
    data[brain] = prof
    for alias in identity_keys.aliases_of(brain):
        rec = data.get(alias)
        if isinstance(rec, dict) and not rec.get(_MERGED_INTO):
            rec[_MERGED_INTO] = brain
    _save(data)
    # Shadow into Postgres. Never awaited: the file write above is what this
    # function promises, and a slow database must not make saving a profile slow.
    database_service.shadow_write(
        database_service.update_profile(brain, {k: prof.get(k) for k in
                                                database_service.PROFILE_FIELDS}))
    return prof


# ── Routines, line by line ────────────────────────────────────────────────────
# Her routines are one text field in her own words, one routine per line (or
# per comma). Every writer goes through these, so a new line is appended, a
# line that says more ("…ימי ג׳") replaces the one it extends, and a line is
# only ever removed when someone asks for exactly that.

_LINE_SPLIT = re.compile(r"[\n•;]+")
_TIME = re.compile(r"\d{1,2}:\d{2}")


def routine_lines(text: Optional[str]) -> list:
    """The routine text as lines, trimmed, empties dropped."""
    out = []
    for line in _LINE_SPLIT.split(str(text or "")):
        line = line.strip(" \t-–—·,")
        if line:
            out.append(line)
    return out


def _norm(text: str) -> str:
    """Comparable form: lower case, 20.30 → 20:30, punctuation → spaces."""
    s = re.sub(r"(\d)\.(\d{2})", r"\1:\2", str(text or "").lower())
    s = re.sub(r"[^\w:]+", " ", s)
    return " ".join(s.split())


def _overlap(old: str, new: str) -> str:
    """'same' when `new` is already in `old`, 'wider' when `new` extends `old`, else ''.

    Whole words only ("גן" is not inside "גנים"). Extending a short fragment
    needs more than a shared word: either 8+ characters of it, or the same
    hour in both — so "קפה" in a morning list is not swallowed by "קפה עם דנה".
    """
    o, n = _norm(old), _norm(new)
    if not o or not n:
        return ""
    if o == n or f" {n} " in f" {o} ":
        return "same"
    if f" {o} " in f" {n} " and (len(o) >= 8 or set(_TIME.findall(o)) & set(_TIME.findall(n))):
        return "wider"
    return ""


def expand_spoken(text: Optional[str]) -> str:
    """A routine said as a sentence becomes one clear line per day-clause (routine_text):
    'יש לי יוגה ביום שלישי ב 8 בערב שעה וחצי ובשישי בבוקר 11 עד 12 וחצי' →
    'יוגה · יום שלישי · 20:00-21:30' and 'יוגה · יום שישי · 11:00-12:30'.
    A line with a clock already in it, or that names no activity, is left exactly as she wrote it."""
    out = []
    for line in str(text or "").splitlines() or [""]:
        clock = re.search(r"\d{1,2}:\d{2}", line)
        if clock or not line.strip():
            out.append(line)
            continue
        try:
            import routine_text
            lines = routine_text.canonical_lines(line)
        except Exception:  # noqa: BLE001 — never lose her words to a parser
            lines = []
        # Only when the reading found an hour: a bare "יוגה בשלישי" stays as she said it.
        out.extend(lines if lines and any(re.search(r"\d{2}:\d{2}", l) for l in lines) else [line])
    return "\n".join(out)


def merge_routine_lines(old: Optional[str], new: Optional[str]) -> str:
    """Add the lines of `new` to `old`: skip what is there, widen what it extends.

    Her text comes back exactly as she wrote it when nothing changes; only an
    addition rewrites it, one routine per line."""
    new = expand_spoken(new)
    if not str(old or "").strip():
        return str(new or "").strip()
    import routine_match   # here: it imports known_places, which reaches back to this module

    lines = routine_lines(old)
    before = list(lines)
    for item in routine_lines(new):
        if any(_overlap(line, item) == "same" or any(_overlap(seg, item) == "same" for seg in line.split(","))
               for line in lines):
            continue                     # already there, exactly as she wrote it
        if routine_match._when(item).get("time"):
            # The same routine said again in other words REPLACES every older
            # telling of it, glued-together lines included (11.10: one workout
            # was twelve lines and five cards). What else a line held stays,
            # on a line of its own. Before the text widening below: that is
            # what glued a new routine onto the tail of an old line.
            out, put = [], False
            for line in lines:
                rest = routine_match.restate(line, item)
                if rest is None:
                    out.append(line)
                    continue
                if not put:
                    out.append(item)
                    put = True
                if rest:
                    out.append(rest)
            if put:
                lines = out
                continue
        placed = False
        for i, line in enumerate(lines):
            verdict = _overlap(line, item)
            if verdict:
                if verdict == "wider":
                    lines[i] = item
                placed = True
                break
            segs = line.split(",")
            for j, seg in enumerate(segs):
                verdict = _overlap(seg, item)
                if verdict == "wider":
                    segs[j] = (" " if j else "") + item
                    lines[i] = ",".join(segs).strip()
                if verdict:
                    placed = True
                    break
            if placed:
                break
        if not placed:
            lines.append(item)
    for item in routine_lines(new):
        if item in lines:
            lines = _vacate_slot(lines, item)
            lines = [_with_inherited_place(l, before) if l == item else l for l in lines]
    return str(old).strip() if lines == before else "\n".join(lines)


_SLOT_TOLERANCE_MIN = 30


def _mins(hhmm: str) -> int:
    """Minutes since midnight; 10**6 for anything unreadable, so it never reads as "the same hour"."""
    try:
        h, m = str(hhmm).split(":")
        return int(h) * 60 + int(m)
    except (ValueError, TypeError):
        return 10 ** 6


def _vacate_slot(lines: list, item: str) -> list:
    """What she says NOW owns its slot: an older routine on the same day at about the same hour
    loses that day (21.10, Koral: "routines don't update" — she replaced Tuesday's 20:00 workout
    with yoga, and the old line still said Tuesday 20:00).

    Only structured lines ("what · days · time · place") are rewritten, and only their days part;
    a line that is not in that shape is her own words and is never touched. A line left with no
    days is dropped."""
    import routine_match as rm

    new_days, new_when = rm.read_days(item), rm._when(item)
    if new_days["from"] != "said" or not new_days["days"] or not new_when.get("time"):
        return lines
    mine, start = set(new_days["days"]), _mins(new_when["time"])
    out = []
    for line in lines:
        parts = [p.strip() for p in line.split(" · ")]
        old_days, old_when = rm.read_days(line), rm._when(line)
        if (line == item or len(parts) < 3 or old_days["from"] != "said" or not old_days["days"]
                or not old_when.get("time") or not (set(old_days["days"]) & mine)
                or abs(_mins(old_when["time"]) - start) > _SLOT_TOLERANCE_MIN):
            out.append(line)
            continue
        left = sorted(set(old_days["days"]) - mine)
        if not left:
            continue                                   # the whole routine was that slot: replaced
        holder = next((i for i, p in enumerate(parts)
                       if rm.read_days(p)["days"] and not rm._RANGE.search(p) and not rm._CLOCK.search(p)), None)
        if holder is None:
            out.append(line)                           # cannot tell which part is the days: leave her words
            continue
        script = "he" if re.search(r"[֐-׿]", line) else "en"
        parts[holder] = rm.days_phrase(left, script).lstrip("· ").strip()
        out.append(" · ".join(parts))
    return out


def _same_slot(a: str, b: str) -> bool:
    """Do these two routine lines share a weekday at about the same hour?"""
    import routine_match as rm
    da, db, wa, wb = rm.read_days(a), rm.read_days(b), rm._when(a), rm._when(b)
    if da["from"] != "said" or db["from"] != "said" or not wa.get("time") or not wb.get("time"):
        return False
    return bool(set(da["days"]) & set(db["days"])) and abs(_mins(wa["time"]) - _mins(wb["time"])) <= _SLOT_TOLERANCE_MIN


def _with_inherited_place(item: str, before: list) -> str:
    """"Same place, same way" (21.10, Koral: replacing the workout with yoga should keep where it is):
    a routine said without a place takes the place of the one it replaced in that slot."""
    import routine_match as rm
    if rm.address_in(item):
        return item
    for old in before:
        if old != item and _same_slot(old, item):
            where = rm.address_in(old)
            if where:
                return f"{item} · {where}"
    return item


def _fragments(value: Union[str, Iterable[str], None]) -> list:
    if value is None:
        return []
    items = routine_lines(value) if isinstance(value, str) else [str(v) for v in value]
    return [f for f in (_norm(i) for i in items) if len(f) >= 3]


def remove_routine_lines(phone: str, fragments: Union[str, Iterable[str], None]) -> list:
    """Drop every routine (line or comma part) containing one of `fragments`.
    -> the parts removed, in her words. Nothing matched → [] and nothing written."""
    wanted = _fragments(fragments)
    if not wanted:
        return []
    kept, removed = [], []
    for line in routine_lines(get_profile(phone).get("routinesNotes")):
        # A routine is a whole LINE ("אימון · יום ראשון, שני ושלישי · 20:00 · …, תל אביב" has commas
        # inside it). The app sends the line as it reads; cut at its commas it matched no piece, so
        # "removed" came back [] and the routine stayed (21.10, Koral: "I can't delete a routine").
        if _norm(line) in wanted:
            removed.append(line.strip())
            continue
        segs = []
        for seg in line.split(","):
            hay = f" {_norm(seg)} "
            if any(f" {w} " in hay for w in wanted):
                removed.append(seg.strip())
            else:
                segs.append(seg)
        text = ",".join(segs).strip(" ,")
        if text:
            kept.append(text)
    if removed:
        update_profile(phone, routinesNotes="\n".join(kept), replace_routines=True)
    return removed


def replace_routine_line(phone: str, old: str, new: str) -> bool:
    """Swap the routine that reads `old` for `new` (an answer that adds its days).
    False when no line reads `old` any more — the caller says so, never guesses."""
    target, new = _norm(old), str(new or "").strip()
    if not target or not new:
        return False
    lines = routine_lines(get_profile(phone).get("routinesNotes"))
    for exact in (True, False):
        for i, line in enumerate(lines):
            segs = line.split(",")
            for j, seg in enumerate(segs):
                hay = _norm(seg)
                if hay == target or (not exact and f" {target} " in f" {hay} "):
                    segs[j] = (" " if j else "") + new
                    lines[i] = ",".join(segs).strip()
                    update_profile(phone, routinesNotes="\n".join(lines), replace_routines=True)
                    return True
    return False


def has_home(phone: str) -> bool:
    """True if this user has a saved home address (route planning can start)."""
    return bool(get_profile(phone).get("homeAddress"))
