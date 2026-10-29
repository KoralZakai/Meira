# Handoff: Meira — Calm Today, Trips, Talk/Chat, Menu

## Overview
Redesign of the Meira mobile app (React Native + Expo, repo `KoralZakai/Meira-My-AI-Assistant`, branch `master`). The current Today screen shows too many components at once. This design reduces it to one timeline that shows what's next, when to leave, travel legs, free time and the rest of the day. It puts voice (🎙️) and chat (💬) at the centre of the tab bar, and moves profile out of the tabs into a menu.

Final direction: **turns 3 and 4** on the board (`Meira Clean Redesign.dc.html` → 3a–3e and 4a–4e), implemented in `Meira App v3.dc.html`.
- Talk/chat treatment: **3a split pill** is the default. **3b two buttons** is the alternative, set by the `talkStyle` prop. Confirm with the designer which one ships.

## About the design files
The files in this bundle are **design references created in HTML**. They are prototypes that show the intended look and behaviour, not production code to copy. Recreate them in the existing Expo / React Native codebase using its patterns: `src/constants/theme.ts` tokens (BRAND, RADIUS, SHADOWS, FONTS), existing components in `src/components/`, and the existing navigation.

Open `Meira Clean Redesign.dc.html` in a browser to see every state side by side. Every phone on the board is interactive.

## Fidelity
**High-fidelity.** Colours, type, radii, shadows and copy are final and come from the Meira design system (the same values as `theme.ts`). Match them exactly.

---

## Navigation (changes)
Old tabs: Today · Timeline · Tasks · Trips · Profile, plus a 💬 centre button.
New bottom bar, fixed, 88px tall including the safe area, `creamCard #FFFDF7`, 1px top border `#F1E8D6`. Grid columns: `1fr 1fr 132px 1fr 1fr`.

| Slot | Content | Action |
|---|---|---|
| 1 | ☀️ + "Today" | Day screen |
| 2 | 🗺️ + "Trips" | Trips screen |
| 3 | Talk control, raised −32px | 🎙️ opens the voice sheet · 💬 opens the chat sheet |
| 4 | ☑️ + "Tasks" | Tasks screen (unchanged in this round) |
| 5 | ☰ + "Menu" | Opens the Menu sheet (profile). This is not a screen. |

- Tab icons are 21px emoji. Labels are Nunito 800, 10px, `#574326`. Inactive tabs are at opacity 0.5 and the active one at 1.
- **Timeline is merged into Today.** The Profile tab is removed and replaced by Menu.

### Talk control, variant A: split pill (default)
- One pill with `linear-gradient(160deg,#F6CF67,#E9AE3C)`, a 4px `#FFFDF7` border, radius 999, shadow `0 6px 22px rgba(234,178,63,.45)`.
- Two 58×56 transparent buttons: 🎙️ (24px) and 💬 (22px), with a 1×28 divider in `rgba(255,255,255,.3)` between them.
- Press state: opacity 0.85.

### Talk control, variant B: two buttons
- Gap 10px, raised −30px.
- 🎙️: 58px circle, gold gradient, 4px cream border, orb shadow.
- 💬: 58px circle, `#FFFDF7`, 1.5px `#F1C24E` border, card shadow `0 8px 18px rgba(214,165,55,.10)`.
- Press state: scale 0.95.

---

## Screen: Today (Day)
Screen background `#FCF7EC`. Horizontal gutter 20px. The content pads 120px at the bottom to clear the tab bar.

### Header
- **Title:** Fredoka 700, 32px/1.1, `#574326`. It reads "Today", "Tomorrow", "Yesterday" or "Tue 29 Sep", followed by "▾" (Nunito 800, 14px, `#8B6721`). **Tapping the title opens the date picker.**
- **Sub line:** Nunito 700, 13px, `#645843`. Format "Sun 27 Sep · 4 left" for today. Other days read "N planned" or "Nothing planned". The date prefix appears only for yesterday, today and tomorrow.
- **Week strip:** margin-top 18px. 7 equal columns with a 4px gap, week starting Sunday.
  - Each column: a letter (Nunito 800, 11px, `#807252`) above a 38px circle with the date (Nunito 800, 15px, tabular numbers).
  - Selected day: fill `#F1C24E`, ink `#4A3512`, card shadow.
  - Today when not selected: 1.5px `#F1C24E` ring.
  - Past days: ink `#807252`. Future days: `#574326`.
  - Tapping a day selects it.

### Timeline rail
Starts 22px below the header.
- **Column layout:** time column 56px (right-aligned, 14px right padding, border-box), then a 12px dot column, then content with 14px left padding.
- **Rail line:** 2px `#F1E8D6`, running vertically through the centre of the dot column.

Row types, in the order they're generated:
1. **Wake (tomorrow only, first row)**
   - Time in `#8B6721`, Nunito 800, 13px. ⏰ sits on the rail.
   - Title "Wake up". Meta: "45 min to get ready, then leave at 08:50".
   - Wake time = first leave time − the learned routine.
2. **Free window ＋** — **new**. Shown between two events when the gap is at least 45 min. On today it only appears for gaps that start after now.
   - The gap runs from the previous event's end to the next event's leave time (or its start time if there's no travel).
   - Full-width button in the content column: 1.5px **dashed** `#E6D9BC` border, radius 14, padding `8px 12px 8px 8px`, transparent background.
   - Left: 28px circle in `#FBE6A0` with "＋" (fullwidth plus, 16px, 800).
   - Middle: "Free 18:00–19:12" in Nunito 800, 13px, `#8B6721`.
   - Right: duration "1h 12m" in 700, 12px, `#807252`.
   - Press state: opacity 0.7.
   - **Tap:** opens the chat sheet with the free-window context (see Chat).
3. **Travel leg** — shown before any event that has travel, except the next event, which carries travel inside its card.
   - The mode emoji (🚶🚴🚌🚆🚗) sits on the rail at 12px.
   - Content: a TimeChip (`#FCF1D6` background, `#8B6721` text, 800, 12px, radius 12, padding `5px 9px`) reading "🚪 Leave 19:12 · 🚴 12 min", followed by "arrive 19:24" (700, 12px, `#807252`).
   - Past legs are at opacity 0.5.
4. **Now line (today only)**
   - "NOW" in Nunito 800, 11px, tracking 1.2px, `#8B6721`.
   - A 12px gold dot with orb shadow, then a 2px gold line to the right edge.
5. **Next card (today)**
   - Card: `#FFFDF7`, **1.5px `#F1C24E` border**, radius 20, padding 14, card shadow.
   - Eyebrow "NEXT UP" (SectionLabel, tone time).
   - Title "⚕️ Dentist" in Fredoka 700, 20px. Place "📍 Dizengoff 50" in 13px `#645843`.
   - Leave box: `#F1C24E`, radius 14, padding `10px 14px`.
     - Left: "LEAVE" (11px, 800, tracking 1.2, `#7A5A18`) over "16:35" (Fredoka 700, 24px, `#4A3512`).
     - Right: "in 12 min" (800, 14px, `#4A3512`) over "🚶 18 min · arrive 16:53" (700, 12px, `#7A5A18`).
   - Link "See the way there ›" (800, 13px, `#8B6721`) goes to Trips.
6. **Event row**
   - Time column: start time in 800, 13px, `#574326`, with end time below in 11px `#807252`.
   - Dot: 10px ring, 2px. The ring is `#807252` for past events and `#FBE6A0` for future ones.
   - Title: Nunito 700, 15px. Hebrew titles render RTL (`dir="rtl"`).
   - Meta: category emoji + place or duration, 12px `#807252`.
   - Right: round Checkbox, 20px.
   - Done state: row at opacity 0.55 with a line-through title.

**Empty day:** EmptyState with ☀️ and the text "Nothing planned for Fri 2 Oct yet.\nTap 🎙️ or 💬 and tell me what's coming."

### Date picker (bottom sheet)
Opens from the title on Today and from the date chip on Trips.
- **Scrim:** `rgba(252,247,236,.82)`.
- **Sheet:** `#FFFDF7`, radius `28 28 44 44`, padding `12px 20px 30px`, shadow `0 -10px 30px rgba(214,165,55,.18)`. Handle 40×5 in `#F1E8D6`.
- **Header:** "Pick a day" (Fredoka 700, 20px) with a ✕ IconButton.
- **Quick chips:** FilterChip "Today" and "Tomorrow". The active chip is filled `#574326` with white text.
- **Month header:** ‹ Month YYYY › with 36px round nav buttons on `#FCF7EC`.
- **Grid:** 7 columns, 40px cells, 38px day circles. The selected, today and past-day styles match the week strip.
- Tapping a day selects it and closes the sheet.

## Screen: Trips
- **Header:** "Trips" (Fredoka 700, 32px). Sub line "3 trips · 54 min on the way". On the right, a FilterChip in honey tone showing "{day} ▾", which opens the date picker.
- **Map area:** 190px tall, 1px `#F1E8D6` border, radius 16, `#FFFDF7`. Use the existing `RouteMap` component, routed to the next leg's destination.
- **Legs list:** gap 10px. Use the existing **TravelChainCard** for every leg of the selected day, plus the way home.
  - Collapsed row: leave time, title, and a sub line like "🚶 18 min · arrive 16:53".
  - Expanded: steps 🚪 Leave (highlighted "in 12 min" when it's the next trip) → mode + duration → 📍 place ("on time", success colour).
  - The next leg is expanded by default. The mode picker updates the leg.
- **Empty:** EmptyState with 🗺️ and "No trips on this day. Stay put."

## Sheet: Chat (new entry points)
- Full-height sheet (760px on an 844 screen) over the same scrim, background `#FCF7EC`, radius `28 28 44 44`.
- **Header:** `#FFFDF7` with a bottom hairline. MeiraCoin at 36px, "Meira" in Fredoka 700 18px, and a ✕.
- **Messages:** use the existing ChatBubble. Meira bubbles are cream and user bubbles gold. A "…" bubble shows while Meira is replying (about 800ms in the prototype; wire it to the real coach engine).
- **Suggested replies:** Button ghost sm, shown under the last message and removed once one is used.
- **Composer:** `#FFFDF7` with a top hairline, padding `12px 14px 28px`.
  - Input: 44px tall, radius 22, `#FCF7EC` fill, hairline border, placeholder "Message Meira".
  - Then a 🎙️ IconButton (soft, 44px), which switches to voice, and a › IconButton (gold, 44px), which sends. Enter also sends.

Entry contexts:
- **From 💬:**
  - Opening line: "Hey! Ready to light up your day? 🌟 What's on your mind?"
  - Chips: "What's left today?" and "Move gym to tomorrow".
- **From a ＋ free window:**
  - Opening line: "You're free 18:00–19:12. Want me to put something there?"
  - Chips: "💪 Gym", "📌 Groceries" and "Keep it free".
  - Picking an activity creates a 45-min event (capped at the gap length) at the gap start. Meira replies "Done. I added Gym at 18:00 ✨" and the event appears on the timeline.
  - "Keep it free" gets the reply "Got it. I'll keep 18:00–19:12 clear."

## Sheet: Voice
Opens from 🎙️ in the tab bar or in the chat composer.
- **Listening:**
  - Eyebrow "LISTENING" with the **Waveform** below it (level driven by mic input).
  - Live transcript in Fredoka 600, 20px.
  - Helper text: "Tap Send when you're done".
  - Buttons: ghost "Cancel" and primary "Send ›".
- **Reply:**
  - A user ChatBubble with the transcript, then Meira's bubble in the first person, e.g. "Done. I moved Gym to tomorrow at 07:30, before your first meeting 💪".
  - Buttons: ghost "Undo" and primary "Done".
- The action applies to the data straight away: Gym leaves today and appears on tomorrow, and tomorrow's wake time recalculates. Undo reverts it.

## Sheet: Add task (new — replaces the "Parse with Lumi" button flow)
**Entry points:**
- The ＋ free-window row on the timeline (Today or any day), which pre-fills that day and the window's time.
- A ＋ IconButton (gold, 40px) in the Tasks header, for the selected day with no time.

This keeps `GapSlotRow`'s role, but ＋ now opens this sheet directly with `initialTime` / `initialDate` (the same params `AddTaskScreen` already takes).

**Layout.** Bottom sheet, 780px on an 844 screen, background `#FCF7EC`, radius `28 28 44 44`, over the standard scrim.
1. **Header**
   - Handle, then "New task" (Fredoka 700, 22px) and a ✕ IconButton.
   - Day line (Nunito 800, 13px, `#8B6721`): "📅 Today · free 18:00–19:12". This matches the existing `dayBanner()`, so the day is visible before she types.
2. **Input card**
   - `#FFFDF7` with a **1.5px `#F1C24E` border**, radius 20, card shadow, padding `14 14 10 16`.
   - Multiline TextInput, autoFocus: Nunito 700, 18px/1.4, `#574326`. Placeholder "What do you need to do?".
   - Footer row: "Type or say it. I'll fill in the rest." (800, 12px, `#807252`) and a 🎙️ IconButton (soft, 36px) that dictates via `SpeechService` into the same field.
3. **Empty state (no text yet)**
   - SectionLabel "IDEAS FOR THIS WINDOW", or "TRY SAYING" when the sheet wasn't opened from a free window.
   - Ghost sm chips. Ideas come from `GapFillService`, as `GapSlotRow` already does. Tapping a chip fills the input.
4. **"✨ MEIRA FILLED IN" (appears as soon as there are 3+ characters)**
   - On the right of the label, a status in 800, 11px, `#807252`: "✨ Reading…" while analysing or routing, then "✓ Up to date".
   - Fields card: `#FFFDF7`, radius 20, card shadow, 16px side padding. Rows are separated by hairlines, 13px vertical padding each.
   - Each row has an 18px emoji, then an 11px/800 tracked label (`#807252`). On the right of the label sits a **source tag**: 11px/800 `#8B6721` on `#FCF1D6`, pill radius. The value (700, 15px, `#574326`) sits below.
   - Rows, in order, each appearing only once it has a value:
     - ✏️ TASK — title with the time and place removed ("Yoga")
     - 🕐 WHEN — "18:15 → 19:15". Tag: "from your text", or "your free window" when no time was typed.
     - 📍 WHERE — "Yigal Alon 94, Tel Aviv". Tag: "city from your home" when `completeAddress()` added the city, otherwise "from your text".
       - While geocoding or routing, the row shows 🧭 "Working out the route and leave time…" in tertiary ink (the existing product string).
       - With no place, it shows "No place yet, so no trip" (faint), tagged "add “at …”".
     - 🚴 HOW — "Ride · 14 min". Under it, 5 mode buttons (40×32, radius 10: 🚶 🚴 🚌 🚆 🚗). The selected one has a `#574326` fill and border; the others `#FCF7EC` with a hairline border.
       - Tag: "you usually ride there" when `preferredPlaceMode(place)` returns a habit.
       - Tag: "fastest right now" when there's no habit (new place), using the fastest option from `RoutePlanner` / `departureOptions`.
       - Tag: "your pick" after a manual change.
     - 🚪 LEAVE — "18:01 · arrive 18:15". Tag: "in 1h 38m" (relative, today only).
     - 💪 TYPE — "Gym · ~60 min". Tag: "usual length", from `inferTaskDetails` / learned durations.
5. **Clash (when the task, including its travel, overlaps an event)**
   - AttentionBanner, tone clash: "⚠️ Overlaps Gym at 19:30. I can move it." Tapping it hands off to the existing `resolveClashes` flow.
6. **Footer (fixed)**
   - `#FFFDF7` with a top hairline, padding `12 20 30`.
   - Button gradient lg block: "Add to Today · 18:15". Disabled (opacity 0.4) until a title exists.

**Behaviour (the important part):**
- **Analyse live, not on a button.**
  - Debounce about 300ms after each keystroke and run the on-device parsers first: `parseTimeExpression`, `placePartsFrom` (`placeFromText.ts`), `completeAddress`, `inferTaskDetails`, `preferredPlaceMode`. These give an instant, offline answer.
  - In parallel, run `parseSpeechToTasksWithExpansion` (server) and let it upgrade the fields when it returns.
  - When the place changes, geocode and route it: show 🧭, then fill HOW and LEAVE.
- **Never overwrite her edits.** A field she changes (time via the picker, mode via the chips, place via the edit sheet) is locked, and later parsing must not touch it. This is the same rule as the existing `timeTouched` ref, extended to every field.
- Tapping any field value opens its editor: the time picker, the place search / `MapPinConfirm`, or the category picker.
- Saving calls `addManualTask` with the date, `fixedTime`, duration, location and transport. It then calls `rememberPlaceMode(place, mode)` so the habit keeps learning.
- After saving, close the sheet. The new task appears on the timeline with its travel leg, and alarms and reminders are planned as they are today.
- Keep command handling (`processSpeechCommand`: complete, move, delete, duplicate) as it is in `AddTaskScreen` today.

## Sheet: Menu (full profile)
Replaces the Profile tab and the old `SettingsMenu`. It's a full-height sheet (800px), background `#FCF7EC`, radius `28 28 44 44`, with its content scrolling. Sections are 22px apart. Each section is a SectionLabel over one card (`#FFFDF7`, radius 20, card shadow, 16px side padding, hairline-separated 13px rows). Each row has an 18px emoji, a 15px/700 title (bold values in `#574326` inside sentences), a 12px `#807252` sub line, and a › chevron when it opens an editor.

1. **Header**
   - Avatar 56, "Koral" (Fredoka 700, 22px), the account email (13px `#807252`), and a ✕.
2. **WHAT I KNOW ABOUT YOU**
   - Sentences built from `UserProfile`:
     - 🏠 "Home is **Rothschild 22**, work is **Azrieli Center**"
     - ⏰ "Mornings take about **45 min**", sub line "Shower, coffee, dog walk · learned from 14 mornings" (from `morningHabits` and `totalMorningRoutineMinutes`)
     - 💼 "Work starts **09:00**, bed around **23:00**"
     - 🎨 "You like **climbing and guitar**" (`hobbies`)
   - Each row opens its field in `ProfileEditScreen`.
3. **GETTING AROUND**
   - "Favourite way to travel": a 5-column grid of 54px tiles (emoji + 10px/800 label). The selected tile has a `#574326` fill with white label text. Maps to `transportMode`.
   - Then the top `learnedTravelProfiles` rows, e.g. "Holmes Place · 12 min · on time 9 of 10 trips".
4. **ROUTINES**
   - Rows: ⏰ Morning routine "Every day · 07:00 · 45 min", 💪 Gym "Sun, Tue, Thu · 19:30", 📌 Weekly review "Sunday · 09:00" (from `utils/routines` / `routinesNotes`).
   - Last row: "＋ Add a routine" (800, 15px, `#8B6721`).
5. **CONNECTED**
   - Google account (one connection covers Calendar and Gmail, as in `ProfileEditScreen`): shows the email and a "Connected" pill (800, 11px, `#458052` on `#45805214`).
     - Indented sub-row "Calendar sync" with a switch; sub line "Synced 2 min ago · 14 events this week" (from `CalendarAutoSync`).
     - Indented sub-row "Find events in Gmail" with a switch; sub line "Flights, bookings, invites".
   - 💬 WhatsApp: `whatsAppPhone`, sub line "chat with Meira there too", "Connected" pill.
   - 👥 Contacts: when off, the sub line reads "So I know who “Dana” is" with a primary sm "Connect" button (`PhoneContactsService`). When on, it shows a "Connected" pill.
   - **Switch style:** 46×28 track, `#F1C24E` when on and `#F1E8D6` when off, with a 22px white thumb that springs 18px.
6. **THIS PHONE (permissions and peripherals)**
   - 2-column grid of `#FFFDF7` tiles, radius 14, row shadow: 📍 Location "✓ Always", 🔔 Notifications "✓ On", ⏰ Alarms "✓ Exact alarms", 🎙️ Microphone "✓ On".
   - Granted states use `#458052`. Missing permissions read "Allow ›" in `#8B6721`, and tapping one opens the system permission prompt or settings.
7. **MEIRA**
   - 🔊 Read replies aloud (switch).
   - Language: an English / עברית segmented control (`#FCF1D6` track, active segment `#FFFDF7`).
8. **Footer:** "Sign out" (700, 14px, `#807252`, centred).

---

## State
- `selectedDate` (Date). Default is today. Shared by Today and Trips.
- `pickerOpen`, `menuOpen`, `chat: null | { context: 'hello' | { date, start, end } }`, `voice: null | 'listening' | 'reply'`.
- Per-day events, each with `start`, `end`, `title`, `category`, `place?` and `travel?: { mode, mins, leave, arrive }`, plus a done flag.
- **Derived:** free windows (at least 45 min), the next event, the now position, the wake time for tomorrow, and legs for Trips.
- **Settings:** `voiceReplies: boolean`, `language: 'en' | 'he'`.

## Motion
- Sheets spring up: `cubic-bezier(.34,1.3,.64,1)`, about 380ms. Toggles run for 200ms.
- Press states: opacity 0.85 (rows 0.7) and scale 0.95.
- No idle animation. The only continuous motion is the Waveform while listening.

## Design tokens (from theme.ts / design system)
- **Colours:**
  - Gold `#F1C24E` · amber `#E5A93A` · honey `#FBE6A0` · cream `#FCF7EC` · creamCard `#FFFDF7` · line `#F1E8D6` · chip `#FCF1D6`
  - Ink: `#574326` / `#645843` / `#807252`, time ink `#8B6721`
  - On gold: `#4A3512`, with labels in `#7A5A18`
  - Checkbox border `#E6D9BC` · success `#458052` · danger `#B9526B`
- **Gradients:**
  - Primary: `linear-gradient(160deg,#F6CF67,#E9AE3C)`
  - Sunny: `radial-gradient(120% 80% at 50% 8%,#FFF4CE,#FBE6A6 40%,#F6CF6E)`
- **Type:** Fredoka 600/700 for display, Nunito 400–800 for UI.
  - Sizes: 32 title · 24/20 display · 15 body · 13 meta · 12 small · 11 eyebrow (tracking 1.2) · 10 tab label.
- **Radii:** 20 cards/pills · 16 travel · 14 rows/leave box · 12 chips · 28/44 sheets · 999 round.
- **Shadows:**
  - Row: `0 1px 3px rgba(214,165,55,.06)`
  - Card: `0 8px 18px rgba(214,165,55,.10)`
  - Button: `0 12px 24px rgba(180,120,20,.22)`
  - Orb: `0 6px 22px rgba(234,178,63,.45)`
- **Spacing:** 20px screen gutter · 10px between cards · 56px time column.

## Assets
- There are no images. Icons are system emoji, exactly as the product already uses them.
- 🎙️ is a **new glyph** for the system, added for the voice entry point.
- ☰ is a Unicode character, not an emoji.
- MeiraCoin and the wordmark already exist in the codebase.

## Files
- `Meira Clean Redesign.dc.html` — the full board: turn 1 explorations, turn 2, and turn 3 (the final direction).
- `Meira App v3.dc.html` — **the final interactive app** (Today with ＋ free windows, the live Add task sheet, Trips, Tasks, date picker, full Menu/profile, Chat, Voice). See board turn 4 (4a–4e).
- `Meira App v2.dc.html` — the turn 3 version, kept for reference.
- `VoiceSheet.dc.html` — the voice listening and reply sheet.
- `Meira App.dc.html` — the turn 2 version, kept for reference.
- `_ds/`, `support.js` — needed to open the HTML files locally.

## Suggested Claude Code prompt
> Read `design_handoff_meira_today_redesign/README.md` in full and open `Meira App v3.dc.html` in a browser as the visual reference. It's interactive, and board turns 3 and 4 in `Meira Clean Redesign.dc.html` show every state. On a new branch from `master` in this Expo app, implement the UX/UI exactly as specified, using the existing `theme.ts` tokens and components:
> 1. **Tab bar:** Today · Trips · centre talk control (🎙️ voice | 💬 chat, split pill) · Tasks · ☰ Menu. Timeline merges into Today. The Profile tab is removed.
> 2. **Today:** one timeline rail with a now line, the next card with the gold LEAVE box, travel legs between events, a wake row on tomorrow, a week strip plus a date picker sheet, and **＋ free-window rows** (gaps of 45 min or more, from `findGaps`). Remove the Today banners, stats strip, yesterday card and transit chip.
> 3. **Add task sheet (＋):** replace the "✨ Parse with Lumi" button with **live analysis as she types**. Debounce about 300ms. Run the on-device parsers first (`parseTimeExpression`, `placePartsFrom`, `completeAddress`, `inferTaskDetails`, `preferredPlaceMode`) and upgrade the result with the server parse when it returns. Geocode and route the place to fill HOW (the habit for that place, otherwise the fastest option) and LEAVE. Show a source tag on every field. Never overwrite a field she edited. On save, call `rememberPlaceMode`. Keep `processSpeechCommand` handling.
> 4. **Trips:** map (`RouteMap`) plus a `TravelChainCard` for every leg of the selected day, including the way home.
> 5. **Chat and Voice sheets** as specified (`CoachChatScreen` engine, `ChatBubble`, `Waveform`).
> 6. **Menu (full profile)** replacing `SettingsMenu` and the Profile tab: what Meira knows, favourite transport and learned places, routines, Connected (Google Calendar sync and Gmail toggles, WhatsApp, Contacts), phone permissions, voice and language, sign out. Wire it to `UserProfile`, app settings and the existing services.
> Keep English and Hebrew strings in `strings.ts`, with Hebrew rendered RTL. When done, run the existing tests in `tests/` and then `npx expo start` so I can check it on my phone.
