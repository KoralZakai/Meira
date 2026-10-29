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

A brief older than _TTL_DAYS is refetched — news goes stale. A brief written
by an older version of this module (_VERSION) is refetched too: 17.10 added the
interview sections, and a cached v1 brief has none of them.

INTERVIEWS (17.10, Koral: "do you want to prepare? what about collecting
knowledge about the interviewer? about the job! search for questions that were
asked there"). An interview is the one meeting where the company is not enough:
she needs the JOB and the QUESTIONS. So for an interview-like event —

  * the company may come from the VENUE ("רפאל מכון דוד" → Rafael), because a
    calendar entry she typed herself has no organiser domain and no "with X";
  * _gather adds the searches that find what candidates report being asked, in
    English and Hebrew, and what the role demands;
  * _compose adds role_*, likely_questions_* and prep_* — under the SAME rule
    as everything else: a line that cites no fetched WEB source is dropped, and
    a section left empty is NAMED in `missing`, so "no questions found" can
    never be mistaken for "the brief forgot to look" (silent-state rule 1).

COST: at most _MAX_SEARCHES searches and _MAX_RESULTS results plus ONE model
call, cached for _TTL_DAYS. Gym, dentist and "call mum" still make none.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Optional

import ai_gate
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
# Bump when the SHAPE of a brief changes: a cached older shape has no interview
# sections and would be served, as "fresh", for another week.
_VERSION = 2
# The ceiling on what one brief may cost in Tavily credits.
_MAX_SEARCHES = 6
_MAX_RESULTS = 14
_MAX_RESULTS_PLAIN = 12

# Domains that identify nobody: the invite came through a scheduling tool, so
# the organiser address says which SaaS sent the mail, not who we are meeting.
_GENERIC_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
    "icloud.com", "walla.co.il", "lu.ma", "calendar-invite@lu.ma",
    "comeet-notifications.com", "comeet.co", "sparkhire.com", "calendly.com",
    "google.com", "zoom.us", "teams.microsoft.com", "eventbrite.com",
    # Applicant-tracking systems: the sender is the vendor, never the employer.
    # "Workday" as the company made the brief search for Workday itself.
    # (workday.com itself is NOT here: a @workday.com recruiter works FOR Workday —
    # only myworkday.com / myworkdayjobs.com are the vendor's mailers.)
    "myworkday.com", "myworkdayjobs.com", "greenhouse.io",
    "greenhouse-mail.io", "lever.co", "hire.lever.co", "smartrecruiters.com",
    "icims.com", "taleo.net", "successfactors.com", "ashbyhq.com", "jobvite.com",
    "bamboohr.com", "recruitee.com", "teamtailor.com", "breezy.hr", "workable.com",
    "hirevue.com", "goodtime.io", "paradox.ai", "linkedin.com",
}

# "Interview with Jane Doe (Team Leader)" / "Discussion with Yuval Shitrit
# (Talent Acquisition Specialist)" — the shape every ATS invite uses.
_PERSON_RE = re.compile(
    r"(?:interview|discussion|call|meeting|conversation)\s+with\s+"
    r"([A-Z][\w'\-]+(?:\s+[A-Z][\w'\-]+){0,2})"
    r"(?:\s*\(([^)]{3,60})\))?",
    re.IGNORECASE)


# "Phone Screen at Workday for JR-1", "Interview at Ceva (Open)" — stops at for/–/(.
_AT_RE = re.compile(r"\b(?:at|@)\s+([A-Z][\w&'\-\.]*(?:\s+(?!for\b)[A-Z][\w&'\-\.]*){0,2})")
_CONTACT_MAIL_RE = re.compile(
    r"(?:recruiter|scheduling contact|interviewer|contact|coordinator)[^\n@]{0,60}?"
    r"([\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+)", re.IGNORECASE)


_TITLE_AFTER_REQ_RE = re.compile(
    r"\b(?:[A-Z]{1,4}-?\d{3,}|R\d{4,})\s+([A-Z][\w/&+\-\. ]{4,80}?)\s*(?:\(|\bis\b|$)")


def _domain_of(email: str) -> str:
    return (email or "").split("@")[-1].strip().lower()


def _company_from_domain(email: str) -> str:
    dom = _domain_of(email)
    # Suffix match too: wd3.myworkday.com, eu.greenhouse.io are the same vendors.
    if not dom or any(dom == g or dom.endswith("." + g) for g in _GENERIC_DOMAINS):
        return ""
    root = dom.split(".")[0]
    return root if len(root) > 2 else ""


# A requisition number is not a job title: "R-104233", "JR12345", "2024-0381".
_REQ_ID_RE = re.compile(r"^[\W_]*(?:req(?:uisition)?|jr|r|job)?[\s#:_\-]*[A-Z]{0,3}[\d\-_/.]{4,}\W*$", re.IGNORECASE)


# ── interviews ──────────────────────────────────────────────────────────────

# "interview" / "ראיון" (and the plural / the "interviewer") in the title or the
# description. \b does not work next to Hebrew, so the Hebrew side is plain.
_INTERVIEW_RE = re.compile(r"interview|screening call|ראיון|ראיונות|אינטרוויו", re.IGNORECASE)

# The blocks Meira itself writes for studying (utils/interviewPrep.ts). Their
# titles say "interview" and they are NOT one: searching for them would bill a
# brief about a study session.
_PREP_TITLE_RE = re.compile(
    r"^\s*(?:prep for|prepare for|final review for|morning study for|study for"
    r"|הכנה לראיון|חזרה אחרונה ל|לימוד בוקר ל|לימוד ל|להתכונן ל)", re.IGNORECASE)

# What KIND of interview the title says. Longest first, so "system design"
# beats "design".
_KIND_WORDS = [
    "system design", "home assignment", "take home", "take-home", "technical",
    "coding", "behavioral", "behavioural", "phone", "video", "onsite", "on-site",
    "screening", "first", "second", "third", "final", "hr", "manager", "culture",
    "טכני", "טלפוני", "ראשון", "שני", "אחרון", "מקצועי", "משאבי אנוש",
]
_KIND_RE = re.compile(
    r"(?<![\w])(" + "|".join(re.escape(k) for k in sorted(_KIND_WORDS, key=len, reverse=True))
    + r")(?![\w])", re.IGNORECASE)

# Employers Israeli users interview at, by the name they actually write.
# Hebrew first — that is how it lands in a calendar. Small on purpose: it only
# has to turn a Hebrew venue into a name a search engine can find; an employer
# missing here still works, as the venue's first words. Keys are matched as
# whole words (after peeling a one-letter Hebrew prefix: ברפאל → רפאל), with
# geresh/apostrophes dropped on both sides.
_ALIASES: dict[str, tuple[str, str]] = {
    # as written             (name_he,            name_en)
    "רפאל":                  ("רפאל",             "Rafael Advanced Defense Systems"),
    "rafael":                ("רפאל",             "Rafael Advanced Defense Systems"),
    "אלביט":                 ("אלביט",            "Elbit Systems"),
    "elbit":                 ("אלביט",            "Elbit Systems"),
    "התעשייה האווירית":      ("התעשייה האווירית", "Israel Aerospace Industries"),
    "תעשייה אווירית":        ("התעשייה האווירית", "Israel Aerospace Industries"),
    "אלתא":                  ("אלתא",             "ELTA Systems"),
    "צ'ק פוינט":             ("צ'ק פוינט",        "Check Point Software"),
    "check point":           ("צ'ק פוינט",        "Check Point Software"),
    "מובילאיי":              ("מובילאיי",         "Mobileye"),
    "אינטל":                 ("אינטל",            "Intel Israel"),
    "נבידיה":                ("נבידיה",           "NVIDIA Israel"),
    "מלאנוקס":               ("מלאנוקס",          "Mellanox NVIDIA"),
    "טבע":                   ("טבע",              "Teva"),
    "נייס":                  ("נייס",             "NICE Systems"),
    "וויקס":                 ("וויקס",            "Wix"),
    "אמדוקס":                ("אמדוקס",           "Amdocs"),
    "סייברארק":              ("סייברארק",         "CyberArk"),
    "סלברייט":               ("סלברייט",          "Cellebrite"),
    "גוגל":                  ("גוגל",             "Google Israel"),
    "מיקרוסופט":             ("מיקרוסופט",        "Microsoft Israel"),
    "אמזון":                 ("אמזון",            "Amazon Israel"),
    "קוואלקום":              ("קוואלקום",         "Qualcomm Israel"),
    "בנק הפועלים":           ("בנק הפועלים",      "Bank Hapoalim"),
    "בנק לאומי":             ("בנק לאומי",        "Bank Leumi"),
}
_HE_PREFIXES = "בלהמוכש"


def _norm_alias_text(text: str) -> str:
    """Lower-case, geresh/apostrophes dropped, spaces collapsed."""
    t = re.sub(r"[\"'’`׳״]", "", (text or "").lower())
    return re.sub(r"\s+", " ", t).strip()


def _alias_in(text: str) -> Optional[tuple[str, str]]:
    """The known employer named in `text`, if any — whole words only."""
    norm = _norm_alias_text(text)
    if not norm:
        return None
    words = [w for w in re.split(r"[^\w]+", norm) if w]
    # a one-letter Hebrew prefix peeled: "ברפאל" → "רפאל" (both forms tried)
    forms = set(words) | {w[1:] for w in words if len(w) > 3 and w[0] in _HE_PREFIXES}
    single = " " + " ".join(sorted(forms)) + " "
    phrase = " " + " ".join(words) + " "
    for key in sorted(_ALIASES, key=len, reverse=True):
        k = _norm_alias_text(key)
        if " " in k:
            if f" {k} " in phrase:
                return _ALIASES[key]
        elif f" {k} " in single:
            return _ALIASES[key]
    return None


_HEBREW_RE = re.compile(r"[֐-׿]")
_URLISH_RE = re.compile(
    r"https?://|www\.|zoom\.us|meet\.google|teams\.microsoft|\bzoom\b|\bgoogle meet\b",
    re.IGNORECASE)
_STREETISH_RE = re.compile(
    r"\d|\b(?:street|st\.|road|rd\.|avenue|ave\.|blvd|boulevard|floor|suite)\b"
    r"|רחוב|רח'|שדרות|שד'|קומה",
    re.IGNORECASE)


def _venue_segment(location: str) -> str:
    """The first comma-separated part of a venue that is a NAME, not a street.

    "Rafael, Haifa" → "Rafael"; "רפאל מכון דוד" → itself; "Derech Hashalom 53,
    Tel Aviv" → "" (that is where the building is, not who is in it); a Zoom
    link → "" (that is where the call is). Rule 8: the venue field is also read
    for the address and for the meeting link — this reader states what it
    refuses.
    """
    loc = (location or "").strip()
    if not loc or _URLISH_RE.search(loc):
        return ""
    first = re.split(r"[,،;\n]", loc, maxsplit=1)[0].strip(" -–—")
    if not first or len(first) < 2 or len(first) > 60 or _STREETISH_RE.search(first):
        return ""
    return first


def is_interview(event: dict) -> bool:
    """Is this event a job interview — decided in code, no model call."""
    title = str(event.get("title") or "")
    if _PREP_TITLE_RE.match(title):
        return False
    if str(event.get("category") or "").lower() == "interview":
        return True
    return bool(_INTERVIEW_RE.search(title)
                or _INTERVIEW_RE.search(str(event.get("description") or "")))


def _interview_kind(title: str) -> str:
    """"koral Technical Interview" → "Technical"."""
    m = _KIND_RE.search(title or "")
    return m.group(1).strip() if m else ""


def subjects(event: dict) -> dict:
    """Who and what to look up — decided in code, no model call.

    Returns {company, person, person_role, role_title, interview,
    interview_kind, role, venue, company_from, name_he, name_en}. Empty strings mean "nothing
    worth searching", and the caller must then skip the brief rather than
    search for the event title and dress up whatever comes back.

    For an interview the company may come from the VENUE when the invite names
    none (organiser, attendees, "with X" in the title), and `role` is the
    position line of the description, else the kind of interview the title says
    ("koral Technical Interview" → "Technical"). `name_he`/`name_en` are the
    employer in each script, for searching each language's sites.
    """
    title = str(event.get("title") or "")
    desc = str(event.get("description") or "")
    organizer = str(event.get("organizer") or "")
    location = str(event.get("location") or "")
    attendees = [str(a) for a in (event.get("attendees") or []) if a]
    interview = is_interview(event)

    company = _company_from_domain(organizer)
    if not company:
        for a in attendees:
            company = _company_from_domain(a)
            if company:
                break
    if not company:
        # "Your Phone Screen at Workday for JR-0104334 …" — the invite says where.
        am = _AT_RE.search(title)
        if am:
            company = am.group(1).strip()
    if not company:
        # "Recruiter / Scheduling Contact / Interviewer: x@acme.com" in the body.
        for em in _CONTACT_MAIL_RE.findall(desc):
            company = _company_from_domain(em)
            if company:
                break
    if not company:
        # "Scheduled Call with Directeam", "Your phone interview with Ceva"
        m = re.search(r"\bwith\s+([A-Z][\w&'\-\.]*(?:\s+[A-Z][\w&'\-\.]*){0,2})", title)
        pm = _PERSON_RE.search(title)
        # "Interview with Dana Cohen (Recruiter)" names the INTERVIEWER, not the
        # employer; a bare "interview with Ceva" is still the employer.
        if m and not (pm and pm.group(2) and pm.group(1).strip().lower() == m.group(1).strip().lower()):
            company = m.group(1).strip()
    if not company:
        # A labelled employer in the body: "Company: Acme", "חברה: אקמי".
        cm = re.search(r"(?:^|\n)\s*(?:company|employer|organi[sz]ation|חברה|מעסיק)\s*[:\-]\s*([^\n\r]{2,60})",
                       desc, re.IGNORECASE)
        if cm:
            company = cm.group(1).strip(" .")

    name_he = name_en = ""
    company_from = "invite" if company else ""
    if interview:
        # A known employer anywhere in the venue or the title beats guessing
        # from the venue's first words — and survives a street in the same
        # field ("רפאל רחוב הרצל 5").
        known = (_alias_in(company) if company
                 else (_alias_in(location) or _alias_in(title)))
        if known:
            name_he, name_en = known
            if not company:
                company, company_from = name_he, "venue"
        elif not company:
            # An employer we have no alias for: the venue's first words are the
            # best name we have, and the card says "low confidence" if wrong.
            company = _venue_segment(location)
            company_from = "venue" if company else ""
        if company and not (name_he or name_en):
            if _HEBREW_RE.search(company):
                name_he = company
            else:
                name_en = company
    # Outside interviews the venue is not a name to research (a gym is "Space
    # Gym", not an employer), so none of the above runs for them.

    person = role = ""
    m = _PERSON_RE.search(desc) or _PERSON_RE.search(title)
    if m:
        person = (m.group(1) or "").strip()
        role = (m.group(2) or "").strip()

    # The job/position line an ATS invite carries.
    role_title = ""
    rm = re.search(r"(?:position|role|job|תפקיד|משרה)\s*[:\-]\s*([^\n\r]{3,90})", desc, re.IGNORECASE)
    if rm:
        role_title = rm.group(1).strip()
        if _REQ_ID_RE.match(role_title):
            role_title = ""     # a job NUMBER searched as a title finds nothing

    if not role_title:
        # "… for JR-0104334 Senior Applied AI Engineer (Paradox) (Open) …" — the job
        # number is followed by the job's name.
        tm = _TITLE_AFTER_REQ_RE.search(title)
        if tm:
            role_title = tm.group(1).strip()

    kind = _interview_kind(title) if interview else ""
    return {"company": company, "person": person,
            "person_role": role, "role_title": role_title,
            "interview": interview,
            "interview_kind": kind,
            "role": role_title or kind,
            "venue": location.strip()[:120] if interview else "",
            # Where the company name came from: "invite" (organiser, attendee,
            # "with X") or "venue" (guessed from the location field).
            "company_from": company_from,
            "name_he": name_he, "name_en": name_en}


# ── search ──────────────────────────────────────────────────────────────────

def _search_plan(subj: dict) -> tuple[list[tuple[str, dict]], int]:
    """The searches to run, best first, and how many results to keep.

    Decided in code so the cost is a number you can read here: for an interview
    at most _MAX_SEARCHES queries and _MAX_RESULTS results. The ORDER is the
    priority when the result cap bites — what candidates were asked first, the
    news about the company last.

    The queries are about the COMPANY and the ROLE. Never her name (the event
    title often carries it: "koral Technical Interview"), never her address.
    """
    company, person = subj["company"], subj["person"]
    jobs: list[tuple[str, dict]] = []

    if not subj.get("interview"):
        if company:
            jobs.append((f"{company} company what they do", {}))
            jobs.append((f"{company} news", {"topic": "news", "days": 180, "n": 3}))
        if person:
            who = f"{person} {company}".strip()
            # LinkedIn first — it is where a role and a history actually live.
            jobs.append((f"{who} LinkedIn", {"n": 3}))
        return jobs[:_MAX_SEARCHES], _MAX_RESULTS_PLAIN

    co_en = subj.get("name_en") or company
    co_he = subj.get("name_he")
    role = (subj.get("role") or "").strip()
    if company:
        # What candidates report being asked — Glassdoor, Comparably, forums.
        jobs.append((f"{co_en} interview questions {role}".strip(), {"n": 4}))
        # Hebrew sites carry the Israeli reports. Only when the invite is
        # Hebrew-speaking: an English-only calendar does not need them.
        if co_he or _HEBREW_RE.search(f"{subj.get('venue', '')}{subj.get('role', '')}"):
            jobs.append((f"שאלות ראיון עבודה {co_he or co_en}", {"n": 3}))
        jobs.append((f"{co_en} {role} job requirements careers".replace("  ", " "), {"n": 3}))
        jobs.append((f"{co_en} company what they do", {"n": 2}))
    if person:
        jobs.append((f"{person} {company}".strip() + " LinkedIn", {"n": 2}))
    if company:
        jobs.append((f"{co_en} news", {"topic": "news", "days": 180, "n": 1}))
    return jobs[:_MAX_SEARCHES], _MAX_RESULTS


async def _gather(subj: dict, errors: Optional[list] = None) -> list[dict]:
    """Search results for the company, the job, what is asked there, the person.

    `errors` (optional) collects the reason of every search that failed, so the
    caller can tell "the web has nothing" from "the search was down" — those
    are different sentences to say to her.
    """
    jobs, cap = _search_plan(subj)

    async def _one(query: str, kw: dict) -> list[dict]:
        kw = dict(kw)
        n = kw.pop("n", 4)
        try:
            res = await tavily_search.search(query, max_results=n, **kw)
        except Exception as exc:  # noqa: BLE001 — one failed search is not a failed brief
            logger.warning("meeting_brief: search raised (%s)", exc)
            if errors is not None:
                errors.append(str(exc))
            return []
        if res.get("ok"):
            return list(res.get("results") or [])
        logger.info("meeting_brief: a search was unavailable (%s)", res.get("error"))
        if errors is not None:
            errors.append(str(res.get("error") or "unavailable"))
        return []

    # Concurrently: six sequential searches would be most of a minute of her
    # waiting. gather keeps the ORDER, which is the priority when the cap bites.
    batches = await asyncio.gather(*[_one(q, kw) for q, kw in jobs])
    out = [r for batch in batches for r in batch]

    # De-duplicate by link, keep first (best-ranked) occurrence.
    seen, uniq = set(), []
    for r in out:
        link = r.get("link")
        if not link or link in seen:
            continue
        seen.add(link)
        uniq.append(r)
    return uniq[:cap]


# ── compose ─────────────────────────────────────────────────────────────────

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

# Appended for an interview. The JSON gains three section pairs; every rule
# above still holds, and one is stricter: a question must come from a source.
_INTERVIEW_ADDENDUM = """

INTERVIEW MODE — this event is a JOB INTERVIEW and the user is the candidate. \
Also return, in the same JSON object:
 "role_he":[""],"role_en":[""],
 "likely_questions_he":[""],"likely_questions_en":[""],
 "prep_he":[""],"prep_en":[""]
- role_*: 2-3 bullets on the JOB itself — what the role does and what they ask \
of candidates (requirements, stack, seniority, domain), from the sources.
- likely_questions_*: 3-5 questions that a source says candidates were ASKED \
at this company, or for this kind of role. Write each as the question itself, \
close to how the source reports it, ending with its source number. If the \
sources report no such questions, return [] — NEVER write a plausible-sounding \
question of your own, and never cite a source about a different company.
- prep_*: 2-3 concrete steps for her to prepare — a topic to revise, a thing to \
practise, something to read — that follow from the cited material. Each ends \
with its source number.
- The VENUE is a hint about who the employer is. If sources disagree about \
which organisation this is, say so in caution_* and set confidence "low".
- Only the numbered WEB sources can back these three sections; \
"Your email:" sources cannot."""


def _cite_nums(line: str) -> list[int]:
    nums: list[int] = []
    for group in re.findall(r"\[([\d,\s]+)\]", line):
        for part in group.split(","):
            part = part.strip()
            if part.isdigit():
                nums.append(int(part))
    return nums


def _cite_ok(line: str, n_sources: int, n_web: Optional[int] = None) -> bool:
    """A bullet must cite at least one source that exists.

    With `n_web`, at least one of the sources it cites must be a WEB result:
    "candidates were asked X" cannot be backed by her own email."""
    nums = _cite_nums(line)
    if not (nums and all(1 <= n <= n_sources for n in nums)):
        return False
    return n_web is None or any(n <= n_web for n in nums)


async def _compose(event: dict, subj: dict, sources: list[dict]) -> Optional[dict]:

    listing = "\n".join(
        f"[{i+1}] {s.get('title')} — {s.get('link')}\n{(s.get('snippet') or '')[:700]}"
        for i, s in enumerate(sources))
    interview = bool(subj.get("interview"))
    company_line = subj["company"] or "(unknown)"
    if interview and subj.get("name_en") and subj["name_en"] != subj["company"]:
        company_line += f" (English: {subj['name_en']})"
    facts = (
        f"EVENT: {event.get('title')}\n"
        f"WHEN: {event.get('date')} {event.get('time')}\n"
        f"WHERE: {event.get('location') or '(not given)'}\n"
        f"COMPANY: {company_line}\n"
        f"PERSON: {subj['person'] or '(unknown)'} {('— ' + subj['person_role']) if subj['person_role'] else ''}\n"
        f"ROLE DISCUSSED: {subj['role_title'] or '(none)'}\n"
        + (f"INTERVIEW KIND: {subj['interview_kind'] or '(not stated)'}\n"
           f"EMPLOYER GUESSED FROM THE VENUE: {'yes' if subj['company_from'] == 'venue' else 'no'}\n"
           if interview else "")
        + f"\nSOURCES:\n{listing}"
    )
    system = _SYSTEM + (_INTERVIEW_ADDENDUM if interview else "")
    model = model_router.pick("meeting_brief", prompt_chars=len(system) + len(facts))
    client = ai_gate.client()
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": facts}],
            temperature=0.2,
            max_tokens=1800 if interview else 900,
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


# Lists that hold facts about the company or the person, and the interview
# sections. The interview sections are the ones that have to be backed by a
# WEB source, and the number of lines each may keep.
_FACT_KEYS = ("company_he", "company_en", "person_he", "person_en",
              "history_he", "history_en")
_INTERVIEW_KEYS = {"role": 3, "likely_questions": 5, "prep": 3}


def _clean(brief: dict, n_sources: int, n_web: Optional[int] = None) -> dict:
    """Drop every bullet that does not cite a source we actually fetched.

    `n_web` is how many of the sources are web results (the rest are her own
    email, numbered after them). The interview sections must cite one of the
    web results; the older sections keep the original rule."""
    dropped = 0
    for key in _FACT_KEYS:
        kept = []
        for line in brief.get(key) or []:
            if isinstance(line, str) and line.strip() and _cite_ok(line, n_sources):
                kept.append(line.strip())
            else:
                dropped += 1
        brief[key] = kept
    for section, limit in _INTERVIEW_KEYS.items():
        for lang in ("he", "en"):
            key = f"{section}_{lang}"
            raw = brief.get(key)
            if raw is None:
                continue                      # not an interview brief: nothing to clean
            kept = []
            for line in raw if isinstance(raw, list) else []:
                if isinstance(line, str) and line.strip() and _cite_ok(line, n_sources, n_web):
                    kept.append(line.strip())
                else:
                    dropped += 1
            brief[key] = kept[:limit]
    if dropped:
        logger.info("meeting_brief: dropped %d uncited bullet(s)", dropped)
        brief["confidence"] = "low" if dropped > 2 else brief.get("confidence", "medium")
    brief["dropped_bullets"] = dropped
    return brief


def _missing(brief: dict) -> list[str]:
    """Interview sections that came out EMPTY, by name.

    An empty list of likely questions can mean "no one reported any" or "the
    brief never looked". Both are true of the same `[]`, so the brief says which
    one it is: this list is the card's cue to write "I found no reported
    questions for this interview" instead of drawing nothing."""
    return [s for s in _INTERVIEW_KEYS
            if not brief.get(f"{s}_he") and not brief.get(f"{s}_en")]


def _has_content(brief: dict) -> bool:
    return any(brief.get(k) for k in (*_FACT_KEYS, *(f"{s}_{l}" for s in _INTERVIEW_KEYS
                                                      for l in ("he", "en"))))


# ── cache ───────────────────────────────────────────────────────────────────

def _load() -> dict:
    """{user_key: {event_id: {brief, fetched_at, v}}} — the shape
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
    # A row written before the interview sections existed has no `v` at all.
    if int(row.get("v") or 1) < _VERSION:
        return None
    return row.get("brief")


def _cache_write(user_key: str, event_id: str, brief: dict) -> None:
    if not (user_key and event_id):
        return
    try:
        store = _load()
        mine = store.setdefault(user_key, {})
        mine[event_id] = {"brief": brief, "fetched_at": time.time(), "v": _VERSION}
        if len(mine) > _MAX_CACHE:
            oldest = sorted(mine, key=lambda k: mine[k].get("fetched_at", 0))
            for key in oldest[:len(mine) - _MAX_CACHE]:
                mine.pop(key, None)
        _save(store)
    except Exception as exc:  # noqa: BLE001 — a cache miss is not a failure
        logger.warning("meeting_brief cache write failed: %s", exc)


def _cache_matches(cached: dict, subj: dict) -> bool:
    """Is a cached brief still about the company the event names TODAY?

    She edits the venue ("Rafael" → "Elbit") after the brief was made; the event
    id is the same, the research is about the wrong employer. A cached brief
    that recorded no subjects (older shape, tests) is trusted."""
    was = cached.get("subjects")
    if not isinstance(was, dict) or not subj.get("company"):
        return True
    return (was.get("company") or "").strip().lower() == subj["company"].strip().lower()


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
    out: list[dict] = _previous_sources(event)
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


_MAX_PREVIOUS = 2
_MAX_PREVIOUS_CHARS = 600


def _previous_sources(event: dict) -> list[dict]:
    """What happened the LAST time she met these people: the calendar events before
    this one with the same attendees (or the same title), as the phone read them.

    18.10, Koral: "a brief must say who the call is with, and a summary of the
    previous meeting if there was one". Title, date and the notes the event
    carries — nothing is invented, so a bullet about it cites it like any other
    source, and an earlier meeting with no notes is only "you met on <date>"."""
    rows = event.get("previous") or []
    if not isinstance(rows, list):
        return []
    out: list[dict] = []
    for row in rows[:_MAX_PREVIOUS]:
        if not isinstance(row, dict):
            continue
        title = str(row.get("title") or "").strip()
        when = str(row.get("date") or "").strip()
        notes = str(row.get("notes") or "").strip()
        if not (title and when):
            continue
        out.append({
            "title": f"Your earlier meeting: {title} — {when}",
            "link": "",
            "snippet": (notes or "(no notes on the event)")[:_MAX_PREVIOUS_CHARS],
            "kind": "history",
        })
    return out


def _has_history(event: dict) -> bool:
    return bool(event.get("history") or event.get("previous"))


async def build(event: dict, user_key: str, *, force: bool = False) -> dict:
    """One calendar event → a brief, or a plain reason why there isn't one.

    `user_key` is the VERIFIED caller from app_auth — never a value the client
    chose — because it namespaces the cache, and a cache keyed by event id
    alone would hand one person's brief to another.

    Every `ok: false` carries a `reason` the app turns into a sentence:
      nothing_to_research  not an interview and no company (gym, dentist)
      no_company           an INTERVIEW with no employer we could name
      search_not_configured / search_failed / no_sources   the web half
      compose_failed / nothing_cited                       the model half"""
    event_id = str(event.get("id") or "")
    subj = subjects(event)
    if not force:
        cached = _cache_read(user_key, event_id)
        if cached and _cache_matches(cached, subj):
            return {**cached, "ok": True, "cached": True}

    if not (subj["company"] or subj["person"] or _has_history(event)):
        # Gym, dentist, "call mum" — nothing to research, and guessing would
        # produce a confident brief about the wrong thing. An INTERVIEW is
        # different: she asked to be prepared, so "I could not tell which
        # company" is an answer she has to be given (rule 1).
        return {"ok": False,
                "reason": "no_company" if subj["interview"] else "nothing_to_research",
                **subj}

    if not tavily_search.is_configured():
        return {"ok": False, "reason": "search_not_configured", **subj}

    errors: list = []
    # Nobody to look up on the web (a meeting she has history with, no company
    # on the invite): the brief is her own earlier mail and meetings, cited.
    sources = await _gather(subj, errors) if (subj["company"] or subj["person"]) else []
    n_web = len(sources)
    # Her own correspondence, read on the phone and passed in — never fetched
    # here, because no Google credential reaches this server. It is numbered
    # alongside the web results so the citation rule needs no special case: a
    # bullet about what they last agreed cites [7] exactly like a bullet about
    # what the company does.
    sources += _history_sources(event)
    if not sources:
        return {"ok": False, "reason": "search_failed" if errors else "no_sources", **subj}

    composed = await _compose(event, subj, sources)
    if not composed:
        return {"ok": False, "reason": "compose_failed", **subj}

    brief = _clean(composed, len(sources), n_web)
    if not _has_content(brief):
        # Every line was dropped for want of a citation. A confident headline
        # over nothing is the half-failed shape; say what happened instead.
        return {"ok": False, "reason": "nothing_cited", **subj}
    if subj["interview"]:
        brief["interview"] = True
        brief["missing"] = _missing(brief)
    brief.update({
        "subjects": subj,
        "sources": [{"n": i + 1, "title": s.get("title"), "link": s.get("link")}
                    for i, s in enumerate(sources)],
        "event": {"id": event_id, "title": event.get("title"),
                  "date": event.get("date"), "time": event.get("time")},
    })
    _cache_write(user_key, event_id, brief)
    return {**brief, "ok": True, "cached": False}
