# Meira: demo video (under 3:00)

> Tight on time? Scene 5 (errands) can be shortened to 15 s to make room for the MCP scene.

Recorded as a phone screen capture plus voice-over. Every scene is the real
app. Times below are **relative to when you record** ("T" = start of the
first meeting).

## Setup before recording (≈ 30 min ahead)

Google Calendar (the demo account). Add all three before recording; you can
also add #2 live during the video:

| # | Event | When | Where | Shows |
|---|---|---|---|---|
| 1 | Meeting — Nebius team | T → T+60 | Azrieli Center, Tel Aviv | calendar sync → route, leave time, wake alarm |
| 2 | Coffee with Dana | T+75 → T+120 | Herzliya Pituah marina | **not enough time** to get there → clash warning |
| 3 | Karaoke with friends | evening, 21:00 | Allenby St 30, Tel Aviv | Tavily prep: songs to practise |

Plus one task by voice (scene 5): *"laundry this week"*.

Checklist:
- [ ] Server warm (open the app once 5 min before; Fly may be asleep)
- [ ] Location on, at home
- [ ] Do Not Disturb off (the notification is part of the demo)
- [ ] Record at 1080p; keep the take under 2:50

## Scenes

**0:00–0:15 · The problem** (Today screen, voice-over)
> "My calendar knows *what* and *when*. It has no idea *how I get there*. So
> I do the math in my head, all day. Meet Meira."

**0:15–0:45 · Calendar → a planned journey**
- Add event #1 in Google Calendar and switch back to Meira. It syncs and
  appears on the timeline with 🚪 *leave 12:18* · ⏰ *wake 07:30* · 🚌 line.
- Tap it: route map, leave time, the alarm already set.
> "I added a meeting. Meira worked out the route, when I have to leave, and
> set my alarm. I didn't ask."

**0:45–1:10 · Two places, not enough time**
- Event #2 syncs, and the clash line appears: *"Coffee with Dana — you can't
  get from Azrieli to Herzliya in 15 min"* → tap → keep one, move the other.
> "She knows Herzliya is 30 minutes away, not 15, and she tells me before it
> becomes my problem."

**1:10–1:40 · Still at home? She re-plans**
- Stay home past the leave time. The pill turns **red**: *"8 min late ·
  arrive 13:12"*, and the note says *"Departure passed — next: bus 251 at
  12:31"*. "More options ›" shows the next three departures.
> "I'm late. I didn't open anything. She noticed I hadn't moved, found the
> next bus, and moved my arrival time. Like a secretary who knows the city."

**1:40–2:05 · Meira prepares you (Tavily)**
- Tap the karaoke pill line: *🎤 5 songs to practise, with lyrics ›*.
  Songs, each with a source; tap one to open the lyrics.
- (Optional, 5 s) The interview brief: company, person, 3 questions.
> "For anything next, Meira prepares me: Nemotron decides what's worth
> researching, Tavily searches live, and every line cites its source."

**2:05–2:30 · Errands on your way**
- Say *"laundry this week"*, then open the task: **On your way**, *⭐ Meira's
  pick: open when you pass at 17:40 · ★4.6 · 120 m off route* → **Plan it**.
> "Errands go on routes I'm already taking, at places that are open when I
> actually pass by."

**2:30–2:45 · Meira inside Claude (MCP)** (laptop screen, Claude Desktop or Claude Code)
- Type: *"What's on my day tomorrow, and do I have time for coffee in Herzliya at 15:00?"*
  Claude calls `get_my_day` and `check_availability` and answers with the leave time.
- *"Add it."* → `add_task`. Cut to the phone: the task is on the timeline, with its route.
> "And she's not only an app. Any AI assistant can ask Meira, and get an
> answer that knows where I am and how long it takes to get there."

**2:45–2:58 · How it's built** (a slide, or the README diagram)
> "NVIDIA Nemotron 3 on Nebius Token Factory: Nano for quick decisions, Super
> for the agent, Ultra for long context. Tavily for live research. The model
> does language and judgement; times and routes are deterministic code. One
> encrypted memory across the app and WhatsApp. Meira: get out of the door on
> time."

## Voice-over tips

- Short sentences; let the screen talk.
- Show the notification landing (scene 3): it proves she acted without being
  asked.
