"""understand — read the conversation, decide what she asked for, then act.

Koral, 2026-09-28: "I want the user to talk to the agent naturally, and the
agent will analyse the conversation — understand what the user wants, what she
is asking for, what the agent should do — then act."

What she got instead was a task literally titled "תוסיפי לי שיחה עם דותן בזום
5." The ReAct turn answered in prose and saved nothing, and the last line of
defence (task_rescue) is a set of regexes over her raw words: it cannot know
that "תוסיפי לי" is the request, not the task, or that "5" said at 14:00 means
17:00. Regexes decide by the shape of the words; this is a question of meaning.

So the safety net is now a language step first:

    conversation (last turns) + her message + now + her day
        → ONE model call, JSON only → {understood, actions[]}
        → code executes each action: add / update / nothing

The model decides WHAT she meant. Code still decides everything that is
arithmetic or a lookup — the date (tz.resolve_date), the label (categorize),
the duration from a range, the dedupe against her day, the clash check — so
the parts that must be deterministic stay deterministic.

The regex rescue stays underneath, for when the model cannot be reached at
all: a task saved with a clumsy title beats a task lost (and it says so).

Consumed by agent_turn.run_turn when the agent turn saved and updated nothing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import date as _date
from typing import Optional

import day_schedule
import history_stats
import llm_usage
import model_router
import place_ranker
import task_extract
import vehicle_intent
import tz as _tz

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You read a conversation between a user and her planning assistant, Meira, and "
    "decide what the user's LAST message asks Meira to DO. Reply with JSON only:\n"
    '{"understood":"one short line: what she wants, in her language",'
    '"kind":"do (save or change something on her day) | question (she wants to KNOW '
    'something Meira can find out) | chat",'
    '"ask":"ONE short question in her language when something she clearly meant is missing '
    'or impossible (a date that does not exist, an appointment with no day), else null",'
    '"lookup":{"what":"places | route | vehicle","category":"places only: the KIND of place, as a map '
    'lists it, in her language (לים → חוף ים, דואר → סניף דואר, קופת חולים כללית) — never a '
    'bare word a shop could be named after","destination":"route only: home, '
    'or the place as she said it","modes":["only ways she NAMED: car|bike|bus|train|walk|taxi"],'
    '"origin":"home if she said from home; the place as she said it if she named where she '
    'starts (מיגאל אלון 94 → יגאל אלון 94); else auto","open_now":false,'
    '"vehicle":"vehicle only: bike|car","vehicle_at":"vehicle only: where her bike/car is, as she '
    'said it","event_task_id":"vehicle only: the id from HER DAY of the event she must get to, '
    'or null",'
    '"via":["route only: stops she passes FIRST, in order (home / a place), else []"],'
    '"destination_task_id":"route only: the id from HER DAY when she is going to one of her '
    'tasks (לאימון → the gym task), else null","arrive_by":"HH:MM she must be there by, else null",'
    '"stop_minutes":"minutes she stays at a via stop (to change clothes ~10), else null"} — ONLY for a '
    'question about getting somewhere (route: ONE place she named, or home, or one of her '
    'tasks) or the nearest/fastest place of a KIND (places); else null,'
    '"actions":[{"do":"add","title":"the thing itself, as a short noun phrase, in the language '
    'her message is written in (English message → English title)",'
    '"date_expression":"her own words for the day (מחר / 8 באוקטובר / next Monday) or null",'
    '"until_expression":"her words for the LAST day when it spans several days (עד שבת / until '
    'Friday), else null","after_previous":"true when her day words count from the item before '
    '(ראשון שאחרי זה / the Sunday after that), else false",'
    '"part_of_day":"morning | noon | afternoon | evening when she said בבוקר/בצהריים/אחה״צ/בערב '
    'and no hour, else null","all_day":"true for a whole day (חופש, יום חופש, מילואים, day off)",'
    '"start":"HH:MM 24h or null","end":"HH:MM 24h or null","place":"place as she said it or null",'
    '"alarm":"HH:MM if she asked to be woken / an alarm at that hour; auto if she asked for an '
    'alarm with no hour (\'a suitable alarm\'); else null"},'
    '{"do":"update","task_id":"an id from HER DAY","start":"HH:MM or null","end":"HH:MM or null",'
    '"date_expression":"… or null","place":"… or null",'
    '"title":"the NEW name, when she says what it IS now (the workout is yoga on Tuesday); else null"}]}\n'
    "\n"
    "RULES\n"
    "- The TITLE is the thing, never the request: 'תוסיפי לי פגישה עם נועה בזום' → "
    "'פגישת זום עם נועה'. Never add a word she did not say (no 'זום' unless she said zoom). Drop 'תוסיפי/תרשמי/שימי/תכניסי לי', 'add/put', the time, the "
    "date and the place — each has its own field.\n"
    "- Times: convert to 24h using NOW. A bare hour said without בבוקר/am that is "
    "already past this morning is the afternoon/evening: at 14:00, 'ב5' / 'ב-5' / "
    "'בחמש' = 17:00. 'משתיים עד שתיים וחצי' = start 14:00, end 14:30. 'עכשיו' = NOW "
    "rounded to the next 5 minutes.\n"
    "- Never resolve dates yourself: copy her words into date_expression.\n"
    "- One real commitment = one action. A reminder about a task, the trip to it, "
    "or preparing for it is NOT a separate add.\n"
    "- If her message answers Meira's last question or changes something already on "
    "HER DAY ('תזיזי ל-5', 'לפני האימון', 'actually tomorrow'), that is an UPDATE of "
    "that task (use its id), never a new add. If the answer only says where it goes "
    "relative to other things and gives no time, return no action.\n"
    "- Something already on HER DAY, said again, is not a new add.\n"
    "- UNCLEAR → ASK, do not guess: a day she did not give for an appointment she is "
    "ADDING, a date that cannot exist ('80 באוקטובר' — ask if she meant the 8th), the "
    "place of an appointment she is adding when it is too vague to route to. Still add "
    "what IS clear; put the ONE question in \"ask\".\n"
    "- A QUESTION is answered by Meira, never bounced back: 'what's the closest beach "
    "by car from home', 'איפה הדואר הכי קרוב אליי', 'how do I get home from here', "
    "'car or bus?', 'what do I have tomorrow' → kind question, actions [], ask null. A "
    "vague place inside a question ('a beach', 'the nearest pharmacy') is what Meira "
    "SEARCHES for — never ask 'which one?'. Never ask where she lives or where she is: "
    "ABOUT HER says what is known, and Meira's tools start from there. Fill \"lookup\" "
    "for these: 'תעזרי לי לחזור הביתה' / 'how do I get home from here' → route, "
    "destination home; 'איך אני מגיעה לX הכי מהר' → route, destination X; 'לאיזה חוף "
    "מגיעים הכי מהר באוטו' → places, category חוף ים, modes [car]. Her bike or car is "
    "somewhere else: 'האופניים שלי בפלורנטין ואני צריכה להיות במפגש של באות' → vehicle, "
    "vehicle bike, vehicle_at פלורנטין, event_task_id = the id of the Baot event on HER "
    "DAY (match it by name — never ask where or when an event on HER DAY is); 'אני צריכה "
    "לאסוף את האופניים מפלורנטין, תכנני לי' → kind question, vehicle, vehicle_at פלורנטין, "
    "event_task_id null.\n"
    "- Statements of INTENT are requests: 'רציתי / אני רוצה / אני מתכננת / בא לי / אני "
    "צריכה … ל<activity> ב<hour>' → an add of that ACTIVITY at that hour (the grammar of "
    "wanting is never the title; her bike or car being somewhere else is the vehicle question above, never an add). 'לקום ליוגה בשמונה' / 'wake up for yoga at 8' → add yoga at "
    "08:00 — waking up for it is the plan's job, not a task. An hour that is still ahead "
    "today is TODAY, even at 02:00 at night.\n"
    "- 'What's urgent?' / 'מה דחוף?' / 'what first?' is about HER DAY's tasks: kind question, "
    "lookup null — never a places search for an emergency room.\n"
    "- A to-do said as a bare verb with a day ('ללכת לבנק מחר', 'לקנות חלב', 'go to the bank "
    "tomorrow') is something to SAVE: kind do, an add — not a question about getting there. "
    "Only HOW/WHERE words ('איך מגיעים לבנק', 'where is the bank') make it a route.\n"
    "- A question ABOUT a place — opening hours, phone, prices ('מה שעות הפתיחה של הדואר') — "
    "is kind question with lookup null: Meira searches it; a lookup is only for getting there.\n"
    "- A question about HER OWN PAST ('כמה פעמים התאמנתי השבוע?', 'how long was I on the "
    "road this month?', 'how often did I reschedule?') is kind question, actions [], lookup "
    "null — Meira counts it from her history. Never an add.\n"
    "- She REPLACES or RENAMES something already on HER DAY — 'בשלישי ב-8 במקום אימון יש יוגה', "
    "'שיניתי את האימון ליוגה', 'on Tuesday it's yoga, not a workout' — is an UPDATE of that "
    "task (its id) with \"title\" = the new name. Its place, hour and way of getting there stay "
    "(do not pass them again unless she changed them); never a second add beside the old one, "
    "and the old generic name must not stay on the schedule.\n"
    "- A STATEMENT that she HAS something — 'יש לי שיעור יוגה ביום חמישי', 'I have a pilates "
    "class on Thursday', 'יש לי חוג ציור בשלישי ב-18:00' — is an add of THAT activity under "
    "its own name (יוגה, פילאטיס, ציור — never the generic 'אימון'), on that day, with the "
    "hour if she gave one. It is NEVER a lookup: she did not ask where a studio is. If she "
    "gave no hour, still add it and put the ONE question in \"ask\" ('באיזו שעה?').\n"
    "- 'When do I get HOME today / tomorrow / after <appointment>?' ('מתי אני חוזרת הביתה מחר "
    "מאסף הרופא') is a question about a LATER trip from a saved appointment: kind question, "
    "lookup null — Meira's own tool answers it for THAT day. A route lookup is only for leaving NOW.\n"
    "- A LIST is tasks: 'משימות ליום שלישי בבוקר: X, Y, Z' / 'tasks for Tuesday morning: …' "
    "→ an add for EACH item after the colon (or on its own line), all with that day and "
    "part_of_day. Never answer a list with 'what's on your plate?'. 'תשמרי את מה שכתבתי' "
    "after such a list = add those items now.\n"
    "- A PLAN for a goal ('תכיני לי תוכנית לחזק ביטחון עצמי', 'help me prepare for the "
    "exam in two weeks', 'a plan to start running'): kind do, and the plan's steps ARE "
    "the actions — 3 to 6 concrete, doable adds (a title she can act on, not advice), "
    "spread over the coming days with a date_expression each (היום / מחר / יום ראשון…) "
    "and a part_of_day. A plan written only in words is a plan she loses.\n"
    "- Several DAYS: 'יום שני הבא עד שבת חופש' → ONE add, date_expression 'יום שני', "
    "until_expression 'שבת', all_day true. 'וראשון שאחרי זה עוד יום חופש' → another add, "
    "date_expression 'ראשון', after_previous true, all_day true.\n"
    "- Getting somewhere THROUGH another place: 'מתי לצאת מפה כדי לעבור בבית ואז להגיע "
    "לאימון ב-20:00' → kind question, lookup route, via [home], destination_task_id = the "
    "gym task from HER DAY (or destination = its place), arrive_by 20:00, stop_minutes 10. "
    "'by 20:00' / 'ב-20:00' with a destination is always arrive_by.\n"
    "- What Meira's OTHER tools do — a message to ANOTHER person, a personal agent, "
    "'remember that…' about her, a change to her profile, a web search, general advice "
    "with nothing to schedule → kind chat, actions [].\n"
    "- Chit-chat, thanks: kind chat, actions [].\n"
    "- An ALARM / wake-up she asks for ('ושימי לי שעון מעורר', 'wake me at 8', 'set an alarm') "
    "is NEVER its own add and never part of a title: put it in the \"alarm\" field of the task "
    "it is for (the one in the same message, or the one on HER DAY she means).\n"
    "- A call or a video meeting ('להתקשר ל…', 'call X', zoom) has NO place.\n"
    "- Several things in one message → several actions, in the order she said them.\n"
    "- Her message may be a VOICE TRANSCRIPT: a word can be mis-heard (a similar-"
    "sounding word, an odd spelling of a name or a place). Read it by what she most "
    "likely said in this conversation; never act on an obvious mishearing."
)

_MAX_HISTORY_TURNS = 6
_TIMEOUT_S = 20


def _client():
    # Shared with task_extract: one client, one key, one endpoint.
    return task_extract._get_client()


def _day_lines(day: list) -> str:
    rows = []
    for t in day[:25]:
        when = day_schedule.hhmm(t.get("fixed_time") or t.get("fixedTime")) or "—"
        rows.append(f"- id={t.get('id')} | {t.get('date') or 'no date'} {when} | {t.get('text')}")
    return "\n".join(rows) or "(nothing)"


_KINDS = ("do", "question", "chat")


def about_her(profile: Optional[dict], here: Optional[dict]) -> str:
    """The ABOUT HER block: what Meira already knows about where she is and how
    she travels. Without it this step asked "where do you live?" on 7.10 — its
    context held her tasks and nothing else."""
    p = profile or {}
    home = str(p.get("homeAddress") or "").strip()
    has_here = isinstance(here, dict) and here.get("lat") is not None and here.get("lng") is not None
    lines = [f"Home: {home or 'not saved'}",
             f"Usual transport: {p.get('transportType') or 'unknown'}",
             f"Live position: {'known (' + str(here.get('label') or 'GPS') + ')' if has_here else 'unknown'}"]
    return "\n".join(lines)


async def understand(message: str, history: Optional[list] = None,
                     day: Optional[list] = None, now_hhmm: Optional[str] = None,
                     today: Optional[_date] = None, about: str = "") -> Optional[dict]:
    """What her last message asks for. -> {understood, kind, actions, ask} or None.

    None means the model could not be asked or answered nonsense — NOT "she
    asked for nothing", which is {"actions": []}. The caller falls back on the
    first and does nothing on the second (silent-state rule 1).

    kind: "do" | "question" | "chat". A question is answered by the agent with
    its tools; it never carries an `ask`."""
    message = (message or "").strip()
    if not message:
        return {"understood": "", "kind": "chat", "actions": [], "ask": None}
    today = today or _tz.today_il()
    now_hhmm = now_hhmm or _tz.now_il().strftime("%H:%M")
    turns = []
    for turn in (history or [])[-_MAX_HISTORY_TURNS:]:
        content = turn.get("content") if isinstance(turn, dict) else None
        if isinstance(content, str) and content.strip():
            role = "assistant" if turn.get("role") == "assistant" else "user"
            turns.append({"role": role, "content": content[:1200]})
    context = (f"NOW: {today.isoformat()} {now_hhmm} (Israel)\n"
               + (f"ABOUT HER:\n{about}\n" if about else "")
               + f"HER DAY (open tasks):\n{_day_lines(day or [])}\n\n"
               f"HER LAST MESSAGE:\n{message}")
    # Her bike or car is mentioned (here or in the last turns): the focused
    # reader runs IN PARALLEL with this step, so it costs no extra wait.
    vehicle_task = None
    if vehicle_intent.mentions_vehicle(message, turns):
        today_only = [t for t in (day or []) if str(t.get("date") or today.isoformat())[:10] == today.isoformat()]
        vehicle_task = asyncio.ensure_future(vehicle_intent.extract(message, turns, today_only, now_hhmm))
    model = model_router.pick("understand", prompt_chars=len(_SYSTEM) + len(context)
                              + sum(len(t["content"]) for t in turns))
    try:
        response = await _client().chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": _SYSTEM}, *turns,
                      {"role": "user", "content": context}],
            temperature=0,
            response_format={"type": "json_object"},
            timeout=_TIMEOUT_S,
        )
        usage = response.usage
        if usage:
            llm_usage.record("understand", usage.prompt_tokens or 0,
                             usage.completion_tokens or 0, model)
        payload = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:  # noqa: BLE001 — the caller falls back, and says so
        logger.warning("understand: model step failed: %s", exc)
        return None
    actions = payload.get("actions")
    if actions is None and isinstance(payload, dict) and (payload.get("kind") or payload.get("understood")):
        # A question has nothing to do, and the model sometimes leaves the empty
        # list out. That is an answer ("nothing to save"), not a failure — read
        # as one, it sent a voice question down the 50-second path (7.10).
        actions = []
    if not isinstance(actions, list):
        logger.warning("understand: no action list in %r", str(payload)[:200])
        return None
    kept = alarm_onto_task([a for a in actions if isinstance(a, dict) and a.get("do") in ("add", "update")],
                           message)
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in _KINDS:
        kind = "do" if kept else "chat"
    # The lookup too: on 7.10 a route question took the slow path and the log
    # could not say whether the model named no lookup or named one we refused.
    # Its KIND only — the place she asked about stays out of the logs (7.10 privacy).
    lookup = payload.get("lookup")
    lookup_kind = (lookup.get("kind") or lookup.get("type") or "named") if isinstance(lookup, dict) else bool(lookup)
    logger.warning("understand: [%s] → %s lookup=%s", kind, [a.get("do") for a in kept], lookup_kind)
    ask = payload.get("ask")
    ask = ask.strip() if isinstance(ask, str) and ask.strip() else None
    wake = wake_request(message)
    if wake is not None:
        kept, kind = wake_actions(kept, message, wake)
    vehicle = (await vehicle_task) if vehicle_task else None
    if vehicle is None and vehicle_task is not None:
        vehicle = vehicle_lookup(message, payload.get("lookup"))   # the model could not say: words
    if vehicle:
        # Her bike/car is somewhere else: a plan to work out, decided by code.
        # Live, 19.10: the model called it a route to "באות", which is no
        # place, and Meira asked where the meetup was — it was on her day.
        logger.warning("understand: vehicle elsewhere → planned in code (model said %s)", lookup_kind)
        return {"understood": str(payload.get("understood") or ""), "kind": "question",
                "actions": [], "ask": None, "lookup": vehicle}
    if history_stats.is_history_question(message):
        # "כמה פעמים התאמנתי השבוע?" names a workout and is not one. Counted by
        # ask_my_history; saving it would file her question as a gym session.
        logger.warning("understand: a question about her past → nothing saved (model said %s)", kind)
        return {"understood": str(payload.get("understood") or ""), "kind": "question",
                "actions": [], "ask": None, "lookup": None}
    if kind == "question":
        # Her question is Meira's to answer. A "which beach?" back is the
        # failure this field exists for (7.10).
        ask = None
    return {"understood": str(payload.get("understood") or ""), "kind": kind,
            "actions": kept, "ask": ask,
            "lookup": lookup_of(payload.get("lookup"), message) if kind == "question" else None}


# "האופניים שלי ברחוב פלורנטין" / "לאסוף את האופניים מפלורנטין" / "my bike is on X".
_VEHICLE_HE = r"(?P<v>האופני?ים|אופני?ים|האוטו|הרכב|אוטו|רכב)"
# Where the place ends: her next words are the request, not the street (live,
# 19.10: "מפלורנטין תחשבי לי מתי ואיך" read as a place called "פלורנטין תחשבי לי מתי").
_PLACE_END = r"(?=\s*(?:,|\.|\?|!|\sו|\s(?:תחשבי|תכנני|תגידי|תעזרי|מתי|איך|כדי|עכשיו|היום|מחר|please|when|how)\b|$))"
_VEHICLE_AT = [
    re.compile(_VEHICLE_HE + r"\s+שלי\s+(?:נמצא(?:ים|ת)?\s+|עומד(?:ים|ת)?\s+|חונה\s+)?(?:ב-?|ליד\s+)\s*(?P<at>[^,.?!\n]+?)" + _PLACE_END),
    re.compile(r"(?:לאסוף|לקחת|להביא|להחזיר|לקטוף)\s+את\s+" + _VEHICLE_HE + r"(?:\s+שלי)?\s+(?:מ-?|ב-?)\s*(?P<at>[^,.?!\n]+?)" + _PLACE_END),
    re.compile(r"\bmy\s+(?P<v>bike|bicycle|car)\s+is\s+(?:at|on|in|near)\s+(?P<at>[^,.?!\n]+?)(?=\s*(?:,|\.|\?|!|\sand\b|$))", re.I),
    re.compile(r"\bpick\s+up\s+my\s+(?P<v>bike|bicycle|car)\s+(?:from|at|on)\s+(?P<at>[^,.?!\n]+?)(?=\s*(?:,|\.|\?|!|\sand\b|$))", re.I),
]
_CAR_WORDS = ("האוטו", "הרכב", "אוטו", "רכב", "car")


def vehicle_lookup(message: str, raw=None) -> Optional[dict]:
    """Her bike or car is somewhere else → a vehicle lookup, or None.

    Read from her words, not left to the model: the model's own vehicle lookup
    is used when it gave one; otherwise the place comes from the sentence and
    the event from the route it named, matched against her day later."""
    raw = raw if isinstance(raw, dict) else {}
    text = str(message or "")
    for rx in _VEHICLE_AT:
        m = rx.search(text)
        if not m:
            continue
        at = (str(raw.get("vehicle_at") or "").strip() if raw.get("what") == "vehicle" else "") \
            or m.group("at").strip()
        vehicle = "car" if m.group("v").lower() in _CAR_WORDS else "bike"
        event = str(raw.get("event_task_id") or "").strip()
        dest = str(raw.get("destination") or "").strip() if raw.get("what") == "route" else ""
        return {"what": "vehicle", "vehicle": vehicle, "vehicle_at": at[:80],
                "event_task_id": None if event.lower() in ("", "null", "none") else event[:64],
                "event_words": dest[:80] or _event_words(text, m), "modes": [], "origin": "auto",
                "open_now": False}
    return None


def _event_words(text: str, m) -> str:
    """What she said about where she has to be: the rest of the sentence."""
    rest = (text[:m.start()] + " " + text[m.end():]).strip(" ,.?!")
    return rest[:80]


_LOOKUP_MODES = ("car", "bike", "bus", "train", "walk", "taxi")
_URGENT_RE = re.compile(r"\burgent|דחוף|דחופ|הכי חשוב|מה קודם|\bfirst\b|priority|עדיפות", re.I)
_ER_RE = re.compile(r"בית חולים|בית-חולים|מיון|חדר מיון|\bhospital|\bER\b|emergency room|אמבולנס|ambulance|קופת חולים", re.I)


# A question ABOUT a place — its hours, phone, prices — is not a trip to it.
# Live eval 20.10: "מה שעות הפתיחה של הדואר בישראל?" was answered with the bus
# to the nearest post office. Those go to the agent, which searches.
_ABOUT_PLACE_RE = re.compile(
    r"שעות (?:ה)?פתיחה|שעות הפעילות|מתי (?:\S+ )?(?:נפתח|נסגר|פותח|סוגר|פתוח)|עד מתי (?:\S+ )?פתוח"
    r"|טלפון של|מספר הטלפון|כמה עולה|מחיר"
    r"|opening hours|business hours|\bhours of\b|what time does .{0,40}\b(?:open|close)"
    r"|phone number|how much (?:is|does)|\bprice", re.I)


def lookup_of(raw, message: str = "") -> Optional[dict]:
    """The model's lookup, kept only when it can be run as it stands: places
    need a category, a route needs a destination. Anything else → None, and
    the agent answers the question its own way."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if not isinstance(raw, dict):
        return None
    what = str(raw.get("what") or "").strip().lower()
    category = str(raw.get("category") or "").strip()
    destination = str(raw.get("destination") or "").strip()
    modes = [m for m in (raw.get("modes") or []) if isinstance(m, str) and m in _LOOKUP_MODES]
    if not modes and message:
        # She said "באוטו" and the model left modes empty (7.10): the ways she
        # NAMED are a word lookup, not a judgement — the same table the
        # ranker uses.
        modes = place_ranker.named_modes(message)
    origin = str(raw.get("origin") or "auto").strip()
    # A start she NAMED ("from Yigal Alon 94") is kept as she said it; dropping
    # it routed home→home and answered "1 min on foot" (7.10, live).
    if origin.lower() in ("", "auto", "here", "current", "none", "null"):
        origin = "auto"
    elif origin.lower() in ("home", "בית", "הבית", "מהבית"):
        origin = "home"
    out = {"modes": modes, "origin": origin[:80], "open_now": raw.get("open_now") is True}
    if what in ("places", "route") and _ABOUT_PLACE_RE.search(message or ""):
        logger.warning("understand: a question about a place, not a trip — the agent searches")
        return None
    if what == "places" and category:
        if _URGENT_RE.search(message or "") and not _ER_RE.search(message or ""):
            # "What's urgent?" (the chat's own chip) is about HER tasks. Live,
            # 19.10: it was searched as category "חירום" and answered with the
            # nearest hospital. An ER is only looked for when she names one.
            logger.warning("understand: 'urgent' is about her day, not a place search")
            return None
        return {**out, "what": "places", "category": category[:60]}
    task_id = str(raw.get("destination_task_id") or "").strip()
    if task_id.lower() in ("null", "none"):
        task_id = ""
    if what == "route" and (destination or task_id):
        via = [str(v).strip()[:80] for v in (raw.get("via") or [])
               if isinstance(v, str) and str(v).strip()][:2]
        try:
            stop = int(raw.get("stop_minutes")) if raw.get("stop_minutes") not in (None, "") else None
        except (TypeError, ValueError):
            stop = None
        return {**out, "what": "route", "destination": destination[:80], "destination_task_id": task_id,
                "via": via, "arrive_by": day_schedule.hhmm(raw.get("arrive_by")),
                "stop_minutes": stop if stop is not None and 0 <= stop <= 120 else None}
    vehicle_at = str(raw.get("vehicle_at") or "").strip()
    if what == "vehicle" and vehicle_at:
        vehicle = str(raw.get("vehicle") or "bike").strip().lower()
        event = str(raw.get("event_task_id") or "").strip()
        return {**out, "what": "vehicle", "vehicle": vehicle if vehicle in ("bike", "car") else "bike",
                "vehicle_at": vehicle_at[:80],
                "event_task_id": None if event.lower() in ("", "null", "none") else event[:64]}
    return None


def _minutes(start: Optional[str], end: Optional[str]) -> Optional[int]:
    s, e = day_schedule.hhmm(start), day_schedule.hhmm(end)
    if not (s and e):
        return None
    span = (int(e[:2]) * 60 + int(e[3:])) - (int(s[:2]) * 60 + int(s[3:]))
    return span if span > 0 else span + 24 * 60


def wake_request(message: str) -> Optional[str]:
    """The hour she asked to be woken / alarmed at — HH:MM, "auto" when she
    asked for an alarm with no hour, or None when she asked for no alarm.
    Read from the part of the sentence that does the asking ("תעירי אותי ב-7,
    הראיון ב-13:00" is 07:00, never 13:00). The mirror of main._wake_request."""
    m = _WAKE_RE.search(message or "")
    if not m:
        return None
    tail = message[m.start():]
    explicit = re.search(r"(\d{1,2}):(\d{2})", tail)
    bare = re.search(r"(?:\bat\b|\bfor\b|בשעה|ב-|ב\s|ב(?=\d))\s*(\d{1,2})(?!\d|:)", tail, re.I)
    # The FIRST hour after the asking words is the alarm's; a later one is the event's.
    if explicit and int(explicit.group(1)) <= 23 and (not bare or explicit.start() <= bare.start()):
        return f"{int(explicit.group(1)):02d}:{explicit.group(2)}"
    if not bare:
        spoken = task_extract.parse_clock_time(task_extract.spoken_hours(tail))
        return spoken or "auto"
    hour = int(bare.group(1))
    if hour > 23:
        return "auto"
    if re.search(r"\bpm\b|tonight|evening|בערב|בלילה", tail, re.I) and hour < 12:
        hour += 12
    return f"{hour:02d}:00"


def wake_actions(actions: list, message: str, wake: str) -> tuple:
    """Code decides what an alarm request does (live, 20.10: "תעירי אותי ב-8" was
    an update that MOVED a task to 08:00; "set an alarm" got the call's own
    minute; "תוסיפי לי עוד שעון מעורר גם ב 9" got no action at all).

    -> (actions, kind). With a task in the message: the alarm is that task's,
    at the hour asked (none asked → auto, never the task's own minute). With
    no task: one alarm-only update — the task it is for is chosen by
    agent_turn, and no field of it but the alarm changes."""
    adds = [a for a in actions if a.get("do") == "add" and not _WAKE_RE.search(str(a.get("title") or ""))]
    if adds:
        target = next((a for a in adds if a.get("start")), adds[0])
        target["alarm"] = wake if wake != "auto" else "auto"
        if target.get("alarm") == target.get("start"):
            target["alarm"] = "auto"
        others = [a for a in actions if a.get("do") == "update"]
        return adds + others, "do"
    upd = next((a for a in actions if a.get("do") == "update" and a.get("task_id")), None)
    return [{"do": "update", "task_id": upd.get("task_id") if upd else None, "alarm": wake,
             "alarm_only": True}], "do"


_WAKE_RE = re.compile(r"wake me( up)?|set an alarm|an alarm|alarm clock|\balarm\b|תעיר[יני]? אותי|להעיר אותי|"
                      r"תעורר[יי]? אותי|שעון מעורר|תעירי|להשכים", re.I)   # never a bare "שעון" (a watch)
ALARM_LEAD_MIN = 30   # "a suitable alarm" for an hour: half an hour before it


def alarm_onto_task(actions: list, message: str) -> list:
    """An alarm is never a task (live, 20.10: "ושימי לי שעון מעורר מתאים" was
    saved as a task called "שעון מעורר לשיחה עם דותן"). An add whose title IS an
    alarm is dropped and becomes the alarm of the other task in the message; a
    message asking for an alarm marks that task's alarm as auto if the model
    left it empty."""
    alarms = [a for a in actions if a.get("do") == "add" and _WAKE_RE.search(str(a.get("title") or ""))]
    rest = [a for a in actions if a not in alarms]
    if not rest and alarms:
        # The message is ONLY an alarm ("תוסיפי לי עוד שעון מעורר גם ב 9", live
        # 20.10 01:34 → a task called "עוד שעון מעורר"). It is the alarm of a
        # task she already has — the one just talked about, or the next one;
        # code picks it (agent_turn), the model only gives the hour.
        a = alarms[0]
        logger.warning("understand: an alarm on its own → an alarm on her task, not a task")
        return [{"do": "update", "task_id": a.get("task_id"), "alarm": a.get("start") or a.get("alarm") or "auto",
                 "date_expression": a.get("date_expression"), "alarm_only": True}]
    if not rest:
        return actions
    if alarms or _WAKE_RE.search(message or ""):
        target = next((a for a in rest if a.get("start")), rest[0])
        if not target.get("alarm"):
            target["alarm"] = (alarms[0].get("start") if alarms and alarms[0].get("start") else "auto")
        if alarms:
            logger.warning("understand: an alarm read as a task → the alarm of the task it is for")
    return rest


def _alarm_at(alarm, start: Optional[str]) -> Optional[str]:
    if not alarm or str(alarm).lower() in ("null", "none", ""):
        return None
    if str(alarm).lower() == "auto":
        if not start:
            return None
        h, m = int(start[:2]), int(start[3:5])
        t = max(0, h * 60 + m - ALARM_LEAD_MIN)
        return f"{t // 60:02d}:{t % 60:02d}"
    return day_schedule.hhmm(alarm)


_HE_RE = re.compile(r"[\u0590-\u05FF]")
_EN_LEAD_RE = re.compile(r"^(?:please\s+)?(?:(?:add|put|save|schedule|set)\s+(?:me\s+)?(?:a\s+)?|remind me to\s+|i (?:need|have|want) to\s+)", re.I)
_EN_WHEN_RE = re.compile(
    r"\b(?:at|by|from|until|to)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b"
    r"|\b(?:on\s+)?(?:today|tonight|tomorrow|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b"
    r"|\bin\s+\d+\s+days?\b|\bnext week\b", re.I)


def _title_in_her_language(title: str, message: str, action: dict) -> str:
    """An English message keeps an English title. Live, 20.10: "buy a gift for
    Noa on Thursday" was saved as "מתנה לנועה" — the model translated the name
    and then the rest. When her message has no Hebrew and the title does, the
    title is her own words with the day and the hour taken off."""
    if not _HE_RE.search(title) or _HE_RE.search(message or ""):
        return title
    words = _EN_WHEN_RE.sub(" ", message)
    expr = str(action.get("date_expression") or "").strip()
    if expr and not _HE_RE.search(expr):
        words = re.sub(r"\b(?:on\s+)?" + re.escape(expr), " ", words, flags=re.I)
    words = re.sub(r"\s+", " ", _EN_LEAD_RE.sub("", words.strip())).strip(" .,!?-")
    if not words:
        return title
    logger.warning("understand: Hebrew title for an English message — kept her words")
    return words[:1].upper() + words[1:]


# Where each part of the day may hold a task, HH:MM [start, end).
PARTS_OF_DAY = {"morning": ("08:00", "12:00"), "noon": ("12:00", "14:30"),
                "afternoon": ("14:00", "18:00"), "evening": ("18:00", "22:00")}


def _truthy(value) -> bool:
    return value is True or str(value).strip().lower() in ("true", "1", "yes")


def task_from(action: dict, message: str, today: Optional[_date] = None) -> Optional[dict]:
    """An "add" action → a task, labelled and dated by code, not by the model.

    Undated and untimed stays undated: the general list, where the day's plan
    places it — never dumped on today (her rule: time or place → the timeline,
    otherwise the flexible tasks)."""
    title = str(action.get("title") or "").strip()
    if not title:
        return None
    title = _title_in_her_language(title, message, action)
    today = today or _tz.today_il()
    start = day_schedule.hhmm(action.get("start"))
    raw = {"text": title, "fixed_time": start, "duration_minutes": _minutes(start, action.get("end")),
           "date_expression": action.get("date_expression"), "location": action.get("place")}
    # The title is clean by construction; the SENTENCE is only read for a date
    # when the model copied none, and for the day-long default.
    task = task_extract.finalize(raw, title if action.get("date_expression") else message, today)
    task["text"] = title
    if not start and _truthy(action.get("all_day")):
        task["fixed_time"] = task_extract.DAY_LONG_START
        task["duration_minutes"] = task_extract.DAY_LONG_MINUTES
        return task
    part = str(action.get("part_of_day") or "").strip().lower()
    if not start and part in PARTS_OF_DAY:
        # "ביום שלישי בבוקר" is a window, not a time: act_on_understanding
        # places it in that window's free time and SAYS the hour (27.10).
        task["part_of_day"] = part
    if not start and not action.get("date_expression"):
        if task_extract.day_long(title):
            task["fixed_time"] = task_extract.DAY_LONG_START
            task["duration_minutes"] = task_extract.DAY_LONG_MINUTES
        else:
            task["date"] = None
    if not task.get("location") or task.get("category") in ("call", "zoom"):
        # A call has no place — "(current location: …)" on a phone call (20.10).
        task.pop("location", None)
    alarm = _alarm_at(action.get("alarm"), task.get("fixed_time"))
    if alarm:
        task["alarmAt"] = alarm
        task["alarmState"] = "planned"
        if str(action.get("alarm")).lower() == "auto":
            task["alarm_auto"] = True     # agent_turn sets the real wake time
    return task


def patch_from(action: dict, today: Optional[_date] = None) -> dict:
    """An "update" action → only the fields that change."""
    patch: dict = {}
    start = day_schedule.hhmm(action.get("start"))
    if start:
        patch["fixed_time"] = start
        span = _minutes(start, action.get("end"))
        if span:
            patch["duration_minutes"] = span
    if action.get("date_expression"):
        resolved = _tz.resolve_date_at(str(action["date_expression"]), today)
        if resolved:
            patch["date"] = resolved.isoformat()
    if action.get("place"):
        patch["location"] = str(action["place"])
    title = str(action.get("title") or "").strip()
    if title:
        patch["text"] = title[:120]
    alarm = _alarm_at(action.get("alarm"), patch.get("fixed_time") or action.get("start"))
    if action.get("alarm_only"):
        # Only the alarm moves — the hour she said is the ALARM's, not the task's.
        patch = {}
    if alarm:
        patch["alarmAt"] = alarm
        patch["alarmState"] = "planned"
    return patch
