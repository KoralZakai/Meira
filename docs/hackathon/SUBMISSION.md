# Meira: Devpost submission (draft)

Track: **Personal AI**. Bonus: **Best Use of Tavily**.

---

## Tagline (≤ 200 chars)

A local-aware personal secretary: say your day, and Meira plans every
journey, wakes you in time, re-plans when you're late, and prepares you for
what's next. Nemotron 3 on Nebius + Tavily.

## Inspiration

Calendars know *what* and *when*, but not *how you get there*. So the hardest
part of the day happens in your head: when do I leave, which bus, do I have
time between the dentist and the interview across town, I'm still home and
it's 13:40, what now? For anyone whose day happens in more than one place, that
bookkeeping is where the day falls apart. We wanted an assistant that behaves
like a human secretary who knows the city: one who tells you *"leave at 13:52,
the 251 from Arlozorov, you'll arrive 14:25"* without being asked, and quietly
fixes the plan when you run late.

## What it does

- **Talk, don't type.** Say your day in Hebrew or English. Nemotron reads the
  whole conversation for intent (add, change or ask) and code executes it, so
  dates, hours and ranges are exact ("from two to half past two" stays
  14:00–14:30).
- **Every appointment is a journey.** Route, leave time and a wake-up alarm,
  by your preferred mode, with a fallback when the preference has no answer.
- **Live re-planning.** Still home after the leave time, or late for something
  that has already started? Meira re-plans from where you are ("leave now,
  arrive 21:47, 17 min late") and keeps the next departures one tap away.
- **Clash detection.** Two places at once is flagged, with what to keep and
  what to move. A call during a meeting is not a clash.
- **Meira prepares you (Tavily).** Before an interview: the company, the
  person, three questions. Before karaoke: songs to practise, with lyrics.
  Before a clinic visit: what to bring and what to ask. Every line cites a live
  source, and an uncited line is dropped.
- **Errands on your way.** "Fix the coffee machine", "laundry", "pick up a
  parcel": Meira searches along the routes she already planned, checks each
  place's opening hours **for the minute you'll pass it**, finds what it
  **costs** on the live web (Tavily, with every number verified against its
  source), and recommends one. One tap puts it into your day.
- **Every calendar you keep.** Google, every calendar on the phone (the Outlook
  app, Samsung, work, family) and Outlook / Teams through Microsoft Graph. All
  are read on the phone. A Teams call arrives as remote, with its join link; an
  in-person meeting arrives with a journey. The same meeting in two calendars
  lands once.
- **She learns from 👍/👎.** A place you turned down is never Meira's pick
  again, and one you liked moves up. That part is deterministic, in code.
  Every verdict also becomes a sentence in memory, which the Nemotron planners
  for prep and errands read next time.
- **Three doors, one brain.** The Android app, WhatsApp, and now **any AI
  assistant over MCP**. Claude or ChatGPT can ask Meira *"what's on my day?"*,
  *"do I have time for two hours in Haifa on Tuesday?"* or *"add a dentist
  tomorrow at 16:00"*. The task lands on the phone, which routes it and sets
  the alarm. Meira becomes the location-aware layer other agents call.

## How we built it

- **NVIDIA Nemotron 3 on Nebius Token Factory, three tiers, routed per call.**
  - **Nano** (30B-A3B): extraction, intent, "is this worth preparing?", "is
    this an errand, and what do I search for?"
  - **Super** (120B-A12B): our own ReAct agent (21 tools), the *understand*
    step, and cited briefs and prep.
  - **Ultra** (550B-A55B): long context.
  - A budget governor withdraws Ultra past 80% of the monthly budget and runs
    everything on Nano past 100%, so the assistant degrades instead of going
    dark.
- **Cache-shaped prompts.** The system prompt is byte-identical across users,
  so the provider's prefix cache applies, and a test guards it.
- **Semantic memory** with Qwen3-Embedding on Nebius.
- **MCP server** (`server/mcp_server.py`): Streamable HTTP, stateless
  JSON-RPC, 8 tools written for an outside model, most of them wrapping the
  agent's own tools, so there is one implementation of each answer. Personal
  tokens are shown once, stored as SHA-256 and revocable.
- **Tavily** powers task prep, meeting briefs, the agent's web search and
  scheduled personal agents.
- **Deterministic where it matters.** Date resolution, time ranges, clash
  geometry, route sampling and opening-hours math are code with tests, not
  model output.
- **Stack:** FastAPI on Fly.io, Supabase, Expo / React Native (Android), Google
  Directions and Places through a server proxy, Whisper for voice.

## Challenges we ran into

Our worst bugs were silent. An alarm existed but sat behind a tap; a refused
Google key looked exactly like "no events today"; a Maps link in an invitation
was read as a video-call link, so an in-person interview lost its journey. We
turned these into a written rule set, *the silent-state rule*: an empty result
must never mean two things, and a check that cannot fail is not a check. We
enforce it in review and tests. During the hackathon, the same rule found that
the "leave now" re-plan had been calling Google straight from the phone with a
key Google refuses, so it had never worked. It now goes through the server,
and every failure is named.

## Accomplishments we're proud of

- Re-planning that actually happens: late for karaoke, still at home, Meira
  already has the next option.
- Prep that cannot hallucinate: every item cites a source it was given.
- Errands matched to **when** you pass, not just **where**.
- About 800 server tests and 85 app test runners, including Hebrew/English
  parity and real calendar invitations.

## What we learned

The model is best used for meaning and judgement, and worst used for
arithmetic. Splitting the two made the assistant both smarter and
trustworthy.

## What's next

- The prep and errand skills exposed as WhatsApp agent tools.

## Built during the hackathon

Meira existed before the submission period as a planner. **During the
hackathon we added:**
- The *understand → act* agent step.
- **Meira prepares you** (task prep with Tavily, Nemotron Nano and Super).
- **Errands on your way** (route sampling, opening hours at pass time, and
  verified prices from the web).
- **Live re-planning** that works: server-side depart-now, transit
  departures, started-but-not-reached trips.
- The focused **Today** screen: next-important pill, late state, clash link,
  content-sized timeline.
- The Whisper-based voice pipeline with outcome screens.
- **Every calendar**: the phone's calendars (expo-calendar) and Outlook / Teams
  (Microsoft Graph), with one event→task mapper and cross-calendar
  de-duplication.
- **Meira as an MCP server**, with personal tokens and an "AI assistants" menu.
- **Learning from 👍/👎** on errands and prep (ranking in code, preference in memory).
- **A key pasted into a chat** is never stored or sent to the model, and a Meira key is revoked.
- Many reliability fixes: spoken hours, misheard dates, "Reschedule all",
  moving "from" moves "until".

See the commit history of `KoralZakai/Meira`.

## Links

- Code: https://github.com/KoralZakai/Meira (MIT)
- APK: https://github.com/KoralZakai/Meira/releases/latest
- Video: _YouTube link_
