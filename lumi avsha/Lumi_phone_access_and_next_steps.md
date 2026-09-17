# Lumi — phone access, what works now, and the road to native

## What the prototype does *today* (open `lumi_app.html` in Chrome on your S24)
- **Lumi appears & greets** — tap ☀️ *Morning briefing* or the mic; she waves and speaks.
- **Real voice** — she talks (speech synthesis) and listens (speech recognition). Grant mic permission when Chrome asks.
- **Morning wake-up routine** — good morning + weekday, date, time; reads today's schedule; tells you when to leave and how long to get ready; asks what to remember.
- **Schedule + departure logic** — add events by voice/text ("I have a team meeting at 9 by train, 30 minutes"). She computes your *leave-by* time and warns you **5 minutes before** and again **when it's time to go** ("head out now to catch the train...").
- **Remembers things** — "remind me to take my umbrella" is saved and resurfaced before you leave.
- **Learns your habits** — "I always forget my keys" adds *keys* to a pre-leave checklist she recites every departure. The more you mention something, the higher it ranks.
- **Encouragement** — varied empowering lines when you finish a task ("say 'I'm done'").
- **Persistent memory** — everything is saved on the device (survives reload). "Reset Lumi's memory" link at the bottom clears it.

### Try this on your phone
1. Open the app, enter your name + wake time.
2. Say or type: *"I have a doctor appointment at 5pm by drive, 25 minutes."*
3. Say: *"I always forget my wallet."*
4. Tap **Morning briefing** and listen to the full routine.
5. Set your wake time to a minute from now and watch her wake you.

## The one honest limitation of the web version
A browser tab **cannot** set the phone's *system* alarm clock or write directly to the native Calendar/Contacts — those need OS-level permission. In the web app, alarms and reminders run **while the app is open**. That's why the prototype is Phase 1: it proves every behavior. Deep phone access is Phase 2, in the native build.

## Phase 2 — native phone access on the Galaxy S24
The production Lumi (Unity + ChatdollKit 3D avatar, per the roadmap) reaches your apps through **Android intents & permissions**:

| Capability | Android mechanism |
|---|---|
| Set a real alarm | `AlarmClock.ACTION_SET_ALARM` intent |
| Add calendar events | `CalendarContract` / `ACTION_INSERT` (with Calendar permission) |
| Read today's agenda | `CalendarContract.Events` query |
| Reminders / notifications that fire when app is closed | `AlarmManager` + `NotificationManager` (foreground service) |
| Contacts (for "remind me to call…") | `ContactsContract` |
| Wake-up that speaks aloud | foreground service + TTS at alarm time |
| Location / travel time | Fused Location + a maps API for real leave-by times |
| "Learn my lifestyle" memory | on-device store + the hybrid LLM brain with long-term memory |

## Suggested next step
Ship the web prototype to your S24 first (add it to your home screen — it behaves like an app), live with Lumi for a few days, and refine exactly how she should talk and what she should track. Then I can help you either (a) wrap this as a proper installable Android app with native alarm/calendar permissions, or (b) start the 3D Unity/ChatdollKit build with your VRoid model of Lumi. Both reuse the behavior and the design we've already locked in.
