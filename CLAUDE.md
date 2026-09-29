# LUMI AI — Master Project Brief
# Claude Code: Read this file before EVERY task. It is the single source of truth.

---

## ROLES
You are acting as:
- Senior Mobile Engineer (React Native / Expo / TypeScript)
- AI/NLP Engineer (task parsing, intent recognition, ReAct agent)
- UX Engineer (warm, friendly, minimal, fast)
- Integration Engineer (Google APIs, Nebius AI)
- ML Engineer (Lumi learning engine)

---

## CORE UX PRINCIPLE — KEEP LUMI SHORT

Lumi speaks in SHORT sentences only. Max 1-2 sentences per response.
NO long speeches. NO long explanations.
The user wants to SEE their optimized schedule fast — not listen to Lumi.

✅ Good: "Got it! Here's your day 👇"
✅ Good: "Time to leave! Bus 251 in 12 min 🚌"
❌ Bad: "Great! I've analyzed all your tasks and based on your morning routine and travel times I've created an optimized schedule for you today which includes..."

The MAIN output is always: full optimized schedule for today — visible immediately.

---

## DESIGN SYSTEM

```
PRIMARY_YELLOW   = #FFD166   — buttons, mic button, actions, highlights
PRIMARY_PURPLE   = #6C63FF   — Lumi avatar, AI messages, agent elements
PASTEL_BG        = #FFFDF5   — background (light mode)
DARK_BG          = #1A1A2E   — background (dark mode)
PASTEL_CARD      = #FFF8E7   — task cards (light)
DARK_CARD        = #252542   — task cards (dark)
SUCCESS_GREEN    = #06D6A0   — completion, on-time arrival
DANGER_RED       = #EF476F   — urgent deadline, late alert
WARNING_ORANGE   = #FF9F1C   — warnings, "leave now"
TEXT_PRIMARY     = #2D2D2D   — main text (light mode)
TEXT_SECONDARY   = #8A8A9A   — secondary text

Font: Nunito or Poppins — rounded, friendly
Style: warm, soft, rounded corners (16px), gentle shadows
No harsh colors. No cold grays.
```

---

## TECH STACK

| Layer | Technology |
|-------|-----------|
| Framework | Expo managed workflow (React Native) |
| Language | TypeScript |
| LLM | Nebius Token Factory — **NVIDIA Nemotron 3**, three tiers (nano / super / ultra) chosen per call by `server/model_router.py`. **Server-side only**; the app makes no model call |
| LLM Endpoint | https://api.studio.nebius.ai/v1/ — reached from the Fly server, never from the phone |
| Web search | **Tavily** (`server/tavily_search.py`), Google Custom Search as the fallback |
| API Key env var | `NEBIUS_API_KEY`, a **Fly secret**. There is deliberately no `EXPO_PUBLIC_` LLM key: an `EXPO_PUBLIC_*` value is compiled into the APK, so the old one shipped in every build and had to be rotated. Do not reintroduce it |
| STT | expo-speech-recognition (EAS build) / TextInput fallback (Expo Go) |
| TTS | expo-speech (SHORT responses only) |
| Storage | AsyncStorage |
| Secure storage | expo-secure-store (API keys, Google tokens) |
| Notifications | expo-notifications (EAS build only) |
| Location | expo-location (foreground + background) |
| Contacts | expo-contacts |
| Google Auth | expo-auth-session |
| Navigation | expo-router + swipe gestures (no bottom tab bar) |
| Build | EAS Build — Android only (no iOS for now) |

---

## ENV VARIABLES

`EXPO_PUBLIC_*` is **inlined into the JS bundle at build time**. A value that is
absent at build time is `undefined` in the installed app forever, and every
feature that depends on it fails silently — no crash, no message. That is
exactly how APKs shipped for weeks with no Supabase, no maps and no server.

**Never hand-write these for a build.** They live in the EAS `preview`
environment. Run:
```bash
npm run build:env      # pulls EAS preview → .env.local → .env.production
```
It fails loudly if any required var is missing, and it is already chained into
`npm run android:release` / `android:local`. `.easignore` ships `.env.production`
and only that file, so server secrets never travel with the app.

Every build profile in `eas.json` must carry `"environment": "preview"` — that
is the ONLY EAS environment with these values in it. The `development`
environment is empty, and `.env.production` (the one file `.easignore` ships)
is loaded only when NODE_ENV=production, which a `developmentClient` build is
not. A dev profile pointing at its own environment therefore closes BOTH routes
at once and produces an APK that installs, launches and has no Supabase, no
maps and no server — silently. Checked on 2026-09-10, when `android:debug` was
about to do exactly that.

### NO KEY IS EVER STORED ON DISK

Every server credential is an **encrypted Fly secret** (`fly secrets list -a
lumi-whatsapp`) and is read from the environment at runtime. Nothing goes in
`.env.local`, `.claude/settings.local.json`, or any other file on the laptop —
a plaintext file is not storage, it is a leak with a delay. The one exception
is the `EXPO_PUBLIC_*` block below, which is **not secret by construction**: it
is inlined into the APK and ships to every user, so it is protected by
restriction (Maps key → package + SHA-1; Supabase anon key → RLS), never by
hiding.

Server secrets, all Fly-only:
```
NEBIUS_API_KEY            the model key
TAVILY_API_KEY            web search (lumi_agent.web_search, meeting_brief)
NEBIUS_MODEL_SMALL        nvidia/Nemotron-3-Nano-30B-A3B     (extraction, intent)
NEBIUS_MODEL_MEDIUM       nvidia/nemotron-3-super-120b-a12b  (chat, tools)
NEBIUS_MODEL_LARGE        nvidia/Nemotron-3-Ultra-550b-a55b  (long context)
LLM_MONTHLY_BUDGET_USD    0 = no limit. Past 80% the large tier is withdrawn,
                          past 100% everything runs on nano. Lumi degrades,
                          it never goes dark.
```
`GET /diag/models` asks Nebius which models it actually serves and names any
tier pointing at one it does not — check it after any model rename.

Required — the app is quietly broken without any one of them:
```
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co     # no sign-in, no sync without it
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
EXPO_PUBLIC_SERVER_URL=https://lumi-whatsapp.fly.dev  # the LIVE backend; NOT lumi-my-ai-assistant
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...               # no key, no route calculation at all
EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_ANDROID=...apps.googleusercontent.com
```
Optional:
```
EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=...    # WEB client — Android rejects it; fallback only
EXPO_PUBLIC_NEBIUS_BASE_URL=https://api.studio.nebius.ai/v1
EXPO_PUBLIC_NEBIUS_MODEL=Qwen/Qwen3-235B-A22B-Instruct-2507   # keep in step with the server
```

---

## DATA MODELS (src/types/index.ts)

```typescript
export type TaskCategory =
  | 'interview'    // ראיונות עבודה  🎯
  | 'course'       // קורס           📚
  | 'conference'   // כנסים          🎪
  | 'class'        // שיעורים        ✏️
  | 'work'         // עבודה          💼
  | 'meeting'      // פגישה          🤝
  | 'call'         // שיחת טלפון     📞
  | 'doctor'       // תור לרופא      ⚕️
  | 'gym'          // אימון          💪
  | 'aspiration'   // שאיפות         ⭐
  | 'leisure'      // פנאי           🎮
  | 'general'      // כללי           📌
  | 'zoom'         // זום            💻
  | 'hobby_class'; // חוגים          🎨

export type TaskPriority = 'must' | 'have_to' | 'need_to' | 'nice_to_do';
export type TaskStatus = 'pending' | 'complete' | 'missed' | 'moved' | 'partial';
export type TransportType = 'bus' | 'car' | 'walk' | 'bike';
export type AppLanguage = 'en' | 'he';
export type AppTheme = 'light' | 'dark';

export interface TransitLeg {
  type: 'walk' | 'bus' | 'train' | 'subway';
  from: string;
  to: string;
  durationMinutes: number;
  departureTime: string;   // HH:MM
  arrivalTime: string;     // HH:MM
  lineNumber?: string;
  stopName?: string;
  stopLat?: number;
  stopLng?: number;
}

export interface TransitPlan {
  totalDurationMinutes: number;
  leaveHomeAt: string;         // HH:MM
  arriveAt: string;            // HH:MM
  firstBusDeparture: string;   // HH:MM
  firstBusStop: string;
  walkToStopMinutes: number;
  legs: TransitLeg[];
  source: 'google' | 'manual';
  fetchedAt: number;
}

export interface TaskLocation {
  address: string;
  displayName?: string;
  lat: number;
  lng: number;
  travelMinutes?: number;
  wakeUpBy?: string;       // HH:MM
  leaveHomeBy?: string;    // HH:MM
  confirmed: boolean;
  transitPlan?: TransitPlan;
  missedBusHandled?: boolean;
}

export interface TaskContact {
  name: string;
  phone?: string;
  email?: string;
  contactId?: string;
  gmailSender?: string;
}

export interface Subtask {
  id: string;
  text: string;
  status: 'pending' | 'complete';
  durationMinutes: number;
  order: number;
}

export interface Task {
  id: string;
  text: string;
  category: TaskCategory;
  priority: TaskPriority;
  isFixed: boolean;
  fixedTime?: string;              // HH:MM
  durationMinutes: number;
  actualDurationMinutes?: number;
  date: string;                    // YYYY-MM-DD
  status: TaskStatus;
  progress?: string;
  subtasks?: Subtask[];
  deadline?: string;               // YYYY-MM-DD
  deadlineTime?: string;           // HH:MM
  estimatedWorkMinutes?: number;
  latestStartBy?: string;          // HH:MM
  scheduledTime?: string;          // HH:MM assigned by Lumi
  location?: TaskLocation;
  contact?: TaskContact;
  gmailThreadId?: string;
  calendarEventId?: string;
  verifiedArrival?: boolean;
  completedAt?: number;
  createdAt: number;
  movedFromDate?: string;
  historicalDurations: number[];
  notificationIds?: string[];
}

export interface Goal {
  id: string;
  text: string;
  category: TaskCategory;
  type: 'project' | 'aspiration';
  targetDate?: string;
  linkedTaskIds: string[];
  completedTasksCount: number;
  totalTasksCount: number;
  progressPercent: number;
  status: 'active' | 'achieved' | 'paused';
  createdAt: number;
  achievedAt?: number;
}

export interface DailyLog {
  date: string;
  morningDone: boolean;
  afternoonDone: boolean;
  eveningDone: boolean;
  wakeUpTime?: string;
  scheduleGeneratedAt?: number;
}

export interface DailySchedule {
  date: string;
  tasks: Task[];
  wakeUpTime: string;
  generatedAt: number;
  lumiSummary: string;       // EN — SHORT, max 1 sentence
  lumiSummaryHe: string;     // HE — SHORT, max 1 sentence
}

export interface UserProfile {
  name: string;
  language: AppLanguage;
  theme: AppTheme;
  transportType: TransportType;
  morningRoutineMinutes: number;
  wakeBufferMinutes: number;
  homeAddress: string;
  homeLat: number;
  homeLng: number;
  defaultWakeTime: string;   // HH:MM
  sleepTime: string;         // HH:MM
  googleConnected: boolean;
  createdAt: number;
}

export interface UserStats {
  totalPoints: number;
  level: number;
  currentStreak: number;
  longestStreak: number;
  totalTasksCompleted: number;
  totalTasksOnTime: number;
  totalTasksMissed: number;
  categoryDurationAverages: Partial<Record<TaskCategory, number>>;
  lastUpdated: number;
}

export interface RewardEvent {
  id: string;
  type: 'task_complete' | 'on_time' | 'streak' | 'level_up' | 'perfect_day' | 'arrival';
  points: number;
  message: string;
  messageHe: string;
  timestamp: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
  description?: string;
  attendees?: string[];
}

export interface GapSuggestion {
  id: string;
  taskToAdd: Partial<Task>;
  reason: string;
  reasonHe: string;
  gapStart: string;
  gapEnd: string;
  source: 'user_asked' | 'from_goals' | 'lumi_suggestion';
  status: 'pending' | 'accepted' | 'rejected';
}
```

---

## AGENT ARCHITECTURE — ReAct Pattern

**The agent runs on the SERVER, in Python. There is no agent on the phone.**
`grep -rniE "nebius|openai|chat/completions" src/` finds no call site. The app is
a thin client: it sends what the user said and renders what comes back.

```
WhatsApp webhook ─┐
                  ├─► agent_turn.run_turn ─► lumi_agent.handle_whatsapp_message
POST /agent/chat ─┘         (server/react_loop.py — our own ReAct loop, not
                             LangGraph, which cost 35 MB on a 256 MB machine)
```

Think → call tool → see result → think → call next tool → answer.
Recursion limit 15, four transient retries, one silent retry on degenerate output.

### The 21 tools (server/lumi_agent.py `_make_tools`)

| Tool | What it does |
|---|---|
| `infer_task_details` | The message → a task: category, priority, duration, fixed time, location, date |
| `save_profile` | Persist what we learn about the user (home, transport, routine, hobbies) |
| `plan_departure` | Travel time + wake/leave times for a located, time-fixed appointment |
| `build_day_schedule` | Lay a day's saved tasks on a timeline — **deterministic, no model call** |
| `find_clashes` | Collisions in a day, and what could be done about each |
| `get_my_tasks` | Saved tasks for a date range |
| `find_task` | Find EXISTING tasks by words (Hebrew or English) |
| `update_task` | Change an existing task by id — only the fields that change |
| `check_availability` | Does something of N minutes fit on this date? |
| `calculate_date` | A relative expression → the exact calendar date, Israel time |
| `schedule_message` | A WhatsApp message Lumi sends TO SOMEONE ELSE later |
| `set_reminder` | A WhatsApp reminder to the USER at HH:MM |
| `list_reminders` | Reminders already scheduled, upcoming only |
| `save_memory` | Remember a distilled fact for future conversations |
| `web_search` | Live web search — **Tavily first**, Google Custom Search as fallback |
| `find_place` | Where a named place or business actually is |
| `create_agent` | Create a personal agent that runs on a schedule |
| `list_my_agents` | The user's personal agents |
| `update_my_agent` | Change one by id |
| `delete_my_agent` | Delete one by id |
| `send_app_link` | Deep link to finish the personality quiz in the app |

**Removed from this spec — these tools never existed on the server** and any code
written against them was written against a fiction:

| Was documented | What actually happens |
|---|---|
| `search_contacts` | Not implemented anywhere. Contacts resolve through shared WhatsApp contact cards; the app reads the device book with `ContactService` |
| `search_gmail` | The app reads Gmail with the user's own Google token (`GoogleSync`) and posts what it found to `POST /app/email/events`. The mailbox never reaches the server |
| `get_calendar_events` | Same — Google Calendar is read on the phone (`GoogleSync.syncCalendarToday`) |
| `suggest_gap_filler` | Client-side and rule-ranked: `src/services/GapFillService.ts` |
| `verify_task_duration` | A local notification, not a tool: `NotificationService` schedules the "how long did it take?" prompt and `LearningService` records the answer |
| — | **NEW** `POST /app/meeting/brief` (`server/meeting_brief.py`) researches the next calendar meeting — company, person, three questions — every bullet citing a source it was given, uncited bullets dropped. The calendar stays on the phone; one event is posted. App side: `MeetingBriefService` + `MeetingBriefCard` on TodaySchedule |
| `optimize_day` | `build_day_schedule` / `POST /app/schedule/build`. **It only sorts** — it assigns no times and ignores travel. A real optimiser is still owed (TODO 3.3) |

### What is deliberately NOT the model's job

Sorting a day, resolving "מחר", labelling a category and picking one of nine
check-in intents are all arithmetic or lookups. They live in code:

| Job | Module |
|---|---|
| Build the day | `server/day_schedule.py` (~1 ms, no call) |
| Relative dates | `server/tz.py` — `resolve_date`, and `agent_turn.override_task_date` overrules the model when the message carries exactly one date expression |
| Category / priority / duration | `server/categorize.py` — a keyword table, Hebrew first-class |
| Clash resolution | `server/clashes.py`, parity-tested against `src/utils/resolveClashes.ts` |
| Check-in intent | `server/task_intent.py` — the Python port of `src/services/TaskIntent.ts`. **No model call** |

The model is used for language only: open-ended chat and tool selection,
`task_extract` (which words are the tasks), `profile_extract`, `email_events`,
and phrasing a user agent's precomputed facts.

### calculate_date

The tool resolves relative expressions through `server/tz.resolve_date` — one
parser, shared with the WhatsApp path and with `override_task_date`, so the two
cannot disagree. Any relative date ("מחר", "in 2 days", "ביום שני", "21.7") must
go through it; the model is never allowed to derive a date itself. `tomorrow` is
additionally pre-resolved into the system prompt, because it is 90% of cases and
it is where the model guessed wrong.

### System prompt — cache-shaped

`lumi_agent._STATIC_RULES` is a module constant (~18 KB, ~92% of the prompt),
byte-identical across users and turns, and it MUST be at character zero — a
provider caches a prompt by its longest stable prefix. Everything per-user or
per-turn (name, home, today's date, the retrieved memory block, the judge
guidelines, the personality block, the language lock) is appended AFTER it, via
`_system_prompt(..., memory_block=…, guidelines=…)`.

**Never concatenate onto the finished prompt.** That is exactly how the cache was
lost once already: the memory block and the judge guidelines were prepended in
`handle_whatsapp_message`, so the cacheable prefix was whatever retrieval
returned for that message — i.e. never the same twice.
`server/tests/test_prompt_cache.py` fails if it happens again.

---

## TASK SORT ORDER

Sort tasks by: **Priority first → then by leaveHomeBy (or fixedTime/scheduledTime)**

```typescript
getSortKey(task): string =>
  task.location?.leaveHomeBy || task.fixedTime || task.scheduledTime || '23:59'

Priority order: must=0, have_to=1, need_to=2, nice_to_do=3
```

---

## NAVIGATION — No bottom bar

```
HomeScreen (base)
  swipe left    → ScheduleScreen
  swipe left ×2 → GoalsScreen  
  swipe left ×3 → StatsScreen
  
  tap 🎤 mic    → AddTaskModal (popup, silent open — mic starts immediately)
  tap (+)       → AddTaskManualModal
  tap task card → TaskDetailModal
  tap Optimize  → runs optimize_day tool → shows new schedule
```

Page indicator: small vertical dots on right edge of screen.

---

## SCREENS

### HomeScreen
```
Header:     "Good morning, {name}!" + Lumi purple avatar
Stats bar:  ⭐{points} · Lv{level} · 🔥{streak}
Progress:   ████░░ 4/7 tasks done  (yellow bar)
─────────────────────────────────────
🔴 MUST DO
  [TaskCard] [TaskCard]
🟠 HAVE TO
  [TaskCard]
💡 Lumi gap suggestion card (if free slot exists)
─────────────────────────────────────
     🎤 (yellow, large)  +
```

### ScheduleScreen (swipe left ×1)
```
⏰ Wake up by 07:35
🚪 Leave home by 08:28 — Bus 251 from Arlozerov
──────────────────────
"You have 7 tasks today 👇"  ← SHORT Lumi summary
──────────────────────
[Task cards sorted by priority → leaveHomeBy time]
[✨ Optimize my day] button  ← yellow, prominent
```

### GoalsScreen (swipe left ×2)
- Project goals: timeline view (start → target date → % complete)
- Aspirations: progress bar + tasks completed count

### StatsScreen (swipe left ×3)
- Level card + points + streak
- Weekly bar chart (7 days)
- Category breakdown
- Recent rewards

---

## TASK CARD (TaskCard.tsx)

```
│ [priority color bar] [HH:MM] [category badge]     │
│ Task text (bold if isFixed)                        │
│ ~45 min                                            │
│ 📍 Space Gym  👤 Danny  📧 Gmail  ✅ Arrived       │
│ ████░░ 2/3 subtasks                                │
│ [progress note preview if exists]                  │

Swipe right → complete ✓ (+points toast)
Swipe left  → postpone to tomorrow
Long press  → TaskDetailModal
```

---

## ADD TASK FLOW (UX)

```
User taps 🎤
  → NO speech from Lumi — mic starts immediately
  → User speaks freely
  → Agent processes with tools
  
Lumi asks ONLY what's missing (1 question at a time, SHORT):
  "How long? →  [15m] [30m] [1h] [2h] [Lumi decides]"
  "Which place? →  [shows map pin options]"
  "Deadline? →  [date picker]"
  "Started yet? →  [Not yet] [Partially]"

Below questions: "Also add: 📍 Location  👤 Contact  📅 Deadline"

[Save Task] → +5 pts toast
```

---

## RELATIVE DATE HANDLING

When user says any of these — agent calls calculate_date tool FIRST:
- "tomorrow" / "מחר"
- "in 2 days" / "בעוד יומיים"  
- "next Monday" / "ביום שני הבא"
- "day after tomorrow" / "מחרתיים"
- "next week" / "שבוע הבא"
- "in X days" / "בעוד X ימים"

Tool returns exact YYYY-MM-DD. Task is saved on that date, not today.
Agent confirms: "Got it — saved for {display}" (SHORT).

---

## SPEECH RULES

### Input (STT)
- Language: he-IL (handles Hebrew + English mixed)
- Auto-stop: 1.5s silence
- Retry: 2 times → then TextInput fallback
- Pre-processing: remove fillers (um, uh, כאילו, אממ)
- Place name corrections: "igal alon" → "יגאל אלון", "biniamina" → "בנימינה", "space gym" → "Space Gym"

### Output (TTS — expo-speech)
- SHORT only — max 1-2 sentences
- language: he-IL or en-US based on UserProfile.language
- Only speaks: greetings, confirmations, leave alerts, level-up

---

## NOTIFICATIONS

| Trigger | When | Content (SHORT) |
|---------|------|-----------------|
| Wake up | task.location.wakeUpBy | "⏰ Wake up! Interview at 10:00 in Binyamina" |
| Leave home | transitPlan.leaveHomeAt | "🚪 Leave now! Bus 251 from Arlozerov in 12 min" |
| Re-check transit | leaveHomeAt - 30min | silent, recalculates |
| Missed bus | user still home, bus in <8min | "⚠️ Bus in 5 min! Haven't left yet. Next bus at 09:20" |
| Arrival check | fixedTime - 5min | "📍 Should be arriving now. Made it?" |
| Deadline day before | 18:00 | "📚 Deadline tomorrow: VLM homework" |
| Deadline day of | 09:00 | "🔴 Due today: VLM homework by 23:59" |
| Latest start | calculated time | "🔴 Start NOW or you won't finish!" |
| 1hr before deadline | deadlineTime - 60min | "⏰ 1 hour left: VLM homework" |
| Time verification | scheduledEnd + 10min | "How long did {task} actually take?" |
| Morning check-in | user-set time | "☀️ Time to plan your day!" |
| Afternoon | 13:00 | "🌤 What did you get done?" |
| Evening | 20:00 | "🌙 Let's wrap up your day" |

---

## GAMIFICATION

### Points
| Action | Points |
|--------|--------|
| Task complete | +10 |
| Completed on time | +20 |
| GPS arrival verified | +25 |
| Perfect day | +50 |
| Streak day | +15 |
| Task with full details | +5 |
| Goal achieved | +100 |
| Time estimate accurate (<10% error) | +10 |

### Levels
| Level | Points | Title EN | Title HE |
|-------|--------|----------|---------|
| 1 | 0 | Getting Started 🌱 | מתחיל 🌱 |
| 2 | 100 | Building Momentum 🚀 | בדרך 🚀 |
| 3 | 300 | On a Roll 🔥 | בתנופה 🔥 |
| 4 | 600 | Time Master ⚡ | מאסטר זמן ⚡ |
| 5 | 1000 | Lumi Champion 👑 | אלוף לומי 👑 |

---

## LEARNING ENGINE (LearningService.ts)

- After every completed task: record actualDurationMinutes
- Per category: rolling average of last 10 completions (weight: 70% old, 30% new)
- Stored in UserStats.categoryDurationAverages
- getLearnedDuration(category) returns learned average if ≥3 data points, else default
- After completion Lumi says (SHORT): "Gym took 45 min — noted! ✓"

Default durations:
```
interview:90, course:60, conference:120, class:90, work:60,
meeting:45, call:15, doctor:60, gym:60, aspiration:30,
leisure:60, general:30, zoom:45, hobby_class:90
```

---

## OPTIMIZE MY DAY BUTTON

Large yellow button on ScheduleScreen.
On tap → calls optimize_day tool → shows loading "Lumi is thinking..." → shows new schedule.

Optimization rules:
- Fixed tasks (isFixed=true) = cannot move
- must priority = first slots
- work/learning = morning preferred
- gym/leisure = after main work block
- calls/social = end of day
- leave 10 min buffer between tasks
- never schedule past UserProfile.sleepTime
- group location tasks that are near each other

---

## CATEGORY DISPLAY

```typescript
const CATEGORY_META = {
  interview:   { color: '#9B5DE5', icon: '🎯', labelEn: 'Interview',   labelHe: 'ראיון' },
  course:      { color: '#4361EE', icon: '📚', labelEn: 'Course',      labelHe: 'קורס' },
  conference:  { color: '#F77F00', icon: '🎪', labelEn: 'Conference',  labelHe: 'כנס' },
  class:       { color: '#FFD166', icon: '✏️', labelEn: 'Class',       labelHe: 'שיעור' },
  work:        { color: '#023E8A', icon: '💼', labelEn: 'Work',        labelHe: 'עבודה' },
  meeting:     { color: '#118AB2', icon: '🤝', labelEn: 'Meeting',     labelHe: 'פגישה' },
  call:        { color: '#06D6A0', icon: '📞', labelEn: 'Call',        labelHe: 'שיחה' },
  doctor:      { color: '#EF476F', icon: '⚕️', labelEn: 'Doctor',      labelHe: 'רופא' },
  gym:         { color: '#FF9F1C', icon: '💪', labelEn: 'Gym',         labelHe: 'אימון' },
  aspiration:  { color: '#FFD166', icon: '⭐', labelEn: 'Aspiration',  labelHe: 'שאיפה' },
  leisure:     { color: '#FF85A1', icon: '🎮', labelEn: 'Leisure',     labelHe: 'פנאי' },
  general:     { color: '#8A8A9A', icon: '📌', labelEn: 'General',     labelHe: 'כללי' },
  zoom:        { color: '#2D8CFF', icon: '💻', labelEn: 'Zoom',        labelHe: 'זום' },
  hobby_class: { color: '#06D6A0', icon: '🎨', labelEn: 'Hobby',       labelHe: 'חוג' },
}
```

---

## EAS BUILD PROFILES (eas.json)

```json
{
  "cli": { "version": ">= 10.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "android": { "buildType": "apk", "gradleCommand": ":app:assembleDebug" },
      "env": { "APP_ENV": "development" },
      "environment": "preview"
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk", "gradleCommand": ":app:assembleRelease" },
      "env": { "APP_ENV": "preview" }
    },
    "production": {
      "distribution": "store",
      "android": { "buildType": "aab" },
      "env": { "APP_ENV": "production" }
    }
  }
}
```

Package.json scripts:
```json
"android:debug":   "eas build --platform android --profile development",
"android:release": "eas build --platform android --profile preview",
"start:dev":       "npx expo start --dev-client --clear",
"start:tunnel":    "npx expo start --dev-client --tunnel"
```

---

## FILE STRUCTURE

```
/src
  /screens
    OnboardingScreen.tsx
    HomeScreen.tsx
    CheckInScreen.tsx
    AddTaskScreen.tsx
    TaskDetailScreen.tsx
    ScheduleScreen.tsx
    GoalsScreen.tsx
    StatsScreen.tsx
    SettingsScreen.tsx
  /components
    TaskCard.tsx
    WaveformAnimation.tsx
    MapPinConfirm.tsx
    RewardToast.tsx
    SubtaskList.tsx
    CategoryBadge.tsx
    GapSuggestionCard.tsx
    OptimizeButton.tsx
  /services
    SpeechService.ts
    LumiServer.ts          ← the ONLY server surface: 5 calls, no model on the phone
    NotificationService.ts
    TaskStorage.ts
    LocationService.ts
    GoogleService.ts
    ContactService.ts
    LearningService.ts
    RewardService.ts
  /hooks
    useTasks.ts
    useDailyCheckIn.ts
    useUserProfile.ts
    useRewards.ts
    useSchedule.ts
  /constants
    strings.ts             ← ALL strings EN + HE (short!)
    theme.ts               ← colors, categories, levels, points
  /types
    index.ts
  /utils
    fuzzyMatch.ts          ← Hebrew/English place + name matching
    timeUtils.ts           ← HH:MM calculations + isExpoGo
App.tsx
app.json
eas.json
CLAUDE.md                  ← THIS FILE
```

---

## PLACE NAME CORRECTIONS (fuzzyMatch.ts)

```typescript
const PLACE_NAME_CORRECTIONS = {
  'igal alon':    'יגאל אלון',
  'איגל אלון':   'יגאל אלון',
  'even gvirol':  'אבן גבירול',
  'dizengof':     'דיזנגוף',
  'biniamina':    'בנימינה',
  'binimina':     'בנימינה',
  'space gym':    'Space Gym',
  'kickbox':      'קיקבוקס',
}
```

---

## THE SILENT-STATE RULE — the bug this project keeps shipping

Four bugs, one fault. Lumi **knew** and did not **say**.

| Date | What she saw | What was actually true |
|---|---|---|
| 2026-09-17 | "Where is the clock alarm?" | The alarm was armed, correct to the minute, behind a `▸` nobody had reason to tap |
| 2026-09-21 | "0 events found" in the calendar check | Google may have been refusing us outright; every failure returned `[]`, same as a free day |
| 2026-09-21 | An interview with no route | The event had no `location` field; the address was in the body and nothing read it |
| 2026-09-21 | "Why is the wedding showing today?" | It was from 17.9. The row knew the date and never drew it |
| 2026-09-22 | The interview was STILL missing after the fix shipped | The import was fixed. Nothing ran it: one screen's focus, once per 30 min, and the day-picker was documented as "no sync" |
| 2026-09-22 | An in-person interview drawn as a video call, with no journey | The address fix made us read the invitation body; the only URL in it is the Maps link, and the meeting-link reader took it. `isRemoteTask` → no departure |
| 2026-09-22 | An interview with no route at all | She prefers trains, no train reaches Ra'anana, and the chain asked once. `null` was the whole plan |

Each one passed review because **nothing was broken** — the alarm fired, the
array was valid, the card rendered. The value was right and unreachable. That
is the failure mode to hunt, and it will not show up in a type check or a
green test. These rules are how it gets caught instead.

### 1. An empty result must never be able to mean two things

`[]`, `null`, `0`, `false` and `undefined` are answers. They are not error
reports. When a function can return the same empty value for "nothing to
report" and "I could not find out", it MUST return the reason alongside:

```ts
// ✗ a 403, a dead token and a free Wednesday are now the same value
async function events(date: string): Promise<Event[]> {
  try { … } catch { return []; }
}

// ✓ the caller can tell, and so can she
async function events(date: string): Promise<{ events: Event[]; error?: string }>
```

Pattern: `GoogleService.fetchCalendarEvents`.

### 2. `catch` may swallow the throw, never the reason

A bare `catch { return []; }` is banned in any path the user can observe.
Every catch records what happened — `console.warn` at minimum, a returned
reason where a caller can act on it. Console.**log** is dropped by release
builds; if it matters while standing in front of her phone, it is a `warn`.

### 3. A check that cannot fail is not a check

Any "✓ connected" / "✓ saved" / "N found" the user can tap MUST be able to
say **"it failed, and here is why"**, in words naming the fix. "Sign in again"
and "enable the API in Google Cloud" are different fixes and must read
differently. She verified the calendar herself and the check confirmed a lie —
that is worse than no check, because it ended the investigation.

Precedent: `lumi-fake-confirmations`, `lumi-cloud-sync-root-cause`, and now
`calendarDiagnostics`.

### 4. Data from another day or another hour must show that day or hour

Any row, card or list item carrying something not from the day on screen
displays its date. No exceptions for "it's obvious from context" — it is not.
A wedding from 17.9 among today's cards reads as today's.

### 5. A plan that exists must be visible without a tap

Wake time, leave time and route belong in the **collapsed** summary. An alarm
behind an expander is one she can neither trust nor turn off, which is the
same as not having it. See `AlarmPlanner`'s own doc.

### 6. The question has to fit the thing

A past event (it has a `fixedTime` and the time has gone) is asked *"did you
go?"* — never offered a reschedule. You cannot reschedule a wedding.

### 7. A capability with no trigger is not a feature

Ask, of every piece of machinery: **what runs this, and when?** Name the
trigger or it does not exist.

The calendar import was correct, tested and shipped twice while the only thing
that could run it was one screen coming into focus, behind a throttle she could
not see. So an event booked on Sunday for Wednesday reached Lumi when she
happened to open one particular tab — and the route, the leave time and the
wake alarm are all built from the import, so none of them existed either. The
import was never the bug. The absence of a caller was, and no review caught it
because there was nothing wrong with the code that was there.

A trigger must answer all four:

| | |
|---|---|
| **App open, screen visible** | focus / a heartbeat |
| **App open, elsewhere** | AppState `active`, at the ROOT — not on a screen |
| **App closed** | `expo-background-task` (WorkManager, ~15 min floor, OS-scheduled) |
| **She went looking** | pull-to-refresh, picking a day, the Profile check |

A throttle is part of the trigger. `CALENDAR_SYNC_INTERVAL_MS` was 30 minutes,
which meant "add the event in Google, switch back to Meira" did nothing at all
and reported nothing. Any human-initiated path forces past it.

And a background job that lands something must SAY SO — see rule 1. An import
she never hears about is indistinguishable from no import.

Pattern: `src/services/CalendarAutoSync.ts`, owned by `App.tsx`, never by a screen.

### 8. Two readers of the same blob will fight

Before adding a second thing that scans a free-text field, ask what the FIRST
one now sees.

`addressFromDescription` was added to read the venue out of an invitation body,
because recruiting systems leave Google's `location` empty. It worked. But
`extractMeetingUrl` was already scanning that same body for "the first URL",
and the only URL in a Comeet invitation is the **Google Maps link next to the
address**. So the map became the meeting link, which made the event a `zoom`,
which made `isRemoteTask` true, which made `overlapKind.departureOf` return
`undefined` — and an in-person interview in Ra'anana had no departure, no
travel leg and a 💻 badge.

The irony is exact: **the code added to find the address is what convinced the
app she did not have to travel to it.** Nothing threw, nothing was empty, both
readers did what they said.

A reader of prose states what it will NOT accept. `addressFromDescription`
refuses unlabelled prose on purpose; `meetingUrlFromEvent` now takes any URL
from the `location` field (the organiser put it where the venue goes — that is
a deliberate "this is online") but from prose only a RECOGNISED conferencing
host. Guessing from prose is how a map became a meeting.

Pattern: `src/utils/meetingLink.ts` — `NOT_A_MEETING_RE`, `meetingUrlFromEvent`.

### 9. A preference is not a constraint

When she states a preference, honour it first — and then answer the question
anyway.

`getPlanForMode('train')` is absolute by design: it keeps only all-rail routes
and returns `null` otherwise, "an explicit no-train, never a bus in disguise".
That is right. What was wrong is that `ensureTravelChain` asked **once** and
used what came back, so a train preference plus a destination no train reaches
produced no route, no leave-home time, no wake alarm and an empty card.
Preferring trains cost her the plan.

A preference is a LADDER: rail first, bus underneath. And the rungs are
ordered by the actual goal, not the preference — a train arriving at 14:45
loses to a bus arriving at 14:10 for a 14:30 interview, because "by train" was
never a request to be late.

Whatever answered is recorded, and when it is not what she asked for the plan
carries the sentence that says so. A bus arriving under a 🚆 chip is its own
bug, already on the known-open list.

Pattern: `src/utils/transitFallback.ts` — `modeLadder`, `bestPlanInTime`,
`fallbackNote`.

### 10. The platform already counted the failures. Go and read the number.

Every provider this project depends on keeps a success rate, and for months
nobody in this codebase ever looked at one. On 2026-09-22, in ten minutes of
clicking:

| Dashboard | What it had been saying | For how long |
|---|---|---|
| Google Cloud → Maps Metrics | **Directions API: 107 requests, 99% errors, 9 ms median** | every route, forever |
| Supabase → Project home | **84.3% success rate, 400 API-gateway warnings in 60 min** | since migration 0011 was written and not run |

Neither needed a debugger, a repro or a hypothesis. They were printed on the
front page of a dashboard she already had open, and they each named a bug that
had survived several rounds of "why is there no route?".

A 9 ms median is the whole diagnosis on its own: a real Directions answer takes
100-400 ms, so nine means rejected at the edge before any routing ran. Learn to
read the latency as well as the count — a fast failure and a slow success look
nothing alike.

**So: before theorising about why something does not work, open the provider's
console and read its error rate.** If the number is not ~0%, that IS the bug,
and the stack trace you were about to go looking for does not exist because
nothing threw.

And the mirror of it, for us: an app that cannot state its own success rate is
asking her to be its monitoring. Every remote call this project makes now
returns a typed reason (`utils/routeFailure`) precisely so that the number is
available on THIS side too, instead of only on Google's.

### Before calling any of this fixed

- [ ] Grep the change for `catch {` and `return []` / `return null` / `return 0`. Each one: can the caller tell this from success?
- [ ] Every new user-facing surface: what does it render when the thing behind it FAILED? Not "empty" — failed.
- [ ] Anything dated: does the date appear on screen?
- [ ] A new reader of a free-text field: what does the EXISTING reader of that field now see? (rule 8)
- [ ] A preference that can come back empty: is there a rung below it, and does the result say which one answered? (rule 9)
- [ ] Every new capability: name the four triggers (rule 7). "The user will open the screen" is not one of them.
- [ ] A remote call that is failing: what does the PROVIDER's console say its error rate is? (rule 10)
- [ ] Both languages. `npm run test:langparity`.
- [ ] A test that would have caught the ACTUAL bug, run against the real payload where one exists (`tests/run-calendar-import.ts` uses the genuine invitation).

### Known-open, do not re-report as new

- The chat plans a trip **by bike** (server) while the stored `transportType`
  is the profile default, so the timeline chip shows 🚌. Server and phone
  disagree about how she is travelling. Open since 2026-09-17.

---

## WHAT CLAUDE CODE MUST ALWAYS DO

1. Read this file (CLAUDE.md) before every task
2. Read all existing files before writing any code
3. Fix/upgrade existing code — do NOT delete working code
4. Keep Lumi's speech SHORT — max 1-2 sentences
5. The main screen output = full optimized schedule, visible immediately
6. When user mentions relative dates → always call calculate_date tool first
7. Sort tasks: priority first → then by leaveHomeBy/fixedTime/scheduledTime
8. Support both EN and HE in all strings, UI, and TTS
9. Android only (no iOS for now)
10. Run `npx expo start --clear` after changes and confirm no crashes
11. Obey THE SILENT-STATE RULE above — an empty result must never be able to mean two things
12. Never report a fix as shipped until it is on `master` AND in a build. An uncommitted fix is not in the APK; nor is one sitting on a branch
13. Name the trigger. Code that nothing calls, on a schedule nobody set, is not a feature — see rule 7 of THE SILENT-STATE RULE

