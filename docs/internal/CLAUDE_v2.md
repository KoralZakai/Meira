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
| LLM | Nebius AI — Qwen/Qwen3-235B-A22B via OpenAI-compatible SDK |
| LLM Endpoint | https://api.studio.nebius.ai/v1/ |
| API Key env var | EXPO_PUBLIC_NEBIUS_API_KEY |
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

## ENV VARIABLES (.env)
```
EXPO_PUBLIC_NEBIUS_API_KEY=v1.CmMK...
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...
EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=123456....apps.googleusercontent.com
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

Lumi uses a ReAct (Reasoning + Acting) loop:
Think → call tool → see result → think → call next tool → output schedule.

### 12 Tools (FINAL LIST)

```typescript
const LUMI_TOOLS = [

  // 1. Categorize task
  {
    name: "categorize_task",
    description: "Detect category, priority, duration estimate, isFixed from task text",
    input: { task_text: string, context?: string }
    output: { category, priority, durationMinutes, isFixed, confidence }
  },

  // 2. Split into subtasks
  {
    name: "split_into_subtasks",
    description: "Split complex task into ordered subtasks with durations",
    input: { task_text: string, already_done?: string, context?: string }
    output: { subtasks: [{text, durationMinutes, order}] }
  },

  // 3. Transit plan (full bus/walk breakdown)
  {
    name: "get_transit_plan",
    description: "Get full transit plan from home to destination: walk to stop + bus + arrival. Uses Google Directions API with arrival_time.",
    input: { destination_address: string, arrival_deadline: string, date: string }
    output: { TransitPlan }
  },

  // 4. Wake time calculator
  {
    name: "calculate_wake_time",
    description: "Calculate wakeUpBy and leaveHomeBy from fixed arrival time",
    input: { fixed_time: string, travel_minutes: number, routine_minutes: number, buffer_minutes: number }
    output: { wakeBy: string, leaveHomeBy: string }
  },

  // 5. Date calculator — NEW
  {
    name: "calculate_date",
    description: "Convert relative date expressions to absolute YYYY-MM-DD date. Handles: 'tomorrow', 'in 2 days', 'next Monday', 'next week', 'in 3 days', 'day after tomorrow', etc. Always returns exact date.",
    input: {
      expression: string,   // e.g. "tomorrow", "in 2 days", "next Monday", "in a week"
      reference_date: string // today's date YYYY-MM-DD
    }
    output: {
      date: string,          // YYYY-MM-DD
      display: string,       // human readable e.g. "Thursday, June 5"
      daysFromNow: number    // 1 for tomorrow, 2 for day after, etc.
    }
  },

  // 6. Search contacts
  {
    name: "search_contacts",
    description: "Search device contacts by name, supports Hebrew/English variants",
    input: { name_query: string }
    output: { matches: [{name, phone, email, contactId, score}] }
  },

  // 7. Search Gmail
  {
    name: "search_gmail",
    description: "Find emails related to a task",
    input: { keywords: string, date_range?: string }
    output: { threadId, subject, sender, snippet } | null
  },

  // 8. Get calendar events
  {
    name: "get_calendar_events",
    description: "Get Google Calendar events for a specific date",
    input: { date: string }
    output: { CalendarEvent[] }
  },

  // 9. Gap filler suggestion
  {
    name: "suggest_gap_filler",
    description: "Detect free slots in schedule. First ask user what to do, if no answer suggest from user goals/aspirations",
    input: { gap_start: string, gap_end: string, user_goals_summary: string }
    output: { suggestion: Task, reason: string, source: string }
  },

  // 10. Build schedule
  {
    name: "build_schedule",
    description: "Build optimized daily schedule. Fixed tasks first (by leaveHomeBy or fixedTime), then flexible tasks by priority. Output: full DailySchedule ready to display.",
    input: { tasks: Task[], wake_constraint?: string, sleep_time: string, language: string }
    output: { DailySchedule }
  },

  // 11. Schedule time verification popup
  {
    name: "verify_task_duration",
    description: "Schedule a popup 10 minutes after task end time asking: how long did it actually take?",
    input: { task_id: string, estimated_minutes: number, scheduled_end_time: string }
    output: { popup_scheduled_at: string }
  },

  // 12. Optimize full day
  {
    name: "optimize_day",
    description: "Re-optimize the full day schedule based on current time, completed tasks, remaining tasks. Called when user taps Optimize button.",
    input: { current_time: string, completed_task_ids: string[], remaining_tasks: Task[] }
    output: { DailySchedule }
  }
]
```

### calculate_date Tool — Implementation
```typescript
// In executeToolCall, case 'calculate_date':
case 'calculate_date': {
  const { expression, reference_date } = toolInput;
  const ref = new Date(reference_date);
  const lower = expression.toLowerCase().trim();
  let daysToAdd = 0;

  if (lower === 'tomorrow' || lower === 'מחר') daysToAdd = 1;
  else if (lower === 'day after tomorrow' || lower === 'מחרתיים') daysToAdd = 2;
  else if (lower === 'next week' || lower === 'שבוע הבא') daysToAdd = 7;
  else {
    // "in X days" / "בעוד X ימים"
    const match = lower.match(/in (\d+) days?/) || lower.match(/בעוד (\d+) ימים?/);
    if (match) daysToAdd = parseInt(match[1]);
    else {
      // "next Monday" etc.
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const daysHe = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
      const targetDay = days.findIndex(d => lower.includes(d)) !== -1
        ? days.findIndex(d => lower.includes(d))
        : daysHe.findIndex(d => lower.includes(d));
      if (targetDay !== -1) {
        const currentDay = ref.getDay();
        daysToAdd = (targetDay - currentDay + 7) % 7 || 7;
      }
    }
  }

  const result = new Date(ref);
  result.setDate(ref.getDate() + daysToAdd);
  const dateStr = result.toISOString().split('T')[0];
  const display = result.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return { date: dateStr, display, daysFromNow: daysToAdd };
}
```

### ReAct Agent Loop (LLMService.ts)
```typescript
// Endpoint: https://api.studio.nebius.ai/v1/
// Model: Qwen/Qwen3-235B-A22B
// Max iterations: 10
// On timeout (>15s): fall back to parseTasksBasic()

// SYSTEM PROMPT — keep it short and direct:
`You are Lumi, a smart daily scheduler.
Analyze the user's tasks. Use tools to enrich each task.
When user says "tomorrow/in X days/next week" → call calculate_date FIRST.
After all tasks analyzed → call build_schedule.
Output: optimized DailySchedule. Respond in ${language}.
User: ${profile.name}, transport: ${profile.transportType}, 
routine: ${profile.morningRoutineMinutes}min, home: ${profile.homeAddress}
Today: ${date}, time: ${currentTime}`
```

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
      "env": { "APP_ENV": "development" }
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
    LLMService.ts          ← ReAct agent + 12 tools
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

