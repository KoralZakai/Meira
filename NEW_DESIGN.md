# Build Lumi — AI productivity coach (mobile app + marketing website)

You are building **Lumi**, an AI coach that "lights up your day": she greets the user warmly, organizes their tasks, and helps them stay productive. Build a **mobile app** (the core product) and a **marketing website** that share one warm, soft, sunny brand. The HTML files in this folder are **design references** — recreate their look and behavior in real code using the stack below; do not ship the HTML directly.

---

## Brand & vibe
Warm, cozy, encouraging — like morning sunlight. Soft "claymorphism": inflated rounded shapes, gentle shadows, no hard edges. Friendly but calm, never childish. The signature is a **puffy 3D candy wordmark** and a glowing **sun orb** that represents Lumi herself.

### Color tokens
| Token | Hex | Use |
|---|---|---|
| `sunGold` | `#F1C24E` | primary brand, buttons, accents |
| `amber` | `#E5A93A` | gradient end, pressed states |
| `honey` | `#FBE6A0` | soft fills, focus cards |
| `peach` | `#F6B98C` | secondary accent |
| `cream` | `#FCF7EC` | app background |
| `creamCard` | `#FFFDF7` | cards/surfaces |
| `warmInk` | `#574326` | headings / primary text |
| `inkSoft` | `#8A7A5C` / `#A99B78` | secondary text |
| `line` | `#F1E8D6` | borders/dividers |
| `success` | `#7FB98C` | online/done states |

Primary gradient: `linear-gradient(160deg, #F6CF67, #E9AE3C)`.
App background often a sunny radial: `radial-gradient(120% 80% at 50% 8%, #FFF4CE, #FBE6A6 40%, #F6CF6E)`.

### Typography
- **Display / logo:** `Fredoka` (weights 600/700) — rounded, friendly.
- **UI / body:** `Nunito` (400/600/700/800).

### Shape & depth
- Radius: cards `18–22px`, buttons/pills `18–22px`, phone screen `44px`, app icon `34px` (superellipse feel).
- Shadows are soft and gold-tinted, e.g. `0 8px 18px rgba(214,165,55,.10)`, buttons `0 12px 24px rgba(180,120,20,.22)`.

### Logo
The wordmark is **"Lumi"** in Fredoka 700 with a **puffy 3D candy treatment**, the dot of the **"i" replaced by a small clock coin**, and a small uppercase **"AI"** at the lower-right. Recreate the puff with: a vertical gold gradient text fill (`#FFF3C4 → #F7D069 → #EAB23F`) clipped to text, a white top bevel and a soft gold drop shadow (use layered `drop-shadow()` filters). It must stay crisp at any size — **vector/CSS, never a raster image**. The clock coin = gold circle + white outer ring + a white "L"-shaped hand pointing up then right (12→3 o'clock). The app icon (`icon.png`, 1254×1254, clean) ships as-is.

**Lumi's avatar = the clock coin** (same mark as the logo's "i" dot): a gold disc with a white outer ring and the white "L"-shaped hand. Use it for every avatar/orb circle (splash, greeting card, nav center, chat header). On gold backgrounds invert it (white disc, gold ring + hand). It gently pulses (soft gold glow) on the splash.

---

## Mobile app (core product)
**Stack:** React Native + Expo + TypeScript, file-based routing (expo-router), Reanimated for the orb pulse & transitions. Load Fredoka + Nunito via `expo-font`/Google Fonts.

### Navigation
**Bottom nav — 5 tabs, always visible:**
| Tab | Icon | Label |
|---|---|---|
| 1 | ☀️ sun | Today |
| 2 | ☑️ check-square | Tasks |
| 3 | Lumi orb (raised, gold, ~56px) | *(no label — opens Coach chat)* |
| 4 | 📊 bars | Stats |
| 5 | 👤 person | Profile |

The center orb is raised above the nav bar (shadow + 8px lift), gold gradient disc. Tapping it slides up the Coach Chat screen.

---

### Screens

#### 1. Splash / Onboarding
Sunny radial background. Center: pulsing Lumi orb (gently breathes with a soft gold glow). Below the orb: the puffy "Lumi AI" wordmark. Tagline *"Light up your day, one task at a time."* in Nunito 400 `inkSoft`. Two buttons stacked:
- Gold pill **"Get started"** (primary)
- Text link **"I already have an account"** (`inkSoft`, no bg)

After "Get started" → short name-entry step (single text input, Fredoka placeholder *"What's your name?"*, gold "Let's go →" pill) → Today tab.

---

#### 2. Today *(tab 1 — the hub)*
Cream radial background (`#FFF4CE → #FBE6A6`). Scrollable.

**Header row** (horizontal, `paddingTop: safeArea`):
- Left: small ☀️ + "Good morning" (Nunito 14 `inkSoft`) · user name (Fredoka 22 `warmInk`)
- Right: round avatar (32px, user initial on `honey` bg)

**Lumi greeting card** (white, radius 20, gold-tinted shadow):
- Left: Lumi clock-coin orb (40px)
- Right: one-line message e.g. *"6 tasks today — let's make it bright!"*
- Tap → opens Coach Chat

**Focus card** (gold gradient, radius 20):
- Label "TODAY'S FOCUS" (Nunito 11 700 white/60%)
- Big text: task name (Fredoka 18 white)
- Right: circular progress ring — "2 of 6" done, white stroke on amber

**Up next** section (label "UP NEXT", Nunito 13 700 `inkSoft`):
Task cards (white, radius 18, soft shadow):
- Left: circular checkbox (empty = `line` border, filled = gold ✓)
- Center: title (Nunito 16 600 `warmInk`) · category tag pill (tiny, `honey` bg)
- Right: time chip (`FCF1D6` bg, `#C9952F` text, Nunito 12 700) e.g. "09:30"
- Done: checkbox filled gold, title strikethrough `inkSoft`
- Swipe right → complete (+points toast); swipe left → postpone to tomorrow
- Tap → Task Detail sheet

If today is empty: centered Lumi orb + *"All clear! Ask me to plan your day."*

**Leave-home banner** (only when a transit task is upcoming, amber bg, radius 16):
- "🚪 Leave by 08:28 — Bus 251 from Arlozerov" · [Got it] dismiss button

---

#### 3. Tasks *(tab 2 — full list)*
All tasks, minimal. Cream bg.

**Header**: "Tasks" (Fredoka 24 `warmInk`) + "＋" gold pill button (top-right, opens Add Task sheet).

**Filter chips** (horizontal scroll, `honey` bg, `warmInk` text, radius 18, Nunito 13 700):
All · Today · Upcoming · Done

**Task list**: same card style as Today. Grouped by date when "All" or "Upcoming" filter is active (date separator = Nunito 12 `inkSoft` e.g. "Thursday · Jun 26"). No separate ScheduleScreen — this is it.

Empty state: Lumi orb + *"No tasks yet — tap ＋ to add one."*

---

#### 4. Coach Chat *(center orb — slides up as modal)*
Slides up full-screen from the bottom (spring animation). Dismiss by swipe-down.

**Header** (cream bg, bottom border `line`):
- Left: Lumi clock-coin orb (36px) + "Lumi" (Fredoka 18 `warmInk`) + "● online" (Nunito 12 `success`)
- Right: ✕ close button

**Message list** (cream bg, bottom-padding for input):
- Lumi bubble: white card, radius `20 20 20 6`, `warmInk` text, Nunito 15. Orb avatar left.
- User bubble: gold gradient, radius `20 20 6 20`, white text, Nunito 15. Right-aligned.
- Plan bubble (Lumi): white card with colored bullet rows (category color dot + task text + time chip). Add task buttons under each row.

**Suggestion chips** (horizontal scroll above input, `honey` bg, `warmInk` text, Nunito 13, radius 18):
"Plan my day" · "What's urgent?" · "Add a task" · "Reschedule"

**Input row** (white pill, `line` border, radius 24):
- 🎤 mic icon (left, gold) — tap for voice input
- TextInput placeholder *"Ask Lumi anything…"* (Nunito 14 `inkSoft`)
- Send button (gold disc, white arrow icon)

LLM streams reply. Chips prefill the input. Voice → STT → auto-send.

---

#### 5. Add Task *(sheet — from ＋ button or chat)*
Bottom sheet, slides up, max 85% screen height, handle bar at top, cream bg, radius `24 24 0 0`.

**Title**: "New task" (Fredoka 20 `warmInk`).

Single text field (large, multiline, Nunito 16, no border — just placeholder *"What do you need to do?"*). After typing/speaking, Lumi auto-parses and fills the chips below.

**Quick-set chips row** (horizontal scroll):
- 🕐 Time — tap → compact time picker inline
- 📅 Date — tap → compact date picker inline
- ⏱ Duration — tap → `[15m] [30m] [1h] [2h]` pill picker
- 📍 Location — tap → address search
- 👤 Contact — tap → contacts search

Auto-filled chips show the value (e.g. "09:30", "Tomorrow", "45 min") in `sunGold` bg with a ✕ to clear.

**Save button**: full-width gold pill "Save task" (Nunito 16 700 white). Below it: small text "Lumi will schedule this for you ✨" (`inkSoft`).

---

#### 6. Task Detail *(sheet — tap a task card)*
Bottom sheet, 70% height, cream bg.

**Top row**: category icon (28px) + category name (`inkSoft` 13) + priority dot (colored, right).

**Task title**: Nunito 18 700 `warmInk`, editable inline (tap to edit).

**Detail rows** (each: icon + label, `line` border-bottom, Nunito 14):
- 🕐 Time — editable
- ⏱ Duration — editable
- 📅 Date — editable
- 📍 Location (if set) — address + "Open maps" link
- 👤 Contact (if set) — name + call/message shortcuts

**Subtasks** (if any): compact checklist with `honey` bg rows, Nunito 13.

**Bottom row** (two buttons):
- Left: "Delete" (text-only, `danger` red, Nunito 14)
- Right: "Save" gold pill

---

#### 7. Stats *(tab 4)*
Cream bg. Scrollable. Minimal — 3 blocks only.

**Level card** (gold gradient, radius 20, full-width):
- "Level 3 · Time Master ⚡" (Fredoka 22 white)
- Progress bar (white/40% track → white fill, radius 4)
- "180 pts to next level" (Nunito 13 white/70%)
- Row: ⭐ 620 pts · 🔥 5-day streak · ✅ 48 tasks done (Nunito 14 white 700)

**This week** bar chart (white card, radius 20):
- "THIS WEEK" label (Nunito 12 700 `inkSoft`)
- 7 bars (Mon–Sun), filled `sunGold`, today bar has `amber` label. Height = tasks done that day (max = tallest day). Day label below each bar (Nunito 11 `inkSoft`).

**By category** (white card, radius 20):
- Each row: category icon + name (Nunito 13 `warmInk`) · horizontal bar (category color fill, `line` track) · "3x · 2.5h" right (Nunito 12 `inkSoft`). Only show categories with ≥1 task this week.

---

#### 8. Profile *(tab 5)*
Cream bg. Scrollable.

**Header**: round avatar (64px, initial on `honey`) · name (Fredoka 22 `warmInk`) · "Level 3 · Time Master" (Nunito 13 `inkSoft`).

**Goals section** (label "MY GOALS", Nunito 12 700 `inkSoft`):
Goal cards (white, radius 18): goal text (Nunito 15 600 `warmInk`) · thin progress bar (`sunGold` fill, `line` track) · "3/7 tasks · Jun 30" (Nunito 12 `inkSoft`). ＋ "Add a goal" ghost card (dashed `line` border).

**Settings section** (label "SETTINGS"):
Simple rows (white card, radius 18, stacked, `line` dividers between rows):
- Wake time — `−15m` · `07:00` · `+15m`
- Sleep time — same
- Morning routine — same (minutes)
- Transport — `[Bus] [Car] [Walk] [Bike]` pill selector
- Language — `[EN] [HE]` pill selector
- Notifications toggle

**Footer** (bottom of scroll): "Sign out" text link (`inkSoft`, centered). App version Nunito 11 `inkSoft`.

---

## Marketing website (same vibe & colors)
**Stack:** Next.js + TypeScript + Tailwind (map the tokens above into the theme) or CSS modules. Same Fredoka/Nunito, same palette, same soft shadows — it must feel like the same product.

### Sections
1. **Nav** — Lumi lockup left; "Features / How it works / Pricing" center; "Get started" gold pill right. Cream/transparent, subtle border on scroll.
2. **Hero** — big puffy headline (e.g. *"Your AI coach to light up the day."*), a calm subhead, primary gold CTA + secondary text link, and a floating phone mockup of the **Today** screen beside a glowing orb. Sunny radial background.
3. **Features** (3 soft cards): **Light your day** (warm greeting + daily plan), **Organize tasks** (auto-prioritized to-dos), **Stay productive** (focus + gentle nudges). Each: a small icon/orb, Fredoka title, Nunito copy.
4. **Meet Lumi** — conversational section showing the chat coaching the user through a day.
5. **CTA band** — gold gradient, white puffy headline, "Get the app" buttons.
6. **Footer** — logo, links, soft cream.

Responsive: graceful mobile stack. Keep all the brand rules (radii, shadows, gradients, type) identical to the app.

---

## Acceptance criteria
- Wordmark is crisp vector/CSS (no jagged raster), clock-coin "i", "AI" mark present.
- App and website are visibly the **same brand** (color, type, shape, depth).
- All 8 app screens/sheets implemented and navigable; Coach Chat connects to a real LLM.
- Tokens centralized (theme file) and reused — no hard-coded one-off colors.
- Fredoka + Nunito loaded on both platforms.
- ScheduleScreen and CheckInScreen eliminated — their content lives in Today + Tasks tabs.
- Bottom nav present on all 4 main tabs; Coach Chat slides up as a modal from the center orb.

## Reference files in this folder
- `Lumi Brand & App.dc.html` — brand sheet (wordmark, lockups, palette, type) + all 3 mobile screens.
- `icon.png` — final app icon (1254×1254).
- `lumilogo_topleft_clean.png` — original low-res wordmark, for reference only (do **not** use; rebuild as vector).
