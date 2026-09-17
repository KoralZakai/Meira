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

### Screens
1. **Onboarding / Splash** — sunny radial background, pulsing sun orb, the puffy "Lumi AI" wordmark, tagline *"Light up your day, one task at a time."*, a white primary button **"Get started"**, and a **"I already have an account"** text link.
2. **Today (home)** — the hub:
   - Header: a small sun icon + "Good morning", the user's name in Fredoka, and a round avatar.
   - **Lumi greeting card** (white): orb + a line like *"6 tasks today — let's make it a bright one. Want me to plan it?"*
   - **Today's focus card** (gold gradient): label, "On track", "2 of 6 done", and a circular progress ring showing %.
   - **Up next** task list: white cards with a circular checkbox, title, subtitle/tag, and a time chip (`#FCF1D6` bg, `#C9952F` text). Done tasks show a filled gold check + strikethrough muted title.
   - **Bottom nav** (5): Today (sun, active), Tasks (check-square), centered raised **Lumi orb** (opens chat), Stats (bars), Profile.
3. **Coach chat** — header with orb + "Lumi" + green "● Your AI coach"; message bubbles (Lumi = white, left, rounded `20px 20px 20px 6px`; user = gold gradient, right, white text); an assistant "plan" bubble with colored bullet dots; suggestion chips ("Add a break", "What's urgent?", "Reschedule"); input pill + gold send button. Wire to an LLM for real coaching/planning responses.

### Behavior
- Tapping a task toggles done with a spring animation; the focus ring + "x of 6" update.
- The greeting changes by time of day (Good morning/afternoon/evening).
- Chat: user message → assistant streams a reply; chips prefill the input.
- Persist tasks and chat locally (and/or a backend of your choice).

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
- All three app screens implemented and navigable; chat connects to a real LLM.
- Tokens centralized (theme file) and reused — no hard-coded one-off colors.
- Fredoka + Nunito loaded on both platforms.

## Reference files in this folder
- `Lumi Brand & App.dc.html` — brand sheet (wordmark, lockups, palette, type) + all 3 mobile screens.
- `icon.png` — final app icon (1254×1254).
- `lumilogo_topleft_clean.png` — original low-res wordmark, for reference only (do **not** use; rebuild as vector).
