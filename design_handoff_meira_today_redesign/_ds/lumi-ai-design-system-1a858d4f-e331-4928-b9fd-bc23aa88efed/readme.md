# Meira AI — Design System

**Meira is an AI time assistant that learns your habits, routines and constraints, and makes sure you are on time.** She learns how long your morning actually takes, works out the route to where you have to be, sets the alarm backwards from the arrival time, and nudges you out the door. The mark says it in one glyph: the **L is a clock** — a smart clock, a smart assistant.

The product's own words for what it does: *"Light up your day, one task at a time."*

## Products in this system

| Surface | What it is | Status here |
| --- | --- | --- |
| **Meira mobile app** | React Native + Expo. Tabs — Today · Timeline · Tasks · Trips — plus a Coach chat that slides up from the raised centre button. The core product. | Components + Today/Timeline UI kit |
| **Meira web dashboard** | Next.js task board (`web/`). Two visual eras live in its CSS: an Apple-neutral system palette and a warm sticky-note board that matches the app. | Not recreated — see Caveats |
| **WhatsApp / voice** | The same coach engine over WhatsApp and speech-to-text. No visual surface of its own. | Voice UI only (Waveform) |

## Sources

Everything here was lifted from code, not from screenshots or memory:

- **GitHub:** <https://github.com/KoralZakai/Meira-My-AI-Assistant> (branch `master`)
  - `src/constants/theme.ts` — the canonical token set (BRAND, RADIUS, SHADOWS, FONTS, CATEGORY_META, PRIORITY_META, NOTE_PALETTE, GRADIENTS)
  - `NEW_DESIGN.md` — the brand brief: palette table, type, shape, logo construction, all eight app screens
  - `src/components/` — the component inventory (20+ files)
  - `src/screens/TodaySchedule.tsx`, `MyTasks.tsx`, `TripsScreen.tsx`, `CoachChatScreen.tsx` — the real screens
  - `src/constants/strings.ts` — Meira's voice, verbatim
  - `web/app/globals.css` — the web dashboard's CSS
  - `assets/` — the logo files, copied in as-is

Explore that repository further for anything this system abbreviates — the coach engine's copy, the travel-chain maths and the notification logic all shape how the UI behaves.

## Content fundamentals

**Meira speaks as "I", to "you".** She is a warm, capable person who has already done the thinking. Not a system, not a brand voice.

- *"Got it! Here are your tasks for today: … Good luck with your day!"*
- *"Saved your home: Rothschild 22 🏠"*
- *"🧭 Working out the route and leave time…"*
- *"Hey! Ready to light up your day? 🌟 What's on your mind?"*

**Rules the copy actually follows:**

1. **Sentence case everywhere.** Uppercase is reserved for tracked eyebrows (`NEXT UP`, `THE WAY THERE`, `LEAVE`).
2. **Say what happened, in the first person.** "I marked 3 tasks as done." "I moved 2 tasks to tomorrow." Never "Task updated successfully."
3. **One question at a time.** The onboarding agent is explicitly instructed to ask a single warm question per turn.
4. **Be honest when you don't know.** "🧭 Working out the route and leave time…" ships instead of an empty card. "⚠️ Not signed in — tasks live only on this phone."
5. **No guilt.** Overdue work offers "↻ Reschedule all" and "Let them go" with equal weight. Empty states congratulate: "All clear here. Nice work."
6. **Times, not arithmetic.** Always an absolute time *and* its relative form — "07:35" next to "in 12 min".
7. **Never a bare ISO date.** "today" / "tomorrow" / "Wed 2/9".
8. **Encouragement is short and earned.** "You've got this! 💪" · "Progress, not perfection! Keep going! ⭐" — one line, after something real happened.
9. **Bilingual by construction.** Every string exists in English and Hebrew (`STRINGS`, `EXTENDED_STRINGS`); Hebrew is RTL and just as warm.

**Emoji are part of the vocabulary, not decoration.** They carry meaning and appear in product strings, category labels, chip icons and tab bar icons: ⏰ wake · 🚪 leave · 📍 place · 🚌🚆🚗🚶🚴 transport · 🎯 focus · ✅ arrived · 💡 suggestion · 🧹 cleanup · ✨ AI · 🔊 read aloud. Use them exactly as the product does; do not invent new ones or sprinkle them for tone.

## Visual foundations

**The vibe: warm sunny claymorphism.** Morning light. Inflated, rounded shapes; soft gold-tinted shadows; no hard edges anywhere. Friendly but calm — never childish, never cute for its own sake.

**Colour.** One hue family runs the whole product: gold → amber → honey → peach on cream. `sunGold #F1C24E` is the single accent and marks the one thing to do next; `amber #E5A93A` is its pressed state. Backgrounds are `cream #FCF7EC`; surfaces are `creamCard #FFFDF7`; dividers are `line #F1E8D6`. Text is a warm brown family (39–43° hue) at four contrast tiers, never grey. Yellow is never used as text — it is a surface with warm ink on top. Category and priority colours are the only saturated non-brand hues, and they appear as small rails, dots and badges, never as page fills.

**Type.** Fredoka (600/700) for display — rounded and friendly, used for screen titles, note titles, destinations and big times. Nunito (400/600/700/800) for everything else; 800 does the heavy lifting on buttons, times and eyebrows. Fraunces is legacy (the "Claude-styled" Schedule screen only). Numbers are the loudest small element on any screen.

**Backgrounds.** Flat cream, or the sunny radial `radial-gradient(120% 80% at 50% 8%, #FFF4CE, #FBE6A6 40%, #F6CF6E)` on splash and hero surfaces. No photography, no illustration, no texture, no repeating pattern. The one gradient used as a fill is the primary `linear-gradient(160deg, #F6CF67, #E9AE3C)` on the focus card and buttons.

**Corners and cards.** Radius 20 for cards, buttons and pills; 12 for chips and timeline blocks; 14 for rows and action buttons; 16 for travel-chain cards; 34 for the app icon; 44 for the phone screen. A card is cream, radius 20, padding 14–18, shadow `0 8px 18px rgba(214,165,55,.10)`, and a hairline border only when it is secondary or collapsed. The "next" card is marked by a 1.5px gold border — never by a heavier shadow.

**Shadows.** Always gold-tinted, never grey, never inner. Five steps: row `0 1px 3px rgba(214,165,55,.06)`, card `0 8px 18px rgba(214,165,55,.10)`, note `0 10px 22px rgba(214,165,55,.16)`, button `0 12px 24px rgba(180,120,20,.22)`, orb `0 6px 22px rgba(234,178,63,.45)`.

**Borders.** 1px hairline in `line`; 1.5px gold for the accent card; a 4px left rail carrying priority (task cards) or category (timeline cards); a dashed hairline where a card opens into its travel chain.

**Transparency and blur.** Almost none. White at 70–90% for text on gold fills, 30% for dividers on gold. No frosted glass, no backdrop blur, no protection gradients — content sits on solid cream, so it never needs them.

**Layout.** 16px screen gutter, 10px between cards, 48px time gutter in every timeline. The tab bar is fixed at 60px with the 56px chat button lifted 30px above it; content pads 120px at the bottom to clear both. Lists are capped and truncated on purpose — Today shows six tasks with "Show all 14 tasks", the backlog card shows five rows.

**Animation.** Short, springy, and only where something changed. The success moment when you tick a task: bounce to 1.35× over 120ms, spring back, six particles fly out over 600ms, a "+10 ✨" floats up 28px and fades. Toasts fade 200ms. Sheets spring up. Press states are opacity 0.85 (rows 0.7) and scale 0.95 — no colour change. Completed rows drop to 55% opacity with a strikethrough. Disabled is 0.4. **There is no idle or ambient animation:** two infinite orb pulses were deliberately deleted from the tab bar and splash because they animated on every screen forever with nothing to communicate. The only continuous motion in the product is the listening waveform.

## Iconography

**Emoji IS the icon system.** There is no icon font, no SVG sprite, no PNG icon set anywhere in the codebase — every glyph in the UI is a system emoji rendered as text, and the category/priority maps in `theme.ts` store them as string fields. Keep it that way: the platform emoji font is the icon library.

- **Categories** carry a fixed emoji each: 🎯 interview · 📚 course · 🎪 conference · ✏️ class · 💼 work · 🤝 meeting · 📞 call · ⚕️ doctor · 💪 gym · ⭐ aspiration · 🎮 leisure · 📌 general · 💻 zoom · 🎨 hobby. User-created categories default to 🏷️.
- **Tabs** are ☀️ Today · ☑️ Tasks · 🗺️ Trips · 👤 Profile, with 💬 on the raised centre button.
- **Chain and transport** glyphs are semantic: ⏰ 🚪 📍 ✅ 🚌 🚆 🚇 🚗 🚶 🚴 🚏.
- **Unicode characters** stand in for a few UI controls, exactly as the app does: ＋ (fullwidth plus) for add, ✕ close, ✓ check, ▸ ▾ ▲ ▼ disclosure, › chevron/send, → chain arrow.
- **The only vector marks** are Meira's own: the clock coin and the wordmark, both built from CSS/divs so they stay crisp at any size.

**Brand assets** in `assets/`: `icon.png` (1254×1254 app icon — ships as-is), `icon-512.png`, `splash-icon.png`, `lumi.svg`, `lumi_concept.svg`, and `lumilogo_topleft_clean.png` / `lumilogo_topleft_bubble.png` / `lumilogo.jpeg` — the original raster wordmarks, **reference only**. The brief is explicit: rebuild the wordmark as vector/CSS, never ship the raster. Use `MeiraWordmark` and `MeiraCoin`.

## Index

**Root**
- `styles.css` — the single entry point consumers link (`@import` list only)
- `readme.md` — this file · `SKILL.md` — Agent Skills wrapper · `github.md` — upstream sync record
- `thumbnail.html` — homepage tile

**`tokens/`** — `fonts.css` · `colors.css` · `typography.css` · `spacing.css` · `shape.css` · `motion.css` · `base.css`

**`guidelines/`** — 18 specimen cards: brand fills, ink tiers, semantic aliases, sticky-note palette, category colours, priority colours, gradients, attention colours, display type, body type, scale in use, times & eyebrows, radii, elevation, card anatomy, spacing, states & motion, logo assets.

**`assets/`** — logos, app icons, splash art.

### Components

| Group | Components |
| --- | --- |
| `components/brand/` | **MeiraCoin**, **MeiraWordmark** |
| `components/core/` | **Button**, **IconButton**, **TimeChip**, **FilterChip**, **Checkbox**, **Avatar**, **Card**, **SectionLabel**, **SearchField** |
| `components/tasks/` | **TaskCard**, **TaskRow**, **StickyNote**, **DayTaskCard**, **CategoryBadge**, **SubtaskList**, **PriorityGroup**, **EmptyState** |
| `components/schedule/` | **NextUpCard**, **TravelChainCard**, **DayTimeline**, **WakeAlertBanner**, **YesterdayCard**, **GapSuggestionCard** |
| `components/feedback/` | **RewardToast**, **Waveform** |
| `components/navigation/` | **TabBar**, **ChatBubble** |
| `components/overlays/` | **MapPinConfirm**, **AttentionBanner** |

**All components:** MeiraCoin · MeiraWordmark · Button · IconButton · TimeChip · FilterChip · Checkbox · Avatar · Card · SectionLabel · SearchField · TaskCard · TaskRow · StickyNote · DayTaskCard · CategoryBadge · SubtaskList · PriorityGroup · EmptyState · NextUpCard · TravelChainCard · DayTimeline · WakeAlertBanner · YesterdayCard · GapSuggestionCard · RewardToast · Waveform · TabBar · ChatBubble · MapPinConfirm · AttentionBanner

---

**Note:** LumiCoin and LumiWordmark have been renamed to MeiraCoin and MeiraWordmark to match the app rebrand.

Each directory carries a `.card.html` preview; each component has a `.d.ts` props contract and a `.prompt.md` with a usage example.

### UI kits

**`ui_kits/lumi-app/`** — the live `Today` and `Timeline` screens rebuilt in the yellow system, using the real content from the current build (Hebrew included) so it can be diffed side by side. Its `README.md` lists the ten specific places the shipped app has drifted from these tokens — accent colour, heading font, checkbox shape, timeline rails, overlap layout. Start there when reconciling code against this system.

### Intentional additions

The app styles most controls inline rather than through named primitives. These were extracted from repeated inline patterns so consumers have something to reuse — each one already exists visually in the product:

- **Button** — from `OptimizeButton` plus the gold pills in TodaySchedule, MyTasks, TripsScreen and the sheets.
- **IconButton** — the 36px cream header discs and 40px composer buttons in TodaySchedule / CoachChatScreen.
- **TimeChip**, **FilterChip**, **Checkbox**, **Card**, **Avatar**, **SectionLabel**, **SearchField** — the `timeChip`, `chip`/`chipActive`, `checkbox`, `creamCard`, `avatar`, `sectionLabel` and `searchRow` styles, repeated across screens.
- **ChatBubble** — the Meira/user bubble pair from `CoachChatScreen`.
- **AttentionBanner** — the offline / clash / cleanup / briefing-offer banners from `TodaySchedule` and `MyTasks`.
- **StickyNote**, **TaskRow** — the note card and row from `MyTasks`, which live inline in that screen.
- **EmptyState**, **PriorityGroup** — the repeated empty-list block and the header from `PriorityGroupedTasks`.

### Not recreated

- **MeiraCharacter** (`src/components/MeiraCharacter.tsx`) — Meira's illustrated avatar with blink/talk/wave/celebrate states, plus `lumi_appearance.json` (hair, eyes, freckles, cat-eye glasses, VRM file). Recreating an illustrated character would mean drawing it, so it is left out. The clock coin is her mark in every logo context; ask the designer for the character art if a screen needs her face.
- **RouteMap** (`src/components/RouteMap.tsx`) and `MapPinConfirm`'s map view — real map tiles. Screens leave a bordered 190px box where the map goes.
- **TaskDetailBottomSheet** — 41KB of form logic; its parts (SubtaskList, TimeChip, CategoryBadge, Button) are all here.
- **The web dashboard.** `web/app/globals.css` carries two conflicting palettes: an Apple-style neutral system (`--yellow: #0a84ff`, iOS blues and greys) and a warm sticky-note board matching the app. Rather than guess which one is current, nothing web-specific was tokenised. **Which should the web app be?**

## Fonts

No font binaries ship with this system. `tokens/fonts.css` loads **Fredoka**, **Nunito** and **Fraunces** from Google Fonts — the same families the app loads via `expo-font`. If you have licensed/self-hosted copies, drop them in `assets/fonts/` and swap the `@import` for `@font-face` rules.
