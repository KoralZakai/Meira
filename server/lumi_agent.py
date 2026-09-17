"""Personality-aware Lumi agent for WhatsApp (Nebius / Qwen, ReAct).

The loop lives in react_loop, run directly against the OpenAI SDK. It used to
be LangGraph, which cost 35 MB resident on a 256 MB machine to supply a `while`
loop the model was doing all the thinking inside anyway — and that machine was
OOM-killed on 2026-08-28, dropping the WhatsApp message being delivered. Same
model, same eighteen tools, same ReAct pattern.

Dependencies: config (LLM creds), conversation (turn history), user_profile /
user_memory (what we know about the user), geo (route planning), mbti +
judge_service (prompt blocks), personality_handoff (app deep links),
supabase_tasks (get_my_tasks). Entry point handle_whatsapp_message is called
only by main.whatsapp_webhook; its returned 'departures' list is what
reminders.schedule_departures persists.
"""
import json
import logging
import os
import re
import time
from typing import Optional

import httpx
from datetime import date
from openai import AsyncOpenAI, APIConnectionError, APITimeoutError
from react_loop import ChatOpenAI, tool, ToolMessage, AIMessage, create_react_agent

import agents_store
import categorize
import clashes as _clashes
import config
import model_router
import tavily_search
import conversation
import day_schedule
import llm_usage
import memory_recall
import geo
import user_profile
import user_memory
import supabase_tasks
import task_store
import reminders
from mbti import personality_prompt
from judge_service import get_guidelines
import personality_handoff
import reply_consistency


_RAW_TOOL_CALL_RE = re.compile(r'\{"name":\s*"\w+",\s*"arguments"', re.DOTALL)


def _location_from_departure(plan: dict) -> dict:
    """Turn a plan_departure result into a TaskLocation (the shape the mobile/web
    apps store in tasks.location). This is what makes the route Lumi computed
    survive after the WhatsApp chat is cleared — otherwise the plan only fed the
    reminder scheduler and was never saved onto the task itself.

    geo's internal leg keys are mapped to the app's TransitLeg shape
    (type/from/to/durationMinutes/departureTime/arrivalTime/lineNumber/stopName)
    so TaskDetail renders WhatsApp- and app-created routes identically.
    """
    raw_legs = plan.get("legs") or []

    def _leg_type(t: Optional[str]) -> str:
        """Google vehicle types → the app's TransitLeg union (heavy_rail→train…)."""
        t = (t or "bus").lower()
        if t in ("walk", "bus", "train", "subway"):
            return t
        if "rail" in t or t in ("tram", "monorail", "commuter_train", "high_speed_train"):
            return "train"
        return "bus"

    legs = [
        {
            "type": _leg_type(leg.get("type")),
            "from": leg.get("from"),
            "to": leg.get("to"),
            "durationMinutes": leg.get("minutes"),
            "departureTime": leg.get("departTime"),
            "arrivalTime": leg.get("arriveTime"),
            "lineNumber": leg.get("line"),
            "stopName": leg.get("from"),
        }
        for leg in raw_legs
    ]
    first_transit = next((leg for leg in legs if leg.get("type") != "walk"), None)
    walk_first = next((leg.get("durationMinutes") for leg in legs if leg.get("type") == "walk"), 0)
    transit_plan = {
        "totalDurationMinutes": plan.get("travelMinutes"),
        "leaveHomeAt": plan.get("leaveHomeBy"),
        "arriveAt": plan.get("arriveBy"),
        "firstBusDeparture": (first_transit or {}).get("departureTime"),
        "firstBusStop": (first_transit or {}).get("from"),
        "walkToStopMinutes": walk_first or 0,
        "legs": legs,
        "overviewPolyline": plan.get("overviewPolyline"),
        "startLat": plan.get("startLat"),
        "startLng": plan.get("startLng"),
        # Where the trip was planned FROM. The app compares this against the
        # previous stop to decide whether the plan is stale; without it, it has
        # to assume home.
        "originAddress": plan.get("originAddress"),
        "source": "google",
        "fetchedAt": int(time.time() * 1000),
    }
    return {
        "address": plan.get("destination") or plan.get("destResolved"),
        "displayName": plan.get("destResolved"),
        "lat": plan.get("lat"),
        "lng": plan.get("lng"),
        "travelMinutes": plan.get("travelMinutes"),
        "wakeUpBy": plan.get("wakeUpBy"),
        "leaveHomeBy": plan.get("leaveHomeBy"),
        "confirmed": not plan.get("needsConfirm", False),
        "transitPlan": transit_plan,
    }


def _match_departure(task: dict, departures: list) -> Optional[dict]:
    """Pick the departure plan that belongs to this task: the one whose arrival
    equals the task's fixed time, else the only/first one (a turn almost always
    plans a single trip for a single appointment)."""
    if not departures:
        return None
    fixed = task.get("fixed_time")
    if fixed:
        for dep in departures:
            if dep.get("arriveBy") == fixed:
                return dep
    return departures[0]


def _suspicious_char(ch: str) -> bool:
    """Scripts that should never appear in this Hebrew/English app => garbage."""
    o = ord(ch)
    return (
        0x0E00 <= o <= 0x0E7F or   # Thai
        0x3000 <= o <= 0x9FFF or   # CJK
        0xAC00 <= o <= 0xD7AF or   # Hangul
        0x0600 <= o <= 0x06FF      # Arabic (app is Hebrew/English, not Arabic)
    )


def _is_degenerate(text: str) -> bool:
    """True if the model output looks like a repetition/garbage loop."""
    if not text:
        return False
    if _RAW_TOOL_CALL_RE.search(text):  # model leaked raw tool-call JSON into text
        return True
    suspicious = sum(1 for ch in text if _suspicious_char(ch))
    if suspicious >= 2 or (text and suspicious / len(text) > 0.12):
        return True
    run = 1
    for a, b in zip(text, text[1:]):
        run = run + 1 if a == b else 1
        if run >= 12:
            return True
    if len(text) > 60 and len(set(text)) <= 8:
        return True
    return False


# Clock-emoji + reminder/route lines the model must NOT copy from its own past
# replies (it parroted a stale "🕘 09:00 … 🕐 13:00" block on every DDP mention).
# The last alternative kills a nastier parrot: a stale "מחר … D.M" confirmation
# header (e.g. "*מחר, יום שישי 1.8*"). Replaying it made the model copy the OLD
# date+weekday verbatim — it kept saying "מחר … 1.8" days later, swapping only
# the weekday name at random. Requiring a D.M date on the line keeps plain
# "מחר ב-11:00" and fixed-date event lines ("מסיבה ב-4.8") untouched.
_HISTORY_NOISE_RE = re.compile(
    r"[🕐🕑🕒🕓🕔🕕🕖🕗🕘🕙🕚🕛🚶🚆🚄🚌🚇🚋🚗🚲]"
    r"|(?:נשמר|נשמרה|נוצרה|נוצרו|תוזמנ|reminder set|scheduled)\b"
    r"|לצאת עד|הגעה עד|leave by|arrive by"
    r"|(?:מחר|מחרתיים|היום|\btomorrow\b|\btoday\b)[^\n]*?\b\d{1,2}[./]\d{1,2}\b",
    re.IGNORECASE)


# The internal "[26/07 13:00]" marker _stamp prepends so the model can date past
# turns. It is CONTEXT, never Lumi's voice — but the model kept copying it into its
# own replies (users saw a doubled "[02/08 22:47] [02/08 22:47] *מחר…*"). We strip
# every echo of it from stored content before restamping and from the outgoing reply.
_STAMP_RE = re.compile(r"\[\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2}\]\s*")


def _stamp(turn: dict, text: str) -> str:
    """Prefix a USER turn with WHEN it was said ('[26/07 13:00] …') so the model
    doesn't read yesterday's '13:00' as now. ONLY user turns are stamped —
    stamping assistant turns taught the model to echo the bracket in its replies.
    Any stamp already baked into the text is stripped first so it never doubles.
    Turns written before `ts` existed pass through unstamped."""
    text = _STAMP_RE.sub("", text).strip()
    ts = turn.get("ts")
    if not isinstance(ts, str) or len(ts) < 16:
        return text
    return f"[{ts[8:10]}/{ts[5:7]} {ts[11:16]}] {text}"


def _sanitize_history(hist: list) -> list:
    """Strip clock/route/confirmation lines from PAST ASSISTANT turns before
    replaying them to the model. Those lines were often fabricated, and the
    model copies whatever it sees in history — so feeding them back
    re-generates the same fake reminder block. User turns keep their wording
    (it's the real intent) and carry a time stamp; assistant turns are NOT
    stamped (the model echoed the bracket). Any stamp baked into stored content
    is stripped so old contaminated turns don't compound.

    Returns plain {role, content} dicts — the `ts` bookkeeping key never
    reaches the LLM message list."""
    out = []
    for turn in hist:
        role = turn.get("role")
        content = turn.get("content")
        if not isinstance(content, str):
            out.append({"role": role, "content": content})
            continue
        content = _STAMP_RE.sub("", content).strip()  # drop any echoed stamp
        if role == "assistant":
            content = "\n".join(ln for ln in content.split("\n")
                                if not _HISTORY_NOISE_RE.search(ln)).strip()
            if not content:
                continue
            out.append({"role": role, "content": content})  # unstamped
        else:
            out.append({"role": role, "content": _stamp(turn, content)})
    return out


def _too_similar(a: str, b: str) -> bool:
    """True when two replies are effectively the same message. Hermes fell into
    a repetition attractor and re-emitted one canned block for EVERY input;
    comparing against the previous assistant turn is how we catch it."""
    import difflib
    na = " ".join((a or "").split())
    nb = " ".join((b or "").split())
    if not na or not nb:
        return False
    return na == nb or difflib.SequenceMatcher(None, na, nb).ratio() > 0.9


def _for_history(text: str) -> str:
    """The reply as it should be REMEMBERED: guard warnings stripped. Storing
    '⚠️ לא שמרתי כלום' taught the model to print it back every turn."""
    return "\n".join(ln for ln in (text or "").split("\n")
                     if not ln.lstrip().startswith("⚠️")).strip()


def _detect_language(text: str, default: str = "en") -> str:
    """Hebrew if the message contains Hebrew letters, else the stored default.
    Ignores non-Latin scripts (Russian, Thai, etc.) — those are content, not UI language."""
    clean = text or ""
    if any("א" <= ch <= "ת" for ch in clean):  # Hebrew alef–tav
        return "he"
    # Never infer language from Cyrillic, Thai, CJK etc. — trust stored preference
    return default


logger = logging.getLogger(__name__)

# --- Raw OpenAI client — used only by _extract_profile (forced tool_choice) ---
_raw_client: Optional[AsyncOpenAI] = None


def _get_raw_client() -> AsyncOpenAI:
    global _raw_client
    if _raw_client is None:
        _raw_client = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_ENDPOINT)
    return _raw_client


# ponytail: kept in OpenAI format solely for _extract_profile's forced tool_choice
_SAVE_TOOL = {
    "type": "function",
    "function": {
        "name": "save_profile",
        "description": (
            "Save what we learn about the user so future plans are accurate. "
            "Call whenever the user shares any of these details."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "home_address": {"type": "string"},
                "transport": {"type": "string", "enum": ["car", "bus", "walk", "bike"]},
                "morning_routine_minutes": {"type": "integer"},
                "routine_verified": {"type": "boolean"},
                "hobbies": {"type": "string"},
                "routines_notes": {"type": "string"},
                "mbti_type": {"type": "string"},
                "onboarded": {"type": "boolean"},
            },
        },
    },
}

# --- agent singletons ---
# Keyed by model id: model_router may hand back a different tier from one turn
# to the next (a long prompt, or the monthly budget tightening), and a single
# cached client would pin the first model chosen since boot.
_llm_by_model: dict[str, ChatOpenAI] = {}
# ponytail: no checkpointer — we store distilled memory, not raw history
_agent_cache: Optional[object] = None  # reuse compiled graph across requests


def get_graph_diagram() -> str:
    """Return the agent graph as a Mermaid string. Paste at mermaid.live to visualize."""
    tools = _make_tools("__preview__", "")
    agent = create_react_agent(_get_llm(), tools)
    try:
        return agent.get_graph().draw_mermaid()
    except Exception:
        return "graph TD\n  A[__start__] --> B[agent]\n  B --> C[tools]\n  C --> B\n  B --> D[__end__]"


def _get_llm(model: Optional[str] = None) -> ChatOpenAI:
    """The chat model for this turn. `model` comes from model_router; omitted
    (the graph-diagram preview) it falls back to the configured default."""
    name = model or config.LLM_MODEL
    if name not in _llm_by_model:
        _llm_by_model[name] = ChatOpenAI(
            model=name,
            base_url=config.LLM_ENDPOINT,
            api_key=config.LLM_API_KEY,
            max_tokens=600,
            temperature=0.4,
        )
    return _llm_by_model[name]


_retry_llm_by_model: dict[str, ChatOpenAI] = {}


def _get_retry_llm(model: Optional[str] = None) -> ChatOpenAI:
    """Different sampling for the degenerate-output retry. Qwen's failure mode
    is a repetition loop (Thai/CJK garbage) — retrying with IDENTICAL params
    mostly reproduces it. Higher temperature + repetition penalties break the
    loop; only used after _is_degenerate flagged the first attempt."""
    name = model or config.LLM_MODEL
    if name not in _retry_llm_by_model:
        _retry_llm_by_model[name] = ChatOpenAI(
            model=name,
            base_url=config.LLM_ENDPOINT,
            api_key=config.LLM_API_KEY,
            max_tokens=600,
            temperature=0.7,
            presence_penalty=0.5,
            frequency_penalty=0.5,
        )
    return _retry_llm_by_model[name]


def _make_tools(phone: str, content: str, wa_phone: Optional[str] = None) -> list:
    """Return @tool functions with phone + content captured for this request.
    `wa_phone` is the user's REAL WhatsApp number (phone may be a DB user id) —
    needed as the owner/notification address for scheduled outgoing messages."""
    owner_phone = wa_phone or phone

    @tool
    async def infer_task_details(
        task_text: str,
        category: str = "general",
        priority: str = "need_to",
        duration_minutes: int = 30,
        fixed_time: Optional[str] = None,
        location: Optional[str] = None,
        date: Optional[str] = None,
    ) -> dict:
        """Extract a task from the message: category, priority, duration (minutes), fixed time, location, and date (YYYY-MM-DD, defaults to today). For study/learning/coding tasks duration_minutes must be at least 180.

        location: pass the PLACE NAME / company / venue as the user said it ('MER
        Group', 'נביוס', 'Azrieli Sarona') — NOT a street you guessed. The real
        address is looked up automatically; a guessed street lands in the wrong city."""
        resolved = location
        place_coords: dict = {}
        if location:
            try:
                place = await geo.find_place(location)
                if place and place.get("formatted"):
                    resolved = place["formatted"]     # authoritative Places address
                    # KEEP THE COORDINATES. They were being thrown away one line
                    # after being fetched, and that is the whole reason a yoga
                    # class at צ׳ארלס קלור reached the phone as an address with
                    # no position: the name resolved, the street was right, and
                    # the app had nothing to put on the map. Every downstream
                    # site then invented 0,0 (see src/utils/placeCoords), which
                    # is in the Atlantic, so the pin was correctly refused and
                    # the map stayed empty. Google already told us where it is.
                    if place.get("lat") is not None and place.get("lng") is not None:
                        place_coords = {
                            "lat": place["lat"],
                            "lng": place["lng"],
                            # What SHE called it. The formatted address is
                            # authoritative for routing and unrecognisable on a
                            # card: "11א, Kaufmann Street" is not a yoga studio
                            # she has ever heard of.
                            "displayName": place.get("name") or location,
                        }
            except Exception:  # noqa: BLE001 — never fail task capture on a lookup
                pass

        # The label is a lookup, not a language problem. categorize.merge lets
        # the keyword table win whenever it matched (Hebrew and English alike)
        # and keeps the model's guess only for text the table has no opinion
        # about — so "ראיון" can no longer come back as 'leisure' because the
        # model was in a hurry, and the 3h study floor is applied by the same
        # code that builds the day rather than by a sentence in the prompt.
        text = task_text or content
        labelled = categorize.merge(text, {
            "category": category,
            "priority": priority,
            "duration_minutes": duration_minutes,
        })
        if day_schedule.is_study({"text": text, "category": labelled["category"]}):
            labelled["duration_minutes"] = max(labelled["duration_minutes"],
                                               day_schedule.MIN_STUDY_BLOCK_MINUTES)
        return {
            "text": text,
            "category": labelled["category"],
            "priority": labelled["priority"],
            "duration_minutes": labelled["duration_minutes"],
            "fixed_time": fixed_time,
            "location": resolved,
            # Only present when Places actually placed it — an absent key means
            # "unknown", which the app can act on. A zeroed one cannot be told
            # apart from a real coordinate, which is the bug this closes.
            **({"place": place_coords} if place_coords else {}),
            "date": date,
        }

    @tool
    async def save_profile(
        name: Optional[str] = None,
        home_address: Optional[str] = None,
        transport: Optional[str] = None,
        morning_routine_minutes: Optional[int] = None,
        routine_verified: Optional[bool] = None,
        hobbies: Optional[str] = None,
        routines_notes: Optional[str] = None,
        mbti_type: Optional[str] = None,
        onboarded: Optional[bool] = None,
    ) -> dict:
        """Save what we learn about the user so future plans are accurate. Call whenever the user shares any of these details.

        routines_notes: standing habits and obligations IN HER WORDS — 'gym Mon/Wed
        18:00', 'kids at 16:00 every day', 'I can\'t do mornings'. These never appear
        as tasks, and they are the reason an otherwise valid plan is wrong. Save them
        verbatim the moment she mentions one, appending to what is already there."""
        prof = user_profile.update_profile(
            phone,
            name=name,
            homeAddress=home_address,
            transportType=transport,
            morningRoutineMinutes=morning_routine_minutes,
            routineVerified=routine_verified,
            hobbies=hobbies,
            routinesNotes=routines_notes,
            mbtiType=mbti_type,
            onboarded=onboarded,
        )
        return {"ok": True, "saved": prof, "still_missing": user_profile.missing_fields(phone)}

    @tool
    async def plan_departure(
        destination: str,
        arrival_time: str,
        task_date: Optional[str] = None,
        from_current: bool = False,
        start_address: Optional[str] = None,
        start_confirmed: bool = False,
        transport: Optional[str] = None,
    ) -> dict:
        """Compute travel time + wake/leave times for a located, time-fixed appointment.
        task_date: YYYY-MM-DD of the appointment — REQUIRED. Only say 'leave now' if task_date is TODAY.
        For future dates return the plan info calmly, never with urgency.

        START POINT — NEVER assume the user leaves from home:
        - start_address: pass it if the user named where they'll leave FROM ('from the office').
        - from_current=true: user shared their live location / said they're already out.
        - start_confirmed=true: ONLY after the user explicitly confirmed 'from home' (or
          you asked and they answered). If none of the three, this tool refuses and tells
          you to ask 'from home, or somewhere else? (you can share a location 📍)'.

        TRANSPORT — offer the default, never silently decide:
        - transport: 'bus' | 'train' | 'car' | 'walk' | 'bike'. Pass it when the user
          said how they travel THIS trip.
        - Public transport (bus/train): the plan comes back with plan.alternatives —
          BOTH the bus and the train option, each with travelMinutes + leaveBy.
          The main plan is the fastest one.
        - If omitted, their profile default is used and the result is tagged
          usedDefaultTransport=true → you MUST tell the user which mode you assumed and
          ask if they're going a different way this time."""
        prof = user_profile.get_profile(phone)
        home = prof.get("homeAddress")
        current = prof.get("currentAddress")
        use_current = bool(from_current and current) or (not home and current and not start_address)
        start = start_address or (current if use_current else None)
        if not start and not home:
            return {
                "ok": False,
                "need": "start",
                "message": "I have no start point yet — ask the user to share their location 📍 or say where they're leaving from.",
            }
        # Home is only a DEFAULT. Refuse until the user confirmed it (or named a start).
        if not start and not start_confirmed:
            return {
                "ok": False,
                "need": "start_confirmation",
                "message": (
                    f"Don't assume they leave from home ({home}). Ask ONE short question: "
                    "'Leaving from home, or somewhere else? You can also share your location 📍' "
                    "— then call again with start_confirmed=true or start_address."
                ),
            }
        used_default_transport = transport is None
        resolved_transport = transport or prof.get("transportType")
        if not resolved_transport:
            return {
                "ok": False,
                "need": "transport",
                "message": "How do you get there — bus 🚌, car 🚗, walk 🚶, or bike 🚲?",
            }
        result = await geo.plan_departure(
            destination=destination,
            arrival_hhmm=arrival_time,
            home_address=home,
            transport=resolved_transport,
            routine_minutes=prof.get("morningRoutineMinutes", 45),
            buffer_minutes=prof.get("wakeBufferMinutes", 10),
            start_address=start,
        )
        if isinstance(result.get("plan"), dict):
            result["plan"]["usedDefaultTransport"] = used_default_transport
        # Tag whether this is today so the agent doesn't say "leave now" for future tasks.
        # Israel-local "today" — the server clock is UTC, so a naive date.today()
        # lags by up to 3h right after Israel midnight (same bug class as reminders.py).
        from tz import today_il
        today = today_il().isoformat()
        result["is_today"] = (task_date == today) if task_date else False
        result["task_date"] = task_date or today
        # Carry the appointment DATE onto the plan so reminders fire on the right
        # day — not today. Without this the date is lost when departures are built.
        if isinstance(result.get("plan"), dict):
            result["plan"]["date"] = task_date or today
        return result

    async def _fetch_task_rows(date_from: str, date_to: str) -> list:
        """Shared task fetch for get_my_tasks/find_task/build_day_schedule.

        The implementation moved to task_store so the app's endpoints read rows
        through the SAME function instead of growing a second copy of it."""
        return await task_store.fetch_task_rows(phone, date_from, date_to)

    @tool
    async def build_day_schedule(date: str, wake_time: str = "08:00",
                                 important_only: bool = False) -> list:
        """Lay a day's saved tasks on a timeline: returns each task with the clock time it should start at, in order.
        Use this whenever the user asks to plan / build / re-optimise a day ("סדרי לי את היום", "what's my plan for Thursday").
        date: YYYY-MM-DD. Fixed-time tasks keep their time, the rest fill forward from now (or wake_time), study blocks get 3h.
        NEVER order a day yourself — the returned order is the answer, just say it back in one short sentence."""
        rows = await _fetch_task_rows(date, date)
        from tz import today_il, now_il
        now = now_il().strftime("%H:%M") if date == today_il().isoformat() else None
        return day_schedule.build_day_schedule(
            rows, wake_time=wake_time, now=now,
            important_only=important_only, today=date)

    @tool
    async def find_clashes(date: str) -> list:
        """Find collisions in a day and what could be done about each: two tasks overlapping, or two places too far apart for the gap between them.
        date: YYYY-MM-DD. Use when the user asks whether a day works, or before confirming a new task on a busy day.
        Returns each clash with ready-made options (attend-remotely / move / keep-both / shorten / choose) — say them back, do NOT invent your own.
        When the only option kind is 'choose', there is no tidy answer: ASK which matters more, never decide for her."""
        rows = await task_store.fetch_task_rows(phone, date, date)
        found = _clashes.resolve_clashes(rows)
        # The tasks themselves are already in the conversation; sending them
        # back whole would triple the tool output for nothing.
        return [{
            "overlap_minutes": c["overlapMinutes"],
            "travel_shortfall": c["travelShortfall"],
            "question": c["questionHe"] if (user_profile.get_profile(phone).get("language") or "he") == "he"
                        else c["questionEn"],
            "options": [{"kind": o["kind"], "task_id": o["taskId"], "new_time": o.get("newTime"),
                         "label": o["labelHe"] if (user_profile.get_profile(phone).get("language") or "he") == "he"
                                  else o["labelEn"]}
                        for o in c["options"]],
        } for c in found]

    @tool
    async def get_my_tasks(date_from: str, date_to: str) -> list:
        """Fetch all the user's saved tasks for a date range (YYYY-MM-DD). Use to build a weekly schedule or show what's planned."""
        return await _fetch_task_rows(date_from, date_to)

    @tool
    async def find_task(query: str) -> list:
        """Find the user's EXISTING tasks matching some words (Hebrew or English), e.g. 'gym', 'the doctor appointment'.
        ALWAYS call this first when the user wants to change, move, complete or cancel a task they already have —
        then pass the returned id to update_task. Searches last week through next 60 days."""
        from datetime import timedelta as _td
        from tz import today_il
        today = today_il()
        rows = await _fetch_task_rows((today - _td(days=7)).isoformat(), (today + _td(days=60)).isoformat())
        words = [w for w in str(query).lower().split() if len(w) > 1]
        scored = []
        for r in rows:
            text = str(r.get("text", "")).lower()
            score = sum(1 for w in words if w in text)
            if score:
                scored.append((score, r))
        scored.sort(key=lambda x: -x[0])
        return [
            {"id": r.get("id"), "text": r.get("text"), "date": r.get("date"),
             "fixed_time": r.get("fixed_time"), "status": r.get("status")}
            for _, r in scored[:5]
        ]

    @tool
    async def update_task(
        task_id: str,
        text: Optional[str] = None,
        date: Optional[str] = None,
        fixed_time: Optional[str] = None,
        duration_minutes: Optional[int] = None,
        priority: Optional[str] = None,
        status: Optional[str] = None,
        deadline: Optional[str] = None,
    ) -> dict:
        """Change an EXISTING task by its id (get the id from find_task). Pass ONLY the fields that change.
        Completing → status='complete'. Cancelling → status='moved'. Moving to another day → date (YYYY-MM-DD).
        New time → fixed_time (HH:MM). Adding/changing a due date ('ההגשה עד 26.7', 'due by X') →
        deadline (YYYY-MM-DD, resolve via calculate_date first). NEVER use infer_task_details for a task
        the user already has — that forks a duplicate."""
        patch = {
            k: v
            for k, v in {
                "text": text, "date": date, "fixed_time": fixed_time,
                "duration_minutes": duration_minutes, "priority": priority,
                "status": status, "deadline": deadline,
            }.items()
            if v is not None
        }
        if not patch:
            return {"ok": False, "error": "no fields to change"}
        mem_entry = user_memory.update_task(phone, task_id, patch)
        if mem_entry:
            try:
                import session
                session.set_active_task(phone, task_id)  # editing a task focuses it
            except Exception:  # noqa: BLE001
                pass
        sb_ok = False
        try:
            uid = await supabase_tasks.user_id_for_phone(str(phone))
            if uid:
                sb_ok = await supabase_tasks.update_task(uid, str(task_id), patch)
        except Exception:  # noqa: BLE001
            pass
        ok = bool(mem_entry or sb_ok)
        if ok:
            return {"ok": True, "task": mem_entry or {"id": task_id, **patch}}
        # Say what to do next, not just what failed. The model reached here by
        # treating a brand-new request ("לדבר עם יניר מחר ב 16:00") as an edit
        # to whatever task was in focus; told only "not found", it announced
        # success anyway. Told to create instead, it has somewhere to go.
        return {
            "ok": False,
            "task": {"id": task_id, **patch},
            "error": (
                f"no task with id {task_id} exists — nothing was changed. "
                "If the user is describing something NEW, call infer_task_details "
                "to create it. If they meant an existing task, call find_task "
                "first to get a real id. Do NOT tell the user it was saved."
            ),
        }

    @tool
    async def check_availability(
        date: str,
        minutes: int,
        place: Optional[str] = None,
        start_time: Optional[str] = None,
    ) -> dict:
        """Can something of `minutes` length fit on `date` (YYYY-MM-DD) — optionally
        at `place` and at a specific `start_time` (HH:MM)?

        Use for "can I have a 2-hour meeting in Haifa on Tuesday at 14:00?", "יש לי
        זמן לפגישה של שעתיים בחיפה ב-3.9?" — ANY question about whether something
        FITS, as opposed to a request to create it. Resolve the date with
        calculate_date first.

        Returns {ok, date, busy, free_windows, verdict, conflicts, travel,
        routines_note} where verdict is 'fits' | 'clash' | 'no_travel_time' |
        'no_window'. travel holds the real Google minutes from whatever comes before
        it to `place`, and from `place` to whatever comes after — that is the half of
        the answer a calendar alone cannot give.

        routines_note is her standing week in her own words ('kids 16:00 every day').
        Those hours are NOT in busy — nobody writes the school run down as a task —
        so read it yourself and refuse a slot that lands on one, by name. State the
        verdict AND its reason; when it does not fit, offer the first free window."""
        prof = user_profile.get_profile(phone)
        day_start = prof.get("defaultWakeTime") or "08:00"
        day_end = prof.get("sleepTime") or "22:00"
        home = prof.get("homeAddress")
        transport = prof.get("transportType") or "car"

        def _mins(hhmm: str) -> int:
            h, m = str(hhmm)[:5].split(":")
            return int(h) * 60 + int(m)

        def _hhmm(total: int) -> str:
            return f"{total // 60 % 24:02d}:{total % 60:02d}"

        rows = [r for r in await _fetch_task_rows(date, date)
                if r.get("status") not in ("complete", "moved")]
        busy = []
        for r in rows:
            start = (r.get("fixed_time") or r.get("scheduled_time") or "")[:5]
            if not start or ":" not in start:
                continue
            busy.append({
                "text": r.get("text"),
                "start": start,
                "end": _hhmm(_mins(start) + int(r.get("duration_minutes") or 30)),
                "place": r.get("location") if isinstance(r.get("location"), str) else None,
            })
        busy.sort(key=lambda b: b["start"])

        # Free windows between the busy blocks, plus before the first and after
        # the last — the two places free time actually piles up.
        free = []
        cursor = _mins(day_start)
        for block in busy:
            if _mins(block["start"]) - cursor >= 15:
                free.append({"start": _hhmm(cursor), "end": block["start"]})
            cursor = max(cursor, _mins(block["end"]))
        if _mins(day_end) - cursor >= 15:
            free.append({"start": _hhmm(cursor), "end": day_end})

        async def _travel(from_place: Optional[str], to_place: Optional[str],
                          arrive_by: str) -> Optional[int]:
            if not from_place or not to_place or not config.GOOGLE_MAPS_API_KEY:
                return None
            if from_place.strip().lower() == to_place.strip().lower():
                return 0
            a, b = await geo.geocode(from_place), await geo.geocode(to_place)
            if not a or not b:
                return None
            route = await geo.directions(a, b, transport, arrive_by)
            return route["minutes"] if route else None

        travel: dict = {}

        if start_time:
            start_m = _mins(start_time)
            end_m = start_m + int(minutes)
            conflicts = [b for b in busy
                         if _mins(b["start"]) < end_m and _mins(b["end"]) > start_m]
            before = [b for b in busy if _mins(b["end"]) <= start_m]
            after = [b for b in busy if _mins(b["start"]) >= end_m]
            prev_block = before[-1] if before else None
            next_block = after[0] if after else None

            inbound = await _travel((prev_block or {}).get("place") or home, place, start_time)
            outbound = (await _travel(place, (next_block or {}).get("place") or home,
                                      next_block["start"]) if next_block else None)
            travel = {"to_place_minutes": inbound, "from_place_minutes": outbound}

            reasons = []
            if conflicts:
                reasons.append(f"clashes with {conflicts[0]['text']} at {conflicts[0]['start']}")
            if prev_block and inbound is not None and _mins(prev_block["end"]) + inbound > start_m:
                reasons.append(
                    f"{prev_block['text']} ends {prev_block['end']} and the trip takes {inbound} min")
            if next_block and outbound is not None and end_m + outbound > _mins(next_block["start"]):
                reasons.append(
                    f"could not reach {next_block['text']} at {next_block['start']} ({outbound} min away)")

            verdict = "fits" if not reasons else ("clash" if conflicts else "no_travel_time")
            return {
                "ok": True, "date": date, "verdict": verdict, "conflicts": reasons,
                "busy": busy, "free_windows": free, "travel": travel,
                "routines_note": prof.get("routinesNotes") or None,
                "asked_for": {"start": start_time, "end": _hhmm(end_m), "place": place},
            }

        inbound = await _travel(home, place, day_start)
        travel = {"to_place_minutes": inbound}
        need = int(minutes) + 2 * (inbound or 0)
        options = [w for w in free if _mins(w["end"]) - _mins(w["start"]) >= need]
        return {
            "ok": True, "date": date,
            "verdict": "fits" if options else "no_window",
            "conflicts": [], "busy": busy,
            "free_windows": options or free, "travel": travel,
            "routines_note": prof.get("routinesNotes") or None,
            "asked_for": {"minutes": minutes, "place": place},
        }

    @tool
    async def calculate_date(expression: str) -> dict:
        """Resolve a relative date expression to the EXACT calendar date, Israel time.
        Handles: today/tomorrow/day after tomorrow, 'in N days', 'next week', weekday
        names, and explicit day.month like '21.7' — English AND Hebrew (היום, מחר,
        מחרתיים, בעוד N ימים, שבוע הבא, יום שני, 21.7).
        ALWAYS call this BEFORE saving/updating a task or scheduling a message when
        the user used a relative date — NEVER compute or guess dates yourself.
        Returns {date: YYYY-MM-DD, weekday, days_from_today}."""
        # Delegates to tz.resolve_date — the SAME parser main.py uses to override
        # a hallucinated task date, so tool and guard can never disagree.
        from tz import today_il, resolve_date, weekday_label
        today = today_il()
        target = resolve_date(expression, today)
        if target is None:
            return {"error": f"couldn't parse '{expression}' — ask the user for the exact date"}
        return {"date": target.isoformat(), "weekday": weekday_label(target),
                "days_from_today": (target - today).days}

    @tool
    async def schedule_message(
        recipient_name: str,
        message: str,
        send_date: str,
        send_time: str,
        recipient_phone: Optional[str] = None,
    ) -> dict:
        """Schedule a WhatsApp message Lumi sends TO SOMEONE ELSE at a future moment
        ('write to אימוש happy birthday on 2026-07-25 at 09:00').
        send_date: YYYY-MM-DD (resolve 'tomorrow' etc. first). send_time: HH:MM.
        recipient_phone: pass it if the user typed a number; otherwise the saved
        contact (from a shared contact card) is used. If neither exists, this returns
        need='contact' — ask the user to share the contact (📎 → Contact) or type the
        number. At send time the user gets a confirmation (or the text to forward if
        WhatsApp refuses delivery)."""
        number = "".join(ch for ch in str(recipient_phone or "") if ch.isdigit())
        if number:
            user_memory.save_contact(owner_phone, recipient_name, number)
        else:
            found = user_memory.find_contact(owner_phone, recipient_name)
            number = (found or {}).get("number", "")
        if not number:
            return {
                "ok": False,
                "need": "contact",
                "message": (
                    f"No saved number for '{recipient_name}'. Ask the user to share the "
                    "contact card (📎 → Contact) or type the phone number."
                ),
            }
        ok = reminders.schedule_outgoing(
            owner_phone, number, send_time, send_date, message, recipient_name)
        if not ok:
            return {"ok": False,
                    "message": "Couldn't schedule — is the date/time in the future (YYYY-MM-DD / HH:MM)?"}
        return {"ok": True, "recipient": recipient_name, "number": number,
                "when": f"{send_date} {send_time}", "message": message}

    @tool
    async def save_memory(kind: str, insight: str) -> dict:
        """Remember something about this user for future conversations.
        kind: 'behavior' (e.g. 'studies late at night'), 'preference' (e.g. 'wants 3h coding blocks'),
        or 'routine' (e.g. 'wakes at 07:30 on weekdays').
        Call this whenever you notice a pattern, preference, or routine — not for one-off events."""
        user_memory.add_insight(phone, kind, insight)
        return {"saved": True, "kind": kind, "insight": insight}

    @tool
    async def set_reminder(text: str, time: str, date: Optional[str] = None) -> dict:
        """Set a WhatsApp reminder TO THE USER themselves at HH:MM (Israel) on date
        YYYY-MM-DD (omit = today; 'מחר'/'tomorrow' → calculate_date FIRST, pass its date).
        THE tool for every 'תזכירי לי' / 'remind me to X at Y'. Several times ('גם ב-9
        וגם ב-10') → one call per time. Returns ok=false if that moment already passed —
        the response includes now_israel: RETRY IMMEDIATELY with a future time (e.g.
        now+30min rounded), don't just apologize. NEVER claim a reminder exists
        without ok=true."""
        ok = reminders.schedule(owner_phone, time, f"⏰ {text}", day=date)
        if ok:
            return {"ok": True}
        from datetime import timedelta as _td
        from tz import now_il as _now_il
        _now = _now_il()
        nxt = _now + _td(minutes=30)
        return {"ok": False,
                "error": f"'{time}' already passed (or duplicate)",
                "now_israel": _now.strftime("%H:%M"),
                "suggestion": f"retry with a FUTURE time, e.g. {nxt.strftime('%H:%M')}"}

    @tool
    async def list_reminders() -> list:
        """Every reminder ALREADY scheduled for this user, upcoming only, as
        [{time, text}]. Call it BEFORE claiming any reminder exists and before
        set_reminder (so you don't double-book the same minute). If the list is
        empty, nothing is scheduled — say so, don't invent one."""
        return reminders.pending_for(owner_phone)

    @tool
    async def web_search(query: str, num: int = 5, recent_days: int = 0) -> dict:
        """Search the live web and return [{title, link, snippet}].

        THE tool for anything you don't know: current job posts, what a
        technology is, news, prices, opening hours. Use it instead of saying you
        have no internet access. Report ONLY what the snippets say and link the
        source — never fill gaps from memory, and never invent a URL: any link
        you didn't get from here is stripped from the reply before it is sent.

        recent_days: set it (e.g. 30, 180) when only RECENT matters — "what
        happened at this company lately", "did anything change since we spoke".
        It switches the search to news and drops anything older. Leave it 0 for
        the normal case; a background fact is not news and filtering by date
        would hide the best source."""
        num = max(1, min(int(num or 5), 10))
        days = max(0, min(int(recent_days or 0), 365))

        # Tavily first: it returns cleaned page text rather than click-bait
        # snippets, and it is not capped at 100 queries/day.
        if tavily_search.is_configured():
            res = await tavily_search.search(
                query, max_results=num,
                topic="news" if days else "general",
                days=days or None)
            if res.get("ok"):
                return {"ok": True, "query": query, "source": "tavily",
                        "results": [{"title": r["title"], "link": r["link"],
                                     "snippet": r["snippet"]} for r in res["results"]]}
            # Fall through to Google rather than telling the user we are blind.
            logger.warning("tavily unavailable (%s) — falling back to Google",
                           res.get("error"))

        if not (config.GOOGLE_SEARCH_API_KEY and config.GOOGLE_CSE_ID):
            return {"ok": False, "error": "search_not_configured",
                    "message": "Web search isn't set up — say you can't look it up right now."}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://www.googleapis.com/customsearch/v1",
                    params={"key": config.GOOGLE_SEARCH_API_KEY,
                            "cx": config.GOOGLE_CSE_ID, "q": query,
                            "num": num})
            if resp.status_code != 200:
                # 429 = the free 100/day quota is spent; the agent must say so,
                # not silently answer from its weights.
                logger.warning("web_search HTTP %s: %s", resp.status_code, resp.text[:200])
                return {"ok": False, "error": f"http_{resp.status_code}",
                        "message": "Search is unavailable right now — tell the user you couldn't look it up."}
            items = resp.json().get("items") or []
        except Exception as exc:  # noqa: BLE001 — network flake, never crash the turn
            logger.warning("web_search failed: %s", exc)
            return {"ok": False, "error": "unreachable"}
        return {"ok": True, "query": query, "source": "google",
                "results": [{"title": it.get("title"), "link": it.get("link"),
                             "snippet": it.get("snippet")} for it in items]}

    @tool
    async def read_page(url: str) -> dict:
        """Read ONE web page in full and return its cleaned text.

        web_search gives you a snippet. This gives you the page. Use it when
        the snippet is not enough and the detail matters: the full text of a
        job description, a company's About page, the body of an announcement.

        Pass a URL you got from web_search — never one you composed yourself.
        Returns {ok, url, text}; the text is trimmed, so quote from it rather
        than reciting it."""
        if not tavily_search.is_configured():
            return {"ok": False, "error": "search_not_configured",
                    "message": "I can't open pages right now — say so."}
        if not str(url or "").startswith(("http://", "https://")):
            return {"ok": False, "error": "bad_url",
                    "message": "That isn't a URL I can open."}
        res = await tavily_search.extract([url])
        if not res.get("ok"):
            return {"ok": False, "error": res.get("error", "unreachable"),
                    "message": "I couldn't open that page — tell the user."}
        pages = res.get("pages") or []
        if not pages or not pages[0].get("text"):
            return {"ok": False, "error": "empty",
                    "message": "That page had nothing readable on it."}
        return {"ok": True, "url": pages[0]["url"], "text": pages[0]["text"][:6000]}

    @tool
    async def place_live_info(place: str, address: str = "") -> dict:
        """What the web says about a place TODAY: opening hours, and whether it
        has closed down.

        find_place tells you WHERE somewhere is — and it will happily return a
        perfectly good address for a clinic that shut last year. Call this
        before sending her across town: when she asks whether she will make it
        before closing, when a place is one she has not been to in months, or
        when anything about it looks stale.

        Returns {ok, answer, closed_hint, results}. `closed_hint` is a HINT
        from the wording of the snippets — say "it looks like it may have
        closed, worth calling", never "it is closed"."""
        if not tavily_search.is_configured():
            return {"ok": False, "error": "search_not_configured"}
        if not str(place or "").strip():
            return {"ok": False, "error": "no_place"}
        return await tavily_search.place_facts(place.strip(), address=str(address or "").strip())

    @tool
    async def find_place(query: str) -> dict:
        """Look up WHERE a place or business is by NAME ('MER Group', 'עיריית
        אור יהודה', 'Azrieli Sarona') and get its REAL address + coordinates.

        THE tool for 'where is X'. Use it before stating any address — never
        write one from memory (that put a Tel Aviv firm in the wrong city). If
        it returns ok:false, say you couldn't find the address and ask the user,
        do NOT guess. Feed the returned `formatted` address into plan_departure."""
        place = await geo.find_place(query)
        if not place:
            return {"ok": False, "query": query,
                    "message": "Couldn't find that place — ask the user for the address, don't invent one."}
        return {"ok": True, "name": place.get("name"),
                "address": place.get("formatted"),
                "lat": place.get("lat"), "lng": place.get("lng")}

    @tool
    async def create_agent(
        name: Optional[str] = None,
        soul: Optional[str] = None,
        days: Optional[list] = None,
        time: Optional[str] = None,
        emoji: str = "🤖",
        template: Optional[str] = None,
        watch: Optional[str] = None,
    ) -> dict:
        """Create a PERSONAL AGENT for the user — a mini-assistant that runs on a schedule
        and messages them on WhatsApp (e.g. a morning day-planner, a bedtime alarm coach).
        Call this DIRECTLY when the user asks to install/create — never refuse because
        list_my_agents is empty (empty is the normal starting state).
        Templates (pass template; name/soul/days pre-filled):
        'morning_planner' — 🌅 day brief with real routes; 'smart_alarm' — ⏰ evening
        bedtime+wake calculator that sets the wake reminder. Template times (07:00 /
        21:30) are DEFAULTS — pass time='HH:MM' to fit the user's own routine.
        Custom agent: pass name, soul (its personality+job description), days
        (list of weekday ints, Monday=0 .. Sunday=6) and time (HH:MM, Israel).
        watch: a search query this agent re-runs live every time it fires, e.g.
        'Ceva NPU news' or 'Tel Aviv AI meetups'. Pass it whenever the user
        wants to be KEPT UP TO DATE on something — without it an agent can only
        repeat what we already know and has no news to report.
        Max 5 agents per user. Returns the created agent or {'error': ...}."""
        return agents_store.create_agent(
            phone, name=name, soul=soul, days=days, time=time,
            emoji=emoji, template=template, watch=watch, created_via="whatsapp")

    @tool
    async def list_my_agents() -> list:
        """List the user's personal agents: id, name, schedule, enabled, next run time.
        Use before updating/deleting, or when the user asks 'what agents do I have?'."""
        return [
            {"id": a["id"], "name": a["name"], "emoji": a.get("emoji"),
             "schedule": a.get("schedule"), "enabled": a.get("enabled"),
             "next_run": a.get("next_run"), "template": a.get("template")}
            for a in agents_store.list_agents(phone)
        ]

    @tool
    async def update_my_agent(
        agent_id: str,
        enabled: Optional[bool] = None,
        days: Optional[list] = None,
        time: Optional[str] = None,
        soul: Optional[str] = None,
        name: Optional[str] = None,
        watch: Optional[str] = None,
    ) -> dict:
        """Change an existing personal agent by id (from list_my_agents). Pass ONLY what
        changes: enabled=false pauses it, days/time reschedule it, soul rewrites its job,
        watch='...' sets the live topic it follows (watch='' stops following)."""
        patch = {"enabled": enabled, "days": days, "time": time, "soul": soul, "name": name}
        if watch is not None:          # '' is meaningful: stop watching
            patch["watch"] = watch
        upd = agents_store.update_agent(phone, agent_id, patch)
        return upd or {"error": "not_found"}

    @tool
    async def delete_my_agent(agent_id: str) -> dict:
        """Permanently delete one of the user's personal agents by id (from list_my_agents)."""
        ok = agents_store.delete_agent(phone, agent_id)
        return {"ok": ok} if ok else {"error": "not_found"}

    @tool
    async def send_app_link() -> dict:
        """Call when the user wants to finish the personality quiz in the Lumi app instead of
        over WhatsApp (e.g. they say 'let me do it in the app' or 'send me a link'). Issues a
        one-time link that opens the app already knowing who they are, valid for 10 minutes.
        Returns ok=False if unavailable — tell the user to continue here in chat instead."""
        try:
            handoff = await personality_handoff.issue_handoff(phone)
            return {"ok": True, "link": handoff["deep_link"]}
        except Exception:  # noqa: BLE001 — DB unavailable or phone isn't a real user id yet
            return {"ok": False}

    return [infer_task_details, save_profile, plan_departure, build_day_schedule, find_clashes, get_my_tasks,
            find_task, update_task, check_availability, calculate_date, schedule_message, set_reminder,
            list_reminders, web_search, read_page, place_live_info, find_place,
            save_memory, create_agent,
            list_my_agents, update_my_agent, delete_my_agent, send_app_link]


def _onboarding_block(profile: Optional[dict], missing: list) -> str:
    if not profile:
        return ""
    if not missing and profile.get("mbtiType"):
        return ""
    lines = ["\nONBOARDING (SECONDARY — never let it delay the actual answer):"]
    lines.append(
        "When the user reveals ANY detail — name, a hobby, home address, transport, "
        "morning-routine length — call save_profile with those fields in the SAME turn. "
        "But ALWAYS answer their task first; onboarding is a tiny add-on, never the "
        "whole reply."
    )
    if missing:
        lines.append(
            "Still unknown: " + "; ".join(missing) + ". You may ask for ONE of these as "
            "a short P.S. AFTER delivering the plan — never instead of it, and never "
            "more than one per message. If you can plan without it, just plan."
        )
    if not profile.get("mbtiType"):
        lines.append(
            "Also OFFER (once) a quick personality quiz: 'Want a 4-question vibe check "
            "so I plan the way you like? 😊'. IMPORTANT: check the conversation so far — "
            "if you ALREADY offered it and the user said yes/sure/כן, DO NOT offer again; "
            "immediately ask the FIRST question. Ask the 4 either/or questions ONE AT A "
            "TIME (energy: people vs alone; focus: details vs big-picture; decisions: "
            "logic vs feelings; planning: set plan vs go-with-flow), wait for each "
            "answer, then save_profile(mbti_type) with the inferred 4-letter type. "
            "If they'd rather do it in the app, call send_app_link and share the link it returns."
        )
    if profile.get("currentAddress"):
        lines.append(
            f"NOTE: the user already shared their current location ({profile['currentAddress']}). "
            "Don't ask 'what's your home address' just to plan — offer to route from "
            "their current spot (from_current=true), and only ask for home if they want "
            "a morning wake-up plan."
        )
    return "\n".join(lines) + "\n"


# ─── the invariant half of the system prompt ────────────────────────────────
#
# Everything here is identical for every user and every turn, so it is built
# ONCE at import and always emitted FIRST. That ordering is the whole point:
# providers cache a prompt by its longest stable PREFIX, and the per-turn lines
# — the clock ("time now 21:47"), the user's name, today's date — used to sit
# at the top, which meant the ~20KB of rules behind them missed the cache on
# every single message. Nothing was cached because nothing in front of it was
# stable.
#
# Moving the variable lines to the END costs nothing in meaning (the one
# "above" in this text refers to the conversation, not to the prompt) and puts
# the language lock and the personality closest to the user's message, which is
# where an instruction is followed best anyway.
#
# So: if you add a line here it must be true for EVERYBODY. Anything naming the
# user, the date, the profile or the time belongs in the tail inside
# _system_prompt.
_STATIC_RULES = (
        "You are Lumi, a warm, personality-aware task assistant on WhatsApp.\n"
        "Your job: turn short messages into tasks and reply warmly and briefly.\n"
        "DATES — NEVER GUESS: any relative date ('מחר', 'tomorrow', 'in 2 days', "
        "'מחרתיים', 'ביום שני', '21.7') → call calculate_date FIRST and use ITS "
        "result in infer_task_details / update_task / schedule_message. When you "
        "confirm back, state the resolved date + weekday ('מחר, יום שלישי 21.7'). "
        "Getting 'tomorrow' wrong ruins the user's schedule — the tool, always.\n"
        "If the message describes something NEW to do, call infer_task_details, then confirm.\n"
        "EDIT, DON'T DUPLICATE: if the user changes/moves/completes/cancels a task they "
        "ALREADY have ('move the gym to 18:00', 'סיימתי עם הרופא', 'cancel tomorrow's "
        "meeting') → call find_task with the task's words, then update_task with the "
        "matched id and ONLY the changed fields. infer_task_details there would fork a "
        "duplicate. If find_task returns several, ask ONE short which-one question.\n"
        "SEND-LATER MESSAGES: 'write to X happy birthday on <date> at <time>' / "
        "'תשלחי ל-X מזל טוב מחר ב-9' → resolve the date (calculate it, never guess), "
        "then call schedule_message. If it returns need='contact', ask the user to "
        "share the contact card (📎 → Contact) or type the number — a shared card is "
        "saved for next time. Confirm back in ONE short line: "
        "'🕘 Will message אימוש on Fri 25/7 at 09:00 ✓'.\n"
        "DELETE / CANCEL A TASK: 'delete this task', 'תמחקי את המשימה', 'למחוק את "
        "המשימה של הראיון' → find_task with the task's words (or, for 'this task', "
        "the task most recently discussed in this conversation), then "
        "update_task(task_id, status='moved') and confirm in ONE short line: "
        "'נמחק ✓ ראיון עבודה'. NEVER answer a delete request with a question about "
        "something else, and never ask them to repeat — if unsure WHICH task, list "
        "the 1-3 candidates and ask which.\n"
        "QUOTED / PASTED MESSAGES: users often reply to (or paste) an earlier "
        "message and add their instruction at the end. The pasted part is CONTEXT "
        "identifying the task — the actual request is the NEW text (usually the "
        "last line). Never re-save or re-plan the pasted content.\n"
        "SAME TASK, DIFFERENT WORDS: before creating a task that sounds like it may "
        "already exist ('interview tomorrow in Ramat Gan' when 'interview tomorrow, "
        "bring CV, Ramat Gan 11:30' is saved) — call find_task with its key words. "
        "A close match on the same/nearby date IS the same task: update_task with the "
        "NEW details (time, place, prep) instead of creating. Not sure? Ask ONE short "
        "question: 'Same interview as the one tomorrow, or a new one?' — never "
        "silently create a near-duplicate.\n"
        "FULL-DAY PLANNING — when ONE message lists SEVERAL appointments "
        "('tomorrow: interview 11:30, home assignment, 18:00 Nebius, 19:30 מפגש "
        "בהתחייה 14'):\n"
        "1) calculate_date once, then infer_task_details for EACH item separately — "
        "every appointment becomes its OWN task with its date.\n"
        "2) Reply first with the whole day in order, one line per item, category "
        "emoji as its color + time range (estimate sensible durations: interview "
        "≈2h; fit flexible work between fixed items):\n"
        "   🎯 11:30–13:30 ראיון\n   💼 14:00–17:30 מטלת בית\n"
        "   🤝 18:00–19:30 Nebius\n   🌊 19:50–22:00 מידברן, התחייה 14\n"
        "3) Then ask ONE question at a time, appointment by appointment, for every "
        "missing detail: where is it ('איפה הראיון? אולי כתוב ביומן/במייל 📅')? how "
        "will you get there (🚌/🚆/🚗/🚲)? from where?\n"
        "   NEVER RE-ASK WHAT WAS GIVEN: if the message already contains a place or "
        "address (a street, a company/venue name, a city), pass it to "
        "infer_task_details(location=…) and confirm it back — do NOT ask 'where is "
        "it?' about a location the user just told you. Only ask 'where' when it is "
        "genuinely absent. (If unsure a NAME is a real place, call find_place first.)\n"
        "4) TRAVEL CHAINS: back-to-back appointments travel FROM THE PREVIOUS "
        "appointment's address — call plan_departure with start_address=<previous "
        "location> (e.g. Nebius יצחק שדה 6 → התחייה 14), NOT from home. Only the "
        "first trip of the day starts at home.\n"
        "5) Every located+timed appointment gets plan_departure → real reminders; "
        "an hour before each one the user is automatically asked to share their "
        "live location 📍 so the route is computed from wherever they actually are.\n"
        "OUT-OF-HOME = ROUTE, ALWAYS: any task with a place that is NOT the user's "
        "home and has a time is a TRAVEL task. As soon as you have its place + time, "
        "resolve the address (find_place if it's a name) and call plan_departure so "
        "the wake / start-getting-ready / leave-home alerts are set AHEAD of time — "
        "don't just offer, do it and confirm the leave-by time. Only skip the route "
        "if the user says it's a phone/Zoom call or already at home.\n"
        "FOCUS TASK — BE FULLY ENGAGED. An interview / exam / deadline / anything the "
        "user marks as important for today or tomorrow is THE focus task:\n"
        "- Repeat back its date + hour so it's locked ('Interview tomorrow 10:00 ✓').\n"
        "- If it has a place and time, OFFER the route now: 'Want me to plan the trip? "
        "🚌' — then plan_departure for ITS date, so wake/leave reminders are set.\n"
        "- On later messages that day, ASK how it's going ('How's the interview prep? "
        "💪') and add ONE short encouragement — still max 1-2 sentences total.\n"
        "- Words like 'today'/'מחר'/'tomorrow' in the task ALWAYS resolve to the "
        "actual date on the saved task — never leave the date ambiguous.\n"
        "PERSONAL AGENTS — the user can own up to 5 mini-assistants that run on a "
        "schedule and message them (a 'סוכן'/'agent').\n"
        "INSTALL = CREATE. 'תתקיני לי את סוכן הבוקר' / 'I want the smart alarm' → "
        "call create_agent(template='morning_planner') or "
        "create_agent(template='smart_alarm') IMMEDIATELY. An empty list_my_agents "
        "is NORMAL before install — it is never a reason to refuse or re-ask. "
        "Both in one message → two create_agent calls, same turn.\n"
        "SCHEDULE FITS THE USER — template times are only DEFAULTS (morning "
        "planner 07:00, smart alarm 21:30). PERSONALIZE: if memory/routines show "
        "when they wake or wind down, pass a matching time= to create_agent "
        "(e.g. wakes at 06:15 → morning planner at 06:15). After creating, "
        "confirm the time and invite adjustment in the SAME line: "
        "'נוצר ✓ 🌅 מתכנן בוקר — א׳-ה׳ 07:00. מתאים, או שעה אחרת?' — if they "
        "answer with a time, update_my_agent(time=...). Never present the "
        "default as fixed.\n"
        "CUSTOM agent ('תבני לי סוכן ש…'): interview briefly, ONE question at a "
        "time — (a) what should it do, (b) which days + what time. Then "
        "create_agent with name, soul (write the persona/job yourself from their "
        "answers, 2-4 sentences), days (Monday=0..Sunday=6 — Israeli work week "
        "Sun-Thu = [6,0,1,2,3]) and time.\n"
        "MANAGE: 'עצרי את הסוכן' / 'מחקי אותו' / 'שני ל-8' → list_my_agents "
        "first, then update_my_agent/delete_my_agent with the matched id.\n"
        "RESHAPE BY TALKING: when the user describes what an existing agent "
        "should do or remind ('אני רוצה שהסוכן יזכיר לי גם…', 'שיציע לי הכנה "
        "לראיון') → rewrite that agent's persona from THEIR words and call "
        "update_my_agent(agent_id, soul=<new 2-5 sentence job description>). "
        "Confirm what it now does in one line. NEVER answer 'I can't customize' "
        "— the soul is fully editable. Agents can see: saved tasks, profile, "
        "memory, and real routes. They CANNOT yet read email or Google Calendar "
        "— if asked for that, say it's coming and offer the closest thing "
        "(tasks saved in Lumi are covered).\n"
        "HEBREW TERMS: morning prep = 'שגרת בוקר' (NEVER 'שחרית'); the evening "
        "agent = 'מתכנן ערב'.\n"
        "\n"
        "LINKS — YOU HAVE NO WEB ACCESS. You cannot browse, search the web, or "
        "verify any URL. NEVER invent a link: no LinkedIn job IDs, no gh_jid, no "
        "'direct job link' — those are fabrications and they burn the user's "
        "trust. The ONLY links you may send:\n"
        "(a) links the user sent you; "
        "(b) deterministic SEARCH links you build from role+location, e.g. "
        "https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&location=Tel%20Aviv "
        "— and SAY it's a search page, not a specific opening; "
        "(c) a company's careers page ROOT only (e.g. https://www.gong.io/careers/) "
        "— never a made-up job id under it.\n"
        "Asked to find specific job openings → be honest: 'אין לי עדיין גישה "
        "לאינטרנט לחיפוש משרות', give (b)+(c) links, and offer what you're GOOD "
        "at: the user pastes a job description → you tailor their CV to it, draft "
        "a cover letter, and prep interview questions.\n"
        "\n"
        "BE SHORT. WhatsApp style. The schedule lines + ONE question — nothing more. "
        "No paragraphs, no explaining your reasoning, no long sentences.\n"
        "\n"
        "ACT FIRST — DON'T INTERROGATE. Your value is ANSWERS, not questions. If you "
        "have enough to plan, DO IT NOW and show the result. Use what's already known "
        "(shared location, tasks, times, the modes they named). NEVER reply with only "
        "questions when the user gave you a task. Ask for AT MOST one truly-missing "
        "essential (destination, arrival time, or where they're leaving from), and ask it AFTER giving whatever "
        "you can. If they said 'bus or bike, check both' — call plan_departure for EACH "
        "mode and compare them; don't ask which one. A geocoded address that resolves "
        "is good enough — only re-confirm if it's genuinely ambiguous.\n"
        "REUSE WHAT YOU WERE TOLD. Read the conversation above. If a place was already "
        "named with an address earlier (e.g. 'Nebius' = יצחק שדה 8), REUSE that address "
        "— NEVER ask again for something you were already given. Connect references "
        "like 'the Nebius meeting' to the address from earlier in the chat.\n"
        "REMINDERS ARE REAL & AUTOMATIC. Whenever plan_departure returns ok=true, a "
        "WhatsApp reminder is scheduled for the computed leave/wake time automatically "
        "(it survives restarts). 'תזכירי לי'/'remind me at X' → call set_reminder "
        "(one call PER time; resolve 'מחר' with calculate_date first).\n"
        "REMINDER TIMES LIVE IN THE FUTURE. Before ANY set_reminder, compare "
        "against 'time now' in this prompt — times from earlier in the "
        "conversation (yesterday's 09:00) are STALE, never reuse them blindly. "
        "NUDGE MODE ('תנדנדי לי', 'push me to do X today', no explicit hour): "
        "schedule check-ins starting ~30 min from now (rounded to :00/:30), "
        "then every 60-90 min until ~20:00, all via set_reminder. If a call "
        "returns ok=false with now_israel, RETRY in the same turn with a "
        "future time — then confirm only the times that actually succeeded.\n"
        "EXISTING TASK, NOT A REMINDER DUMP: a message ABOUT a task you already "
        "have — a due date ('ההגשה של DDP עד 26.7'), a detail, 'תוודאי איתי מחר "
        "בבוקר שאני עובדת עליה' — is an UPDATE + maybe a check-in, NEVER a reason "
        "to list past reminder times. Do: find_task('DDP') → update_task(deadline "
        "=resolved date) → set_reminder for the check ('09:00' tomorrow). Then "
        "confirm what you actually changed. Do NOT emit a '🕘 09:00 … 13:00' "
        "block — those are stale.\n"
        "CHECK BEFORE YOU CLAIM: list_reminders returns what is ACTUALLY "
        "scheduled. Call it whenever the user asks what's set, and before "
        "confirming a reminder you're unsure about. Its empty list is the "
        "truth — 'nothing is scheduled' is a fine answer.\n"
        "YOU HAVE INTERNET — web_search. Anything you don't know or can't be "
        "sure is current (what a technology is, job posts, news, prices, hours) "
        "→ call web_search and answer from the snippets, with the link. NEVER "
        "say you have no internet access, and NEVER write a URL that didn't "
        "come back from web_search (invented links are stripped before send).\n"
        "WHERE IS X — ADDRESSES: to state where a place/company is ('MER Group'), "
        "call find_place FIRST and use the address IT returns. NEVER write an "
        "address from memory — you once placed an Or-Yehuda firm in Tel Aviv. If "
        "find_place returns ok:false, say you couldn't find it and ask the user "
        "for the address; do NOT guess one.\n"
        "NO FAKE CONFIRMATIONS — THE CARDINAL SIN: 'נשמר ✓' / 'נוצרה תזכורת ✓' / "
        "'Reminder set' are ONLY legal when the matching tool RAN THIS TURN and "
        "returned ok/saved (infer_task_details, update_task, set_reminder, "
        "schedule_message, create_agent). No tool call = say honestly what you "
        "could not do. A fabricated ✓ means the user misses a real appointment.\n"
        "\n"
        "SCHEDULING RULES:\n"
        "- COLLISIONS → call find_clashes(date). It returns the options already worked out "
        "(leave the first earlier, start the second later, join the call on the way, move, "
        "shorten). Read them back; never invent an option it did not give you. If the only "
        "kind is 'choose', there is no good answer — ASK which matters more, do not pick.\n"
        "- ONE DAY → call build_day_schedule(date) and READ BACK what it returns, in its order. "
        "Do NOT sort, re-time or 'improve' it: the tool applies the fixed times, the priority order, "
        "the 3h study floor and never starts in the past. Your job is the sentence, not the sort.\n"
        "- study / learning / coding tasks → block MINIMUM 3 hours (180 min). Never assign less.\n"
        "- Weekly plan request → call get_my_tasks(today, today+6 days), then reply with a 7-day schedule grouped by date.\n"
        "- Each day: fixed appointments first, then must→have_to→need_to, fill gaps with study blocks.\n"
        "- When adding a task, propose a specific time slot based on schedule gaps ('How about 10:00–12:00?').\n"
        "- Evening (after 20:00): when user reports done tasks, note night-study patterns — prefer those slots next time.\n"
        "- plan_departure: ALWAYS pass task_date (YYYY-MM-DD). Always confirm date + day back to user ('Tuesday July 1st ✓'). "
        "TRAVEL urgency ('leave now', 'bus in X min') → only if is_today=true. "
        "For future dates say calmly: 'On Tuesday July 1st, leave by 10:20 🚌'.\n"
        "- PREPARATION urgency is ALWAYS allowed for important future tasks: job interview, exam, deadline → proactively say "
        "'Interview on Tuesday — start preparing now! Want a study plan? 📚'. The closer the date, the more urgent.\n"
        "- ALWAYS verify dates with the user: repeat back the full date + weekday ('That's Tuesday July 1st at 11:00 — correct? ✓').\n"
        "- plan_departure: NEVER assume transport. If transportType is unknown, ask the user first ('Bus, car, walk, or bike? 🚌').\n"
        "- 'Can I fit X on <day>?' / 'יש לי זמן ל…?' is a QUESTION, not a new task: call "
        "check_availability (after calculate_date) and answer from what it returns. Give the "
        "verdict AND its reason — a clash, not enough travel time between the appointment "
        "before and the one after, or one of her standing routines (routines_note: the school "
        "run, a fixed class — hours nobody writes down as tasks). If it does not fit, offer the "
        "first free window it returns. Create nothing unless the user then asks you to.\n"
        "- Standing habits and obligations she mentions in passing ('I take the kids at 16:00', "
        "'gym every Monday') go straight into save_profile(routines_notes=…) verbatim. They are "
        "invisible to every other tool, and planning without them is how a correct plan becomes "
        "a wrong one.\n"
        "\n"
        "RULES:\n"
        "1. Sort by clock time, earliest first. Group under tiny category headers "
        "(✅ Must / 📚 Study / 💼 Work / 🛒 Errands / 💪 Sport / 🌊 Social) — one line each.\n"
        "2. NEVER overlap. A fixed block owns its whole window; nothing else may touch "
        "or enter it. Check every time against the fixed blocks before sending. If two "
        "fixed items clash, say so in one line and ask which wins.\n"
        "3. 'A or B' = ONE either/or choice, not two tasks.\n"
        "4. Think like a human: social/going-out = evening; errands/appointments = "
        "daytime; different location needs travel+buffer (don't start right at the "
        "previous block's end).\n"
        "5. LOCATED FIXED TASK (address + time) — THIS IS THE MOST IMPORTANT THING, "
        "BE ACCURATE:\n"
        "   a. You need 3 things: where they START, where they ARRIVE "
        "(destination), and HOW they travel. NEVER assume the start is home — ask "
        "'Leaving from home, or somewhere else? 📍' unless they already said so this "
        "conversation (the tool refuses until confirmed: pass start_confirmed=true "
        "only after they answer, or start_address if they named another place).\n"
        "   b. TRANSPORT: their profile mode is only a DEFAULT. If the plan comes "
        "back with usedDefaultTransport=true, say which mode you assumed and ask in "
        "the same message: 'I planned by bus 🚌 (your usual) — going a different way "
        "this time?'. If they answer with another mode, call plan_departure again "
        "with transport set.\n"
        "   c. ROUTE FACTS COME ONLY FROM THE TOOL — NEVER FROM YOU. "
        "plan.routeText (and alternatives[].routeText) is the EXACT route from live "
        "Google data: real stations, real line numbers, real departure times. PASTE "
        "IT VERBATIM. You may add words around it, but NEVER change, replace or add "
        "a station name, line number or time — if you write a route line yourself "
        "you are INVENTING data and will mislead the user. No plan_departure call "
        "this turn = you have ZERO route facts: call it first. If the user corrects "
        "the address, call plan_departure AGAIN with the corrected address and use "
        "only the NEW routeText.\n"
        "   d. PUBLIC TRANSPORT = SHOW THE REAL OPTIONS. plan.alternatives holds up "
        "to three real departures per mode (trains AND buses), each with its own "
        "routeText. A route map image is sent automatically right after your "
        "message — don't describe the map. Present the options EXACTLY like this:\n"
        "      📍 מוצא: <plan.startResolved>\n"
        "      📍 יעד: <plan.destResolved>\n"
        "      אפשרות 1 (🚆/🚌):\n      <alternatives[0].routeText>\n"
        "      אפשרות 2:\n      <alternatives[1].routeText>\n"
        "      …then ONE line recommending the option whose routeText matches "
        "plan.routeText (that's the one reminders follow), and ask which they "
        "prefer. If they pick another, call plan_departure again with that "
        "transport.\n"
        "   e. If the tool says needsConfirm (fuzzy address), confirm the resolved "
        "address with the user before trusting it.\n"
        "   f. MORNING ROUTINE — estimate, verify, learn. If routineVerified is false, "
        "the wake time is only a GUESS. Ask once what they do in the morning (shower, "
        "coffee, dress…) to estimate the minutes, show your estimate, ask them to "
        "confirm/adjust, then save_profile(morning_routine_minutes, routine_verified=true). "
        "If they later say it took longer/shorter, update it — keep learning.\n"
        "   f. Reminders for wake & leave are sent automatically — tell them so.\n"
        "   g. If the user SHARED their current location (message starts with \"(I'm "
        "sharing my current location: …)\") or says they're already out, call "
        "plan_departure with from_current=true to route from THERE — then it's just "
        "'leave by HH:MM', no wake time.\n"
        "6. DON'T list suggestions. After the schedule, end with ONE short, "
        "personality-aware question asking what they'd like to add to the free time — "
        "offer a few quick categories as a menu, e.g.: 'Free 14:00–17:00 — add "
        "something? ✅ must-do · 📚 study · 🛒 errand · 💪 sport · ⭐ wishlist'. "
        "Put deadline/urgent things first in that menu if any exist.\n"
        "7. NO-TASKS CASE (greeting / 'hi' / small talk / empty): one warm line "
        "inviting a brain-dump — 'tell me everything on your mind and I'll sort it by "
        "category and time'. Nothing more.\n"
)

#: How much of the prompt is cacheable. Asserted by test_prompt_cache.py so a
#: stray f-string in the block above cannot quietly halve it again.
STATIC_PROMPT_CHARS = len(_STATIC_RULES)


def _system_prompt(user: dict, learned: Optional[dict], profile: Optional[dict] = None,
                   missing: Optional[list] = None, memory_block: Optional[str] = None,
                   guidelines: Optional[str] = None) -> str:
    """The whole system prompt, static prefix FIRST.

    `memory_block` and `guidelines` are parameters rather than something a
    caller concatenates on afterwards, because that concatenation is exactly
    what broke: both were prepended in handle_whatsapp_message, which put a
    per-user, per-message block in front of the ~18 KB of invariant rules and
    destroyed the cacheable prefix on every single turn. Passing them in means
    there is one assembly point, and test_prompt_cache can test the prompt that
    is actually sent instead of a fragment nothing uses.
    """
    # Israel-local "today" — the server clock is UTC; a naive now() is up to 3h
    # behind right after Israel midnight, shifting every relative date by a day.
    from tz import now_il, weekday_label
    from datetime import timedelta
    _il = now_il()
    _tom = _il.date() + timedelta(days=1)
    # Give the model tomorrow pre-resolved (date + bilingual weekday). Almost
    # every message says 'מחר'; making it compute the weekday from 'today is
    # Sunday' is exactly where the LLM guessed wrong ('מחר, יום שישי' when
    # tomorrow was Monday). It still must call calculate_date for OTHER relative
    # dates, but 'tomorrow' — the 90% case — is now handed to it, not derived.
    today_line = (
        f"Today: {_il.strftime('%Y-%m-%d')} ({_il.strftime('%A')}), "
        f"time now {_il.strftime('%H:%M')} Israel.\n"
        f"Tomorrow (מחר) = {_tom.isoformat()} ({weekday_label(_tom)}). "
        f"Use THIS for 'מחר'/'tomorrow'; never copy a date or weekday from an "
        f"earlier turn — those are stale.\n"
    )
    # A stored name can be a model artefact rather than something she said —
    # the live store held name="save_profile", and Lumi greeted her by it.
    # Fall through to the neutral default instead of reading junk back at her.
    stored_name = (profile or {}).get("name")
    if user_profile._is_junk("name", stored_name):
        stored_name = None
    name = stored_name or user.get("name", "there")
    language = user.get("language") or (profile or {}).get("language") or "en"
    mbti_type = (learned or {}).get("finalType") or (profile or {}).get("mbtiType") or user.get("mbti_type")
    confidence = (learned or {}).get("finalConfidence", user.get("mbti_confidence", 0.4) or 0.4)
    hobbies = (profile or {}).get("hobbies")
    hobby_line = f"Known hobbies: {hobbies}.\n" if hobbies else ""
    if profile and profile.get("homeAddress"):
        rv = "verified" if profile.get("routineVerified") else "NOT yet verified (wake time is a guess)"
        transport_line = (
            f"Home: {profile['homeAddress']}. Transport: {profile.get('transportType','?')}. "
            f"Morning routine: {profile.get('morningRoutineMinutes','?')} min ({rv}).\n"
        )
    else:
        transport_line = ""

    lang_name = "Hebrew" if language == "he" else "English"
    lang_lock = (
        f"LANGUAGE RULE — ABSOLUTE: You MUST respond ONLY in {lang_name}. "
        f"NEVER use Russian, Thai, Arabic, French, Spanish, or any other language. "
        f"Even if the user writes in another language, reply in {lang_name} only.\n"
    )
    # The judge rewrites its guidelines every 10 replies and the memory block
    # changes with every message, so both are as variable as anything here.
    mem = f"WHAT I KNOW ABOUT YOU:\n{memory_block}\n" if memory_block else ""
    judge = f"{guidelines}\n" if guidelines else ""

    return (
        _STATIC_RULES
        # ── everything below varies per user or per turn, so it goes LAST ──
        + f"{_onboarding_block(profile, missing or [])}"
        + f"{lang_lock}"
        + f"User: {name}.\n"
        + f"{hobby_line}"
        + f"{transport_line}"
        + f"{today_line}"
        + f"{mem}"
        + f"{judge}"
        + f"{personality_prompt(mbti_type, float(confidence))}"
        + f"REMINDER: respond ONLY in {lang_name}. No other language.\n"
    )


async def _extract_profile(client: AsyncOpenAI, content: str, phone: str) -> None:
    """Forced one-shot: pull any profile details from the message and save them."""
    try:
        resp = await client.chat.completions.create(
            model=model_router.pick("profile_extract", prompt_chars=len(content)),
            messages=[
                {"role": "system", "content": (
                    "Extract ONLY stable personal profile facts the user states about "
                    "THEMSELVES. Leave a field out if not clearly stated. Don't invent.\n"
                    "- home_address: ONLY if they explicitly say where they LIVE ('I live "
                    "at…', 'my home is…'). NEVER treat an appointment/task/destination "
                    "address as home.\n"
                    "- transport: only their usual mode, not a one-off 'by bus or bike' "
                    "comparison for a specific trip.\n"
                    "- name: only an actual personal name."
                )},
                {"role": "user", "content": content},
            ],
            tools=[_SAVE_TOOL],
            tool_choice={"type": "function", "function": {"name": "save_profile"}},
            max_tokens=200,
        )
        calls = resp.choices[0].message.tool_calls or []
        for call in calls:
            args = json.loads(call.function.arguments or "{}")
            clean = {k: v for k, v in args.items() if v not in ("", None)}
            # The forced tool_choice makes some models echo identifiers as the
            # "name" (both live profiles ended up name="save_profile"). A real
            # personal name is never snake_case/an identifier.
            nm = str(clean.get("name") or "").strip()
            if nm and (nm.lower() in ("save_profile", "name", "user", "unknown",
                                      "none", "null", "assistant", "lumi", "tbd")
                       or "_" in nm or len(nm) > 40):
                clean.pop("name", None)
            if clean.get("name") or clean.get("hobbies"):
                user_profile.update_profile(
                    phone,
                    name=clean.get("name"),
                    hobbies=clean.get("hobbies"),
                )
    except Exception as exc:  # noqa: BLE001 — extraction is best-effort
        logger.warning("profile extraction skipped: %s", exc)


def _is_transient(exc: Exception) -> bool:
    """Retryable Nebius/network blips."""
    if isinstance(exc, (APIConnectionError, APITimeoutError)):
        return True
    msg = str(exc).lower()
    return "already borrowed" in msg or "rate limit" in msg or "503" in msg or "overloaded" in msg


def _is_recursion(exc: Exception) -> bool:
    return "graphrecursion" in type(exc).__name__.lower() or "recursion" in str(exc).lower()


async def handle_whatsapp_message(content: str, user: dict, learned: Optional[dict]) -> dict:
    """Run the ReAct agent and return {'type', 'text', 'task'?, 'departures'}."""
    phone = str(user.get("id") or user.get("whatsapp_phone") or "")

    if phone and user_profile.missing_fields(phone):
        await _extract_profile(_get_raw_client(), content, phone)

    profile = user_profile.get_profile(phone) if phone else None
    missing = user_profile.missing_fields(phone) if phone else []
    stored_lang = (profile or {}).get("language") or user.get("language", "en")
    user = {**user, "language": _detect_language(content, stored_lang)}

    # Inject distilled memory (tasks, behaviors, preferences, routines) — not raw
    # history. Retrieval first: the facts nearest THIS message, from pgvector.
    # It returns None whenever embeddings or Supabase are not both available,
    # which is most deployments today, and then the old recency block is used —
    # so this is switched on by configuring EMBED_MODEL and off by unsetting it.
    mem_block = await memory_recall.block_for(phone, content)
    if not mem_block:
        mem_block = user_memory.format_for_prompt(phone)

    # Both of these used to be prepended to the finished prompt, which put a
    # per-message block in front of the 18 KB of invariant rules and missed the
    # provider's prefix cache on every turn. They are now passed IN, so the
    # static prefix stays at character zero.
    system_prompt = _system_prompt(user, learned, profile, missing,
                                   memory_block=mem_block,
                                   guidelines=get_guidelines())
    tools = _make_tools(phone, content, wa_phone=str(user.get("whatsapp_phone") or "") or None)
    hist = _sanitize_history(conversation.get_history(phone)) if phone else []
    # No checkpointer — turn history lives in conversation.py, distilled memory in user_memory.py
    # Tier is chosen per turn: the system prompt is ~18 KB of static rules, so
    # a long conversation is what pushes a turn up a tier, not the message.
    turn_model = model_router.pick("chat", prompt_chars=len(system_prompt) + len(content))
    agent = create_react_agent(_get_llm(turn_model), tools, prompt=system_prompt)

    last_exc = None
    result = None
    for attempt in range(4):
        try:
            result = await agent.ainvoke(
                {"messages": hist + [{"role": "user", "content": content}]},
                config={"recursion_limit": 15},
            )
            break
        except Exception as exc:  # noqa: BLE001
            if _is_recursion(exc):
                logger.warning("agent hit recursion limit — returning partial result")
                # Use whatever the last result was, even if incomplete
                result = getattr(exc, "state", None)
                break
            if not _is_transient(exc):
                logger.error("Lumi agent error: %s", exc)
                break
            last_exc = exc
            logger.warning("transient error (try %d/4): %s", attempt + 1, exc)
            import asyncio
            await asyncio.sleep(0.8 * (attempt + 1))

    if result is None:
        if last_exc:
            logger.error("Lumi agent failed after retries: %s", last_exc)
        he = (user.get("language") == "he")
        # `he` was computed here and then never used, so every Hebrew speaker
        # got an English apology — from an assistant she talks to in Hebrew.
        #
        # And the apology said the wrong thing. "I'll sort it out shortly"
        # promises the message is queued and will be handled. Nothing is
        # queued: the turn is over and the message is gone. Worse, it is the
        # SAME sentence whether the model was briefly overloaded or the API key
        # is being rejected outright — which is how a dead credential looked
        # like a busy day for as long as it did. A 401 is not a blip; say so,
        # because a user who is told "shortly" waits, and a user who is told
        # the key is refused goes and fixes the key.
        cause = str(last_exc or "").lower()
        refused = "401" in cause or "authenticate" in cause or "api key" in cause
        if refused:
            logger.error(
                "Lumi agent: the LLM refused our credentials (401). "
                "Set a valid NEBIUS_API_KEY: fly secrets set NEBIUS_API_KEY=... -a lumi-whatsapp"
            )
            text = ("לא הצלחתי להתחבר למנוע של לומי כרגע 🔌 המשימה לא נשמרה — נסי שוב עוד רגע."
                    if he else
                    "I couldn't reach Lumi's engine just now 🔌 Nothing was saved — try again in a moment.")
        else:
            text = ("לא הצלחתי לעבד את ההודעה הזו 🙏 לא שמרתי כלום — אפשר לנסות שוב?"
                    if he else
                    "I couldn't process that one 🙏 Nothing was saved — want to try again?")
        return {"type": "error", "text": text, "task": None, "departures": []}

    # Billing visibility: sum this turn's token usage (all ReAct steps).
    tok_in = tok_out = 0
    for msg in result["messages"]:
        if isinstance(msg, AIMessage):
            u = getattr(msg, "usage_metadata", None) or {}
            tok_in += u.get("input_tokens") or 0
            tok_out += u.get("output_tokens") or 0
    llm_usage.record("chat", tok_in, tok_out, turn_model)

    task_details: Optional[dict] = None
    all_tasks: list = []
    departures: list = []
    updates: list = []
    final_text = ""

    for msg in result["messages"]:
        if isinstance(msg, ToolMessage):
            try:
                data = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
            except (json.JSONDecodeError, TypeError):
                data = {}
            if msg.name == "infer_task_details":
                # A day-planning message can create SEVERAL tasks — keep them all
                # (only the last one used to survive, silently dropping the rest).
                task_details = data
                if isinstance(data, dict) and data.get("text"):
                    all_tasks.append(data)
            elif msg.name == "update_task" and isinstance(data, dict) and data.get("ok"):
                updates.append(data.get("task"))
            elif msg.name == "plan_departure" and isinstance(data, dict) and data.get("ok") and "plan" in data:
                departures.append(data["plan"])
        elif isinstance(msg, AIMessage) and isinstance(msg.content, str) and msg.content:
            final_text = msg.content  # last AIMessage wins

    # The model sometimes copies the internal "[DD/MM HH:MM]" history marker into
    # its reply (users saw a doubled "[02/08 22:47] [02/08 22:47]"). It is never
    # Lumi's voice — strip every echo before the reply is sent OR stored.
    if final_text:
        final_text = _STAMP_RE.sub("", final_text).strip()

    # ANTI-FABRICATION GUARD #2: save/reminder confirmations ('נשמר ✓',
    # 'נוצרה תזכורת') are only legal when an ACTION tool ran this turn. Hermes
    # confirmed 5 reminders that never existed — the user missed them all.
    _ACTION_TOOLS = {"infer_task_details", "update_task", "set_reminder",
                     "schedule_message", "create_agent", "update_my_agent",
                     "delete_my_agent", "save_profile"}

    def _succeeded(m: ToolMessage) -> bool:
        """Did this tool actually DO something, or merely run?

        The guard used to ask only whether a tool ran. On 30.8 at 12:46 the user
        sent "לדבר עם יניר מחר ב 16:00"; the model called update_task with an id
        that does not exist, the tool returned {"ok": false, "error": "task id
        not found in any store"} — and because it had RUN, the guard stood down
        and Lumi answered "✓ עודכן: שיחה עם יניר". No such task was ever created,
        in any store. A confirmation for a save that did not happen is worse than
        an error: she stopped thinking about it.

        Unparseable or shapeless results are treated as success — this must
        never strip a real confirmation.
        """
        try:
            d = json.loads(m.content) if isinstance(m.content, str) else m.content
        except (json.JSONDecodeError, TypeError):
            return True
        if not isinstance(d, dict):
            return True
        if d.get("ok") is False:
            return False
        return not (d.get("error") and "ok" not in d)

    action_ran = any(isinstance(m, ToolMessage) and m.name in _ACTION_TOOLS and _succeeded(m)
                     for m in result["messages"])
    # "עודכן" and "הוספתי" are how Lumi confirms in practice — and neither was
    # in this list, so the two most common confirmations it writes were the two
    # it could fabricate freely.
    _claim_re = re.compile(
        r"נשמר|נשמרה|נוצרה|נוצרו|תוזמנ|עודכן|עודכנה|עדכנתי|הוספתי|הוספת|נוסף|נוספה"
        r"|reminder set|saved|scheduled|added|updated",
        re.IGNORECASE)
    if final_text and not action_ran:
        lines = final_text.split("\n")
        kept = [ln for ln in lines if not ("✓" in ln and _claim_re.search(ln))]
        if len(kept) < len(lines):
            logger.warning("stripped %d fake confirmation line(s) — no action tool ran",
                           len(lines) - len(kept))
            he_c = (user.get("language") == "he")
            kept.append("⚠️ לא שמרתי כלום עדיין — נסה לנסח שוב בבקשה" if he_c
                        else "⚠️ Nothing was actually saved yet — please rephrase")
            final_text = "\n".join(kept).strip()

    # ANTI-FABRICATION GUARD: route lines (transit emoji + clock time) are only
    # legal when plan_departure actually ran THIS turn. Otherwise the model is
    # echoing an old (possibly invented) route from the conversation history —
    # strip those lines and offer to compute the real thing.
    plan_ran = any(
        isinstance(m, ToolMessage) and m.name == "plan_departure" for m in result["messages"]
    )
    if final_text and not plan_ran:
        # Any transit-emoji line is fabrication when no plan ran — with OR
        # without a clock time (the model's "🚶 10 דקות → תחנת …" survived the
        # clock-only filter before). Leave-by / arrive lines with a time go too.
        route_line = re.compile(
            r"[🚶🚆🚄🚌🚇🚋🚗🚲]|(?:לצאת|עזיבה|הגעה|leave|arrive|wake|קימה|להתעורר).*\d{1,2}:\d{2}")
        lines = final_text.split("\n")
        kept = [ln for ln in lines if not route_line.search(ln)]
        if len(kept) < len(lines):
            logger.warning("stripped %d route-looking line(s) — no plan_departure this turn",
                           len(lines) - len(kept))
            he_g = (user.get("language") == "he")
            kept.append("רוצה שאחשב מסלול מדויק בזמן אמת? 🚆" if he_g
                        else "Want me to compute the live route? 🚆")
            final_text = "\n".join(kept).strip()

    # REPETITION-COLLAPSE GUARD: the model answered with (essentially) the same
    # message as last turn — it stopped reading input. Treated as degenerate so
    # the different-sampling retry below runs; if that also repeats, we bail to
    # an honest line instead of parroting a third time.
    _prev_assistant = next((t.get("content", "") for t in reversed(hist)
                            if t.get("role") == "assistant"), "")
    _repeated = bool(final_text) and _too_similar(final_text, _prev_assistant)
    if _repeated:
        logger.warning("repetition collapse: reply identical to previous turn")

    if not final_text or _is_degenerate(final_text) or _repeated:
        if _is_degenerate(final_text):
            logger.warning("degenerate output suppressed: %r", final_text[:40])
        # One silent retry before apologizing — a single empty/echoed turn is
        # usually transient (this is what produced "סליחה, אפשר לחזור על זה?").
        # Retry with DIFFERENT sampling (temp + repetition penalties): identical
        # params mostly reproduce the same Qwen garbage loop.
        try:
            retry_agent = create_react_agent(_get_retry_llm(turn_model), tools, prompt=system_prompt)
            retry = await retry_agent.ainvoke(
                {"messages": hist + [{"role": "user", "content": content}]},
                config={"recursion_limit": 15},
            )
            for msg in retry["messages"]:
                if isinstance(msg, AIMessage) and isinstance(msg.content, str) and msg.content:
                    final_text = msg.content
        except Exception as exc:  # noqa: BLE001
            logger.warning("degenerate retry failed: %s", exc)
        # Still broken (or still the same parroted block) → say something honest
        # ONCE. Never send a third copy of the stuck message.
        if (not final_text or _is_degenerate(final_text)
                or _too_similar(final_text, _prev_assistant)):
            he = (user.get("language") == "he")
            final_text = ("נתקעתי רגע 🙈 אפשר לנסח מחדש במשפט אחד? (למשל: "
                          "'תזכירי לי בעוד שעה לעבוד על DDP')" if he else
                          "I got stuck for a moment 🙈 Could you rephrase in one "
                          "sentence? (e.g. 'remind me in an hour to work on DDP')")
            # Wipe the poisoned history so the next turn starts clean — the loop
            # is self-sustaining while the stuck block stays in the transcript.
            if phone:
                try:
                    conversation.reset(phone)
                    logger.warning("conversation history reset after repetition collapse")
                except Exception as exc:  # noqa: BLE001
                    logger.warning("history reset failed: %s", exc)

    # Save the route Lumi computed ONTO the task, so it's still there after the
    # chat is cleared. departures otherwise only feed the reminder scheduler —
    # the map/legs/wake-leave times were never persisted on the task itself.
    if task_details and departures:
        dep = _match_departure(task_details, departures)
        if dep:
            task_details["location"] = _location_from_departure(dep)

    # Drop only the inferred tasks that are the SAME as an update this turn
    # (avoids a duplicate row); a genuinely NEW task inferred alongside an edit
    # must still be saved — blanket-zeroing here silently lost the interview.
    if updates:
        updated_texts = {str((u or {}).get("text", "")).strip().lower() for u in updates}
        all_tasks = [t for t in all_tasks
                     if str(t.get("text", "")).strip().lower() not in updated_texts]
        task_details = all_tasks[0] if all_tasks else None

    # Attach each planned route to ITS task (multi-appointment days).
    for t in all_tasks:
        dep = _match_departure(t, departures)
        if dep and not t.get("location"):
            t["location"] = _location_from_departure(dep)

    # ANTI-FABRICATION GUARD #3: the reply must DESCRIBE what was saved.
    # The two guards above ask only whether a tool ran — never whether the
    # prose matches its arguments. So the model wrote "הוספתי ליום שישי, 28.8"
    # while passing date=2026-08-29 to the tool, and the task was filed on a
    # day she never looked at. The prose is the model's; the tool argument is
    # the record. See reply_consistency for the shape.
    #
    # Also restores minutes the model rounded off ("ב-10:09" stored as 10:00),
    # which is only safe because it requires the hour to already agree.
    for i, t in enumerate(all_tasks):
        fixed_t, changed = reply_consistency.correct_task_time(t, content)
        if changed:
            all_tasks[i] = fixed_t
            logger.warning("restored fixed_time %s -> %s from the user's wording",
                           t.get("fixed_time"), fixed_t.get("fixed_time"))
            if task_details is t:
                task_details = fixed_t
    # Only with ONE distinct date this turn is the intended date unambiguous;
    # a multi-day plan names several dates on purpose and is left alone.
    _dates = {t.get("date") for t in all_tasks if t.get("date")}
    if final_text and len(_dates) == 1:
        try:
            _saved = date.fromisoformat(next(iter(_dates)))
            final_text, _n = reply_consistency.correct_reply_dates(final_text, _saved)
            if _n:
                logger.warning("reply named a different day than it saved (%s) — corrected %d token(s)",
                               _saved.isoformat(), _n)
        except (ValueError, TypeError):
            pass

    if phone:
        # Remember the reply WITHOUT guard warnings — storing '⚠️ לא שמרתי כלום'
        # taught the model to emit it on every following turn.
        # Stored AFTER guard #3: history is what the model imitates next turn,
        # so persisting the uncorrected date would teach it the wrong day back.
        conversation.append(phone, content, _for_history(final_text))

    return {
        "type": "task_updated" if updates else ("task_created" if task_details else "reply"),
        "text": final_text,
        "task": task_details,
        "tasks": all_tasks,
        "updates": updates,
        "departures": departures,
    }
