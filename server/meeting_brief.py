"""Who am I meeting, and what should I know before I walk in.

The app reads the user's calendar on the phone with their own Google token and
posts ONE event here. This module turns that event into a short briefing: what
the company is, what the person's role is, a few facts worth knowing, and
questions worth asking — each line tied to a source it came from.

THREE RULES, in the order they matter.

1. NOTHING IS INVENTED. Every bullet cites a source index into the links we
   actually fetched. A bullet the model cannot tie to a source is dropped
   before the brief is returned, not softened. A wrong fact about a person you
   are about to meet is worse than no fact, and Lumi has invented an address
   before (see find_place).

2. IT IS SHORT. A headline of one sentence, then bullets. The user is walking
   into a meeting, not reading a dossier.

3. IT COSTS ALMOST NOTHING TO SKIP. Who to research is decided in code — the
   organiser's domain, the names in the invite — so an event about "gym" makes
   no search and no model call at all. The expensive path runs only when there
   is a real company or person to look up.

Caching: briefs are stored encrypted (secure_store) as {user_key: {event_id:
...}}, because the same meeting is opened many times and each miss costs Tavily
credits and a model call. Keyed by USER first, not by event: two people can
hold the same event id, and which meetings someone has is personal even when
every fact in the brief came off a public web page. That shape is also what
account_deletion walks, which is why this module exposes _load/_save.

A brief older than _TTL_DAYS is refetched — news goes stale.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Optional

import config
import llm_usage
import model_router
import secure_store
import tavily_search

logger = logging.getLogger(__name__)

_PATH = os.path.join(config.DATA_DIR, "meeting_briefs.json")
_TTL_DAYS = 7
_MAX_CACHE = 200
# How much of her own mailbox a brief may carry. Small on purpose: this is
# "remind me what we said", not a thread export.
_MAX_HISTORY = 4
_MAX_HISTORY_CHARS = 300

# Domains that identify nobody: the invite came through a scheduling tool, so
# the organiser address says which SaaS sent the mail, not who we are meeting.
_GENERIC_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
    "icloud.com", "walla.co.il", "lu.ma", "calendar-invite@lu.ma",
    "comeet-notifications.com", "comeet.co", "sparkhire.com", "calendly.com",
    "google.com", "zoom.us", "teams.microsoft.com", "eventbrite.com",
}

# "Interview with Jane Doe (Team Leader)" / "Discussion with Yuval Shitrit
# (Talent Acquisition Specialist)" — the shape every ATS invite uses.
_PERSON_RE = re.compile(
    r"(?:interview|discussion|call|meeting|conversation)\s+with\s+"
    r"([A-Z][\w'\-]+(?:\s+[A-Z][\w'\-]+){0,2})"
    r"(?:\s*\(([^)]{3,60})\))?",
    re.IGNORECASE)


def _domain_of(email: str) -> str:
    return (email or "").split("@")[-1].strip().lower()


def _company_from_domain(email: str) -> str:
    dom = _domain_of(email)
    if not dom or dom in _GENERIC_DOMAINS:
        return ""
    root = dom.split(".")[0]
    return root if len(root) > 2 else ""


def subjects(event: dict) -> dict:
    """Who and what to look up — decided in code, no model call.

    Returns {company, person, person_role, role_title}. Empty strings mean
    "nothing worth searching", and the caller must then skip the brief rather
    than search for the event title and dress up whatever comes back.
    """
    title = str(event.get("title") or "")
    desc = str(event.get("description") or "")
    organizer = str(event.get("organizer") or "")
    attendees = [str(a) for a in (event.get("attendees") or []) if a]

    company = _company_from_domain(organizer)
    if not company:
        for a in attendees:
            company = _company_from_domain(a)
            if company:
                break
    if not company:
        # "Scheduled Call with Directeam", "Your phone interview with Ceva"
        m = re.search(r"\bwith\s+([A-Z][\w&'\-\.]*(?:\s+[A-Z][\w&'\-\.]*){0,2})", title)
        if m:
            company = m.group(1).strip()

    person = role = ""
    m = _PERSON_RE.search(desc) or _PERSON_RE.search(title)
    if m:
        person = (m.group(1) or "").strip()
        role = (m.group(2) or "").strip()

    # The job/position line an ATS invite carries.
    role_title = ""
    rm = re.search(r"(?:position|role|job)\s*[:\-]\s*([^\n\r]{3,90})", desc, re.IGNORECASE)
    if rm:
        role_title = rm.group(1).strip()

    return {"company": company, "person": person,
            "person_role": role, "role_title": role_title}


async def _gather(subj: dict) -> list[dict]:
    """Search results for the company, its recent news, and the person."""
    company, person = subj["company"], subj["person"]
    out: list[dict] = []

    async def _add(query: str, **kw):
        res = await tavily_search.search(query, max_results=kw.pop("n", 4), **kw)
        if res.get("ok"):
            out.extend(res["results"])
        else:
            logger.info("meeting_brief: search %r unavailable (%s)", query, res.get("error"))

    if company:
        await _add(f"{company} company what they do")
        await _add(f"{company} news", topic="news", days=180, n=3)
    if person:
        who = f"{person} {company}".strip()
        # LinkedIn first — it is where a role and a history actually live.
        await _add(f"{who} LinkedIn", n=3)

    # De-duplicate by link, keep first (best-ranked) occurrence.
    seen, uniq = set(), []
    for r in out:
        link = r.get("link")
        if not link or link in seen:
            continue
        seen.add(link)
        uniq.append(r)
    return uniq[:12]


_SYSTEM = """You write a SHORT pre-meeting brief. You are given an event and \
numbered web sources.

HARD RULES
- Use ONLY the sources. If the sources do not say it, it does not go in.
- Every bullet ends with the source number(s) it came from, like [1] or [1,3].
- If sources disagree or are about a DIFFERENT organisation with a similar \
name, say so in one bullet and mark confidence "low".
- headline: ONE sentence, max 15 words.
- 2-4 company bullets, 0-2 person bullets, exactly 3 questions to ask.
- Questions must be specific to THIS company and role — never generic.
- Sources titled "Your email:" are the USER'S OWN correspondence with this person. Use them for history_* bullets: what the two of them already discussed or agreed, in the user's own context. 0-3 bullets, same citation rule. Leave history_* empty when there are no such sources — never invent a past conversation.
- Write BOTH languages: *_he in Hebrew, *_en in English. Same facts.

Return JSON only:
{"headline_he":"","headline_en":"",
 "company_he":[""],"company_en":[""],
 "person_he":[""],"person_en":[""],
 "history_he":[""],"history_en":[""],
 "questions_he":["","",""],"questions_en":["","",""],
 "confidence":"high|medium|low",
 "caution_he":"","caution_en":""}
caution_* is "" unless there is a real reason to doubt the identification."""


def _cite_ok(line: str, n_sources: int) -> bool:
    """A bullet must cite at least one source that exists."""
    nums: list[int] = []
    for group in re.findall(r"\[([\d,\s]+)\]", line):
        for part in group.split(","):
            part = part.strip()
            if part.isdigit():
                nums.append(int(part))
    return bool(nums) and all(1 <= n <= n_sources for n in nums)


async def _compose(event: dict, subj: dict, sources: list[dict]) -> Optional[dict]:
    from openai import AsyncOpenAI

    listing = "\n".join(
        f"[{i+1}] {s.get('title')} — {s.get('link')}\n{(s.get('snippet') or '')[:700]}"
        for i, s in enumerate(sources))
    facts = (
        f"EVENT: {event.get('title')}\n"
        f"WHEN: {event.get('date')} {event.get('time')}\n"
        f"WHERE: {event.get('location') or '(not given)'}\n"
        f"COMPANY: {subj['company'] or '(unknown)'}\n"
        f"PERSON: {subj['person'] or '(unknown)'} {('— ' + subj['person_role']) if subj['person_role'] else ''}\n"
        f"ROLE DISCUSSED: {subj['role_title'] or '(none)'}\n\n"
        f"SOURCES:\n{listing}"
    )
    model = model_router.pick("meeting_brief", prompt_chars=len(_SYSTEM) + len(facts))
    client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": _SYSTEM},
                      {"role": "user", "content": facts}],
            temperature=0.2,
            max_tokens=900,
            response_format={"type": "json_object"},
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001 — a failed brief is not a failed app
        logger.warning("meeting_brief compose failed: %s", exc)
        return None

    usage = getattr(resp, "usage", None)
    if usage:
        llm_usage.record("meeting_brief", usage.prompt_tokens or 0,
                         usage.completion_tokens or 0, model)
    try:
        return json.loads(resp.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        logger.warning("meeting_brief: model returned non-JSON")
        return None


def _clean(brief: dict, n_sources: int) -> dict:
    """Drop every bullet that does not cite a source we actually fetched."""
    dropped = 0
    for key in ("company_he", "company_en", "person_he", "person_en",
                "history_he", "history_en"):
        kept = []
        for line in brief.get(key) or []:
            if isinstance(line, str) and line.strip() and _cite_ok(line, n_sources):
                kept.append(line.strip())
            else:
                dropped += 1
        brief[key] = kept
    if dropped:
        logger.info("meeting_brief: dropped %d uncited bullet(s)", dropped)
        brief["confidence"] = "low" if dropped > 2 else brief.get("confidence", "medium")
    brief["dropped_bullets"] = dropped
    return brief


# ── cache ───────────────────────────────────────────────────────────────────

def _load() -> dict:
    """{user_key: {event_id: {brief, fetched_at}}} — the shape
    account_deletion.purge_local_stores expects."""
    data = secure_store.read_json(_PATH, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    secure_store.write_json(_PATH, data)


def _cache_read(user_key: str, event_id: str) -> Optional[dict]:
    if not (user_key and event_id):
        return None
    row = (_load().get(user_key) or {}).get(event_id)
    if not row:
        return None
    if time.time() - row.get("fetched_at", 0) > _TTL_DAYS * 86400:
        return None
    return row.get("brief")


def _cache_write(user_key: str, event_id: str, brief: dict) -> None:
    if not (user_key and event_id):
        return
    try:
        store = _load()
        mine = store.setdefault(user_key, {})
        mine[event_id] = {"brief": brief, "fetched_at": time.time()}
        if len(mine) > _MAX_CACHE:
            oldest = sorted(mine, key=lambda k: mine[k].get("fetched_at", 0))
            for key in oldest[:len(mine) - _MAX_CACHE]:
                mine.pop(key, None)
        _save(store)
    except Exception as exc:  # noqa: BLE001 — a cache miss is not a failure
        logger.warning("meeting_brief cache write failed: %s", exc)


# ── entry point ─────────────────────────────────────────────────────────────

def _history_sources(event: dict) -> list[dict]:
    """The user's own email with this person, as numbered sources.

    Koral, 2026-09-17: "collect data from Gmail — if they had a conversation
    there, remind what they talked about."

    This is the half of a briefing the web cannot supply. Tavily can say what
    Ceva builds; only her mailbox knows what she and the team leader already
    agreed, and forgetting that is the thing that actually costs her in the
    first minute of a call.

    Subjects and snippets only. The phone sends at most a handful of lines
    about ONE correspondent (GoogleService.gmailHistoryWith) and the mailbox
    itself never leaves the device.
    """
    rows = event.get("history") or []
    if not isinstance(rows, list):
        return []
    out: list[dict] = []
    for row in rows[:_MAX_HISTORY]:
        if not isinstance(row, dict):
            continue
        subject = str(row.get("subject") or "").strip()
        snippet = str(row.get("snippet") or "").strip()
        if not (subject or snippet):
            continue
        when = str(row.get("date") or "").strip()
        out.append({
            "title": f"Your email: {subject or '(no subject)'}"
                     + (f" — {when}" if when else ""),
            # No link: this one is hers, and a brief must never invite anyone
            # to click through to a mailbox.
            "link": "",
            "snippet": snippet[:_MAX_HISTORY_CHARS],
            "kind": "history",
        })
    return out


async def build(event: dict, user_key: str, *, force: bool = False) -> dict:
    """One calendar event → a brief, or a plain reason why there isn't one.

    `user_key` is the VERIFIED caller from app_auth — never a value the client
    chose — because it namespaces the cache, and a cache keyed by event id
    alone would hand one person's brief to another."""
    event_id = str(event.get("id") or "")
    if not force:
        cached = _cache_read(user_key, event_id)
        if cached:
            return {**cached, "ok": True, "cached": True}

    subj = subjects(event)
    if not (subj["company"] or subj["person"]):
        # Gym, dentist, "call mum" — nothing to research, and guessing would
        # produce a confident brief about the wrong thing.
        return {"ok": False, "reason": "nothing_to_research", **subj}

    if not tavily_search.is_configured():
        return {"ok": False, "reason": "search_not_configured", **subj}

    sources = await _gather(subj)
    # Her own correspondence, read on the phone and passed in — never fetched
    # here, because no Google credential reaches this server. It is numbered
    # alongside the web results so the citation rule needs no special case: a
    # bullet about what they last agreed cites [7] exactly like a bullet about
    # what the company does.
    sources += _history_sources(event)
    if not sources:
        return {"ok": False, "reason": "no_sources", **subj}

    composed = await _compose(event, subj, sources)
    if not composed:
        return {"ok": False, "reason": "compose_failed", **subj}

    brief = _clean(composed, len(sources))
    brief.update({
        "subjects": subj,
        "sources": [{"n": i + 1, "title": s.get("title"), "link": s.get("link")}
                    for i, s in enumerate(sources)],
        "event": {"id": event_id, "title": event.get("title"),
                  "date": event.get("date"), "time": event.get("time")},
    })
    _cache_write(user_key, event_id, brief)
    return {**brief, "ok": True, "cached": False}
