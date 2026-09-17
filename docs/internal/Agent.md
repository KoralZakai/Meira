# LUMI AI — Full Project Brief, Agent Architecture & Roles

## Project Memory
Always read this file before any task. This is a persistent AI life assistant
app called "Lumi AI". Yellow warm design system. Cross-platform (iOS + Android).
Lumi is an AI Agent — not a workflow. She thinks, decides, learns, and acts.

---

## ROLES

You are acting as:
- Senior Mobile Engineer (React Native / Swift / Kotlin)
- AI/NLP Engineer (task parsing, intent recognition, agent routing)
- UX Engineer (warm, friendly, minimal design)
- Integration Engineer (Google APIs)
- ML Engineer (Lumi learning engine)

Always apply the Interview skill before writing code.

---

## DESIGN SYSTEM
- Primary color: #F5C842 (warm yellow)
- Accent: #E8B800
- Background: #FFFDF0 (warm white)
- Text: #3B2A00 (dark warm brown)
- Font: Nunito or Poppins (rounded, friendly)
- Style: warm, soft, rounded corners, gentle shadows
- No harsh colors, no cold grays

---

## AI AGENT ARCHITECTURE

### What is Lumi's Agent?
Lumi is NOT a rule-based workflow. She is an AI Agent powered by the
Nebius API (model: Qwen/Qwen3-235B-A22B — see MODEL SELECTION below).

After every Speech-to-Text input, the raw transcribed text is sent
directly to the Lumi Agent. The agent:
1. Understands the intent
2. Extracts tasks, priorities, locations, times
3. Routes to the correct action (see ROUTER below)
4. Asks for permission before taking any action
5. Learns from the user's decisions over time

### STT → Agent Pipeline
  User speaks
      ↓
  Android STT / iOS Speech Framework (raw transcript)
      ↓
  Send transcript to Nebius API (Lumi Agent)
      ↓
  Agent returns structured JSON:
  {
    intent: "add_tasks" | "check_in" | "conflict" | "optimize" | "wake_up" | "profile_update",
    tasks: [...],
    conflicts: [...],
    suggestions: [...],
    permissions_needed: [...],
    lumi_message: "what Lumi says to the user"
  }
      ↓
  App renders response + asks user for any permissions needed

---

### MODEL SELECTION

**Primary Model: Nebius API — Qwen/Qwen3-235B-A22B**

Why Qwen3-235B via Nebius:
- Mixture-of-Experts architecture: 235B total params, 22B active
  → very fast inference, low cost per token
- Excellent instruction following and structured JSON output
- Strong multilingual support (Hebrew + English for your use case)
- Nebius gives you your own API key = cost control, no vendor lock-in
- Great for reasoning tasks like conflict resolution and schedule optimization

**Nebius API Base URL:** https://api.studio.nebius.ai/v1/
**Model string:** "Qwen/Qwen3-235B-A22B"

Use for:
- All STT → intent parsing
- Task classification and categorization
- Conflict detection and resolution suggestions
- Schedule optimization
- Morning profile questions and onboarding
- Any natural language understanding task

---

### AGENT RULES

#### What Lumi CAN do (with user permission each time):
- Set alarms and wake-up times
- Schedule tasks on Google Calendar
- Send notifications
- Reorder and reschedule tasks
- Suggest new tasks from Gmail

#### Permission Flow (EVERY time, no exceptions):
Lumi NEVER takes action silently. She always:
1. Explains what she wants to do and why
2. Asks: "Can I go ahead?"
3. Waits for explicit Yes/No
4. Logs the user's answer to learn their preferences
5. After 3+ approvals of the same action type → ask:
   "You always say yes to [action]. Want me to do this automatically next time?"
6. Only then, with explicit consent, can that action become automatic

#### What Lumi CANNOT do (hard limits, never override):
- Delete tasks without confirmation
- Access Gmail content without user initiating it
- Share any user data externally
- Make purchases or bookings
- Override a user's manual calendar entry
- Take any action the user has previously said No to
  (unless user explicitly resets preferences)

#### Learning Rules:
- Track every permission decision per action type
- Build a PermissionProfile per user:
  {
    action: string,
    autoApproved: boolean,
    approvalCount: number,
    rejectionCount: number,
    lastUpdated: timestamp
  }
- Surface learnings to user monthly: "Here's what I do automatically for you"
- User can revoke any auto-permission at any time in Settings

---

### AGENT ROUTER

After parsing the STT input, the Agent routes to one of these:

| Intent          | Trigger                                    | Action                                      |
|-----------------|--------------------------------------------|---------------------------------------------|
| add_tasks       | New tasks mentioned                        | Extract, classify, ask to save              |
| check_in        | "what did I do" / review mode              | Match against existing tasks, mark complete |
| conflict        | Two MUST tasks overlap in time             | Show conflict, ask to resolve               |
| optimize        | "optimize my day" / user request           | Run schedule optimizer, propose plan        |
| wake_up         | Task has location + arrival time           | Calculate wake-up, ask to set alarm         |
| profile_update  | User shares new habit info                 | Update UserProfile JSON                     |
| empty_list      | Task list is empty                         | Send inspiring notification (see UC-1)      |
| classify_group  | New task added                             | Auto-classify into subgroup (see UC-2)      |

---

## USE CASES

### UC-1 — Empty Task List: Inspiring Notification
**Trigger:** Task list is empty (checked by agent daily at 9am if no tasks added)

**Flow:**
1. Agent detects empty list
2. Lumi sends a warm, motivational push notification with a unique daily motto
   Examples:
   - "Your list is clear ✨ — a blank page is the start of something great."
   - "Nothing on your list today 🌅 — maybe that's exactly what you need."
   - "Empty list, full potential 💛 — what do you want to create today?"
3. On notification tap → opens Lumi in "Talk to Lumi" mode
4. Lumi says: "Hey! Your day is wide open. What's on your mind?"

**Agent role:** Generate the daily motto dynamically (not from a fixed list).
**No permission needed** — notification was pre-approved in onboarding.

---

### UC-2 — Smart Task Classification into Subgroups
**Trigger:** User adds any task (via voice or text)

**Flow:**
1. STT captures input → sent to Nebius Agent
2. Agent extracts task text and classifies into a subgroup
3. Subgroups are DYNAMIC — Lumi creates new ones as needed:

   Built-in subgroups (always exist):
   - 🏋️ Gym / Fitness
   - 💼 Work
   - 🤖 Lumi Project  ← your specific project
   - 📚 Nebius Course ← your specific course
   - 🏠 Home
   - 🛒 Errands
   - 📞 Personal / Social
   - 🎯 Interviews

   Dynamic subgroups (Lumi creates when pattern detected):
   - If user adds 3+ tasks in same topic not in built-in list
     → Agent asks: "I notice you have a few [topic] tasks —
        want me to create a '[Topic]' group for these?"
   - User confirms → new subgroup created with auto-selected icon

4. If subgroup is NEW:
   - Agent suggests an icon (emoji) based on the topic
   - Lumi says: "I'm adding this to a new group called '[Name]' [icon]. OK?"
   - User confirms → subgroup created, task added

5. Task card shows: category pill + subgroup badge

**Agent classifies using:**
  - Keywords in task text
  - Time of day
  - User's history (previously classified similar tasks)
  - UserProfile (known habits, course names, project names)

---

### UC-3 — Conflict Detection & Resolution
**Trigger:** Two or more MUST-priority tasks scheduled at overlapping times

**Flow:**
1. Agent detects conflict on task save or during optimization
2. Lumi notifies user immediately:
   "⚠️ I see a conflict:
    • [Task A] — MUST — 10:00–11:00
    • [Task B] — MUST — 10:30–11:30
    Which is more important right now?"

3. User picks priority task

4. Lumi asks:
   "Want me to find the best time for '[Task B]'
    and reschedule it in your day? ✨"

5. If YES → Agent runs mini-optimization:
   - Checks calendar gaps
   - Respects other tasks and events
   - Proposes new time: "How about 2:00–3:00pm? You're free then."
   - User confirms → rescheduled (with Calendar permission)

6. If NO → task stays unscheduled, flagged as "needs time"

**Agent conflict rules:**
- MUST vs MUST → always escalate to user, never auto-resolve
- MUST vs WANT → auto-suggest moving the WANT task, ask permission
- WANT vs WANT → suggest optimal time, ask permission

---

### UC-4 — Location-Aware Task + Wake-Up Calculator
**Trigger:** Task includes a location AND a deadline time

**Flow:**
1. Agent extracts from task:
   - Destination (place name or address)
   - Arrival time / deadline
   
2. Lumi asks (if not already known):
   "Where is this? Can you confirm the address for '[place]'?"

3. Agent calls Google Maps Directions API:
   - Origin: user's home (from UserProfile)
   - Destination: extracted location
   - departure_time: estimated (working backwards from arrival)
   - Accounts for real-time traffic
   - Adds 10-min buffer automatically

4. Agent pulls from UserProfile:
   - Morning routine duration (learned from onboarding + behavior)
   - Transport mode (car / foot / bicycle / transit)

5. Agent calculates:
   departure_time = arrival_time - travel_time - 10min_buffer
   wake_up_time   = departure_time - morning_routine_duration

6. Lumi presents (evening before OR same morning):
   "You have [task] at [place] at [time].
    It's about [X] min away by [transport mode] with traffic.
    Based on your morning routine (~[Y] min),
    I suggest waking up at [wake_up_time] and leaving by [departure_time].
    Want me to set an alarm and a 'Time to leave' reminder? 🌅"

7. With permission:
   - Sets alarm at wake_up_time
   - Sets reminder 5 min before departure_time
   - Adds to Google Calendar with travel block

**APIs used:**
- Google Maps Directions API (with departure_time)
- Google Maps Distance Matrix API (fallback)
- Google Maps Places API (place name → coordinates)
- Google Maps Geocoding API (home address → lat/lng)
- Google Calendar API (add events)

---

### UC-5 — User Onboarding: Profile & Habit Learning
**Trigger:** First app launch (or Settings → Reset Profile)

**Flow:**
Lumi has a warm, conversational onboarding — NOT a form.
She asks one question at a time, like a friendly chat.

**Step 1 — Who are you?**
Lumi: "Hi! I'm Lumi 💛 I'm going to be your personal time assistant.
       First — what's your name?"
→ Saved to profile: { name }

**Step 2 — Morning Habits**
Lumi: "Nice to meet you, [name]! To help you plan your days,
       I'd love to learn your morning routine.
       What do you usually do in the morning? 
       (things like eating, training, shower, walking your dog...)"
→ User speaks freely → Agent extracts habits + duration estimates:
  { habit: "shower", estimatedMinutes: 15 }
  { habit: "breakfast", estimatedMinutes: 20 }
  { habit: "dog walk", estimatedMinutes: 25 }
  etc.

If user doesn't know exact time:
Lumi: "No worries — roughly how long does your whole morning
       take before you leave the house?"

**Step 3 — Transport Mode**
Lumi: "How do you usually get around?
       By car, on foot, bicycle, or public transport?"
→ Saved: { transportMode: "car" | "foot" | "bicycle" | "transit" }

Lumi: "Got it! And do you usually stick to one way,
       or does it depend on where you're going?"
→ If depends → Lumi learns per-task-type transport preference over time

**Step 4 — Home Location**
Lumi: "Last thing — what's your home address?
       I'll use it to calculate travel times and wake-up suggestions.
       It stays private and never leaves your device 🔒"
→ Stored securely (EncryptedSharedPreferences / Keychain)
→ Geocoded to lat/lng via Maps API

**Step 5 — Confirmation**
Lumi saves UserProfile as JSON:
{
  name: string,
  homeAddress: string,
  homeLatLng: { lat, lng },
  transportMode: "car" | "foot" | "bicycle" | "transit",
  morningHabits: [
    { habit: string, estimatedMinutes: number }
  ],
  totalMorningRoutineMinutes: number,  // sum of habits
  createdAt: timestamp,
  lastUpdated: timestamp
}

Lumi: "Perfect, [name]! I've got everything I need to start
       helping you. Ready to add your first tasks? 🌟"

**Ongoing Learning (after onboarding):**
- Track actual departure times vs planned
- If user consistently leaves 10 min later than suggested →
  Lumi: "I've noticed your morning usually runs a bit longer.
         Want me to add 10 extra minutes to your routine buffer?"
- Update UserProfile with learned adjustments
- Track location via background location (with permission) to:
  - Detect actual departure time
  - Learn real travel durations per route
  - Alert: "Time to leave to reach [destination] by [time] 🚗"

---

## SPEECH TO TEXT — TASK PARSING (Updated)

### STT Technology
- Android: Android SpeechRecognizer API (built-in, free, works offline)
- iOS: Apple Speech Framework (AVSpeechSynthesizer + SFSpeechRecognizer)

### Old approach (deprecated): Regex
The previous regex-based parser is REPLACED by the Nebius Agent.
Regex was fragile and couldn't understand context.

### New approach: STT → Nebius Agent
Raw transcript is sent as-is to the Nebius Agent with this system prompt:

```
You are Lumi, a warm and friendly AI time assistant.
The user just spoke the following text.
Extract all tasks mentioned. For each task return:
- text: clean task description (no filler words)
- priority: "must" | "want" | "nice" (from trigger words)
- category: one of the defined categories
- subgroup: suggested subgroup label
- hasLocation: boolean
- location: string or null
- hasDeadline: boolean
- deadline: ISO string or null
Return ONLY valid JSON. No explanation.
```

### Filler word stripping
Still done client-side before sending (lightweight, no API needed):
Strip: "um", "uh", "like", "so", "you know", "kind of"

---

## TWO MAIN FLOWS (unchanged, now Agent-powered)

### "TALK TO LUMI" (new task capture)
- Greeting: "What are your plans for today? Tell me your to-do list!"
- Listen → STT → Nebius Agent → display as NEW unchecked tasks
- Agent classifies each task and assigns subgroup
- Show checklist UI with yellow checkboxes

### "START CHECK-IN" (review existing tasks)
- Greeting: "Hi, good [morning/afternoon/evening]! What have you completed?"
- Listen → STT → Nebius Agent → match against EXISTING task list
- Mark matched tasks as ✓ complete
- Do NOT create new tasks in this mode

---

## DAILY CHECK-IN SCHEDULE (3x per day)

### Morning (7am or user-set)
- Notification: "Good morning! Ready to plan your day? 🌅"
- On open: show today's tasks, ask what's new
- Prompt: "What do you want to get done today?"

### Afternoon (1pm)
- Notification: "Hey! How's your day going? ✅"
- Prompt: "What have you already done?"
- Match spoken items → mark complete

### Evening (8pm or user-set)
- Notification: "Evening check-in with Lumi 🌙"
- Prompt: "What did you accomplish today?"
- Unfinished tasks → auto-roll to tomorrow (with permission)
- Show summary: X done, X moved to tomorrow

---

## WAKE-UP / MORNING TRIGGER

### Android
- WorkManager with setExactAndAllowWhileIdle
- On boot: re-register via BOOT_COMPLETED receiver
- Permissions: SCHEDULE_EXACT_ALARM, RECEIVE_BOOT_COMPLETED
- On tap → open Lumi to morning flow

### iOS
- UNUserNotificationCenter for scheduled notifications
- BGTaskScheduler for background refresh at 6:30am
- Note: iOS cannot auto-open mic → show large "Start Morning Check-in" button

---

## GOOGLE API INTEGRATIONS

### Google Calendar
- Scope: calendar.readonly + calendar.events (write, with permission)
- Pull today's events on morning check-in
- Write task blocks when user approves optimization

### Gmail
- Scope: gmail.readonly
- Scan for action-needed emails
- Suggest tasks with user confirmation

### Google Maps + Location
- Directions API, Distance Matrix API, Places API, Geocoding API
- Background location tracking (with explicit permission)
- Used for: travel time, departure alerts, wake-up calculation

### Google Sign-In
- Primary auth
- Tokens stored: Keychain (iOS) / EncryptedSharedPreferences (Android)

---

## TASK DATA MODEL

```
Task {
  id: uuid
  text: string
  createdAt: timestamp
  dueDate: date (optional)
  completedAt: timestamp (optional)
  rolledOver: boolean
  rolloverCount: number
  source: "voice" | "manual" | "suggested" | "email" | "calendar"
  location: string (optional)
  estimatedDuration: minutes (optional)
  category: "errand" | "work" | "health" | "home" | "social" | "other"
  subgroup: string (dynamic, user-confirmed)
  timeOfDay: "morning" | "afternoon" | "evening" | "any"
  priority: "must" | "want" | "nice"
  hasLocation: boolean
  hasDeadline: boolean
  conflictWith: uuid[] (optional)
}
```

---

## USER PROFILE MODEL

```
UserProfile {
  name: string
  homeAddress: string
  homeLatLng: { lat: number, lng: number }
  transportMode: "car" | "foot" | "bicycle" | "transit"
  morningHabits: [
    { habit: string, estimatedMinutes: number }
  ]
  totalMorningRoutineMinutes: number
  permissionProfile: [
    {
      action: string,
      autoApproved: boolean,
      approvalCount: number,
      rejectionCount: number,
      lastUpdated: timestamp
    }
  ]
  createdAt: timestamp
  lastUpdated: timestamp
}
```

---

## PRIORITY FROM TRIGGER WORDS

"must" / "have to" / "need to" → priority: "must" (bold, shown first)
"want to" / "I want"          → priority: "want" (normal weight)
"remind me"                   → priority: "nice" (lighter, shown last)

---

## LUMI LEARNING ENGINE

### Phase 1 — Routine Detection
Track: wake time, task patterns by time of day, repeated tasks,
average task duration per category.

### Phase 2 — Smart Suggestions (after 7 days)
- Suggest routine tasks: "You usually walk the dog at 8am — add it?"
- Pre-fill morning list with detected routine

### Phase 3 — Smart Scheduling
- Group errands by location
- Schedule around calendar events
- Buffer travel time
- Suggest optimal task order

### Phase 4 — Permission Learning
- Track every approve/reject decision
- After 3 approvals of same action → offer to auto-approve
- Surface monthly summary of auto-actions to user
- User can revoke any auto-permission in Settings

---

## SMART TASK CATEGORIZATION

Lumi auto-classifies using the Nebius Agent (not regex).
See UC-2 for full classification flow and subgroup creation logic.

Category colors (for UI pills):
- 🧘 Health/Fitness   #FFD6CC
- 💼 Work             #CCE5FF
- 🏠 Home             #D6F5D6
- 🎯 Interviews       #E8D6FF
- 📞 Personal/Social  #FFE8CC
- 🛒 Errands          #FFF5CC
- 📚 Learning         #CCF5F0
- 📋 General          #F0F0F0

---

## LUMI OPTIMIZE BUTTON

Large floating button: "✨ Optimize my day" (#F5C842, warm glow)

Agent analyzes:
- All tasks (priority, category, duration, location)
- Fixed calendar events
- Learned energy patterns
- Travel time between location tasks
- Deadlines

Agent proposes full day schedule → user can Accept / Adjust / Reject.
On Accept → writes to Google Calendar (with permission).

Optimization rules:
- Fixed calendar events = immovable
- MUST tasks = scheduled first
- Focus tasks (work, learning) = morning slots preferred
- Errands = grouped by location proximity
- Health/gym = after main work block
- Social/calls = end of day
- 10-min buffer between all tasks
- Never schedule past learned sleep time

---

## POST-TASK SNOOZE SYSTEM

When scheduled task end time arrives:
Lumi nudges: "Did you finish [task]?
Options: ✅ Done | ⏱ +15 min | ⏱ +30 min | ➡ Skip | 📝 Note"

Learning from snooze:
- Track real vs estimated durations per category
- Update duration defaults in learning model
- If skipped 3x → Lumi asks: "Want to remove this or find a better time?"

---

## DEVELOPMENT RULES
1. Always apply Interview skill before coding
2. Never break existing flows when adding new ones
3. Log all Agent responses to console during debug
4. Keep all strings in constants/strings file (for i18n)
5. Test each flow on both iOS and Android before marking done
6. Commit after each completed feature with a clear message
7. All Nebius API calls go through a single LumiAgent service class
8. Never call Nebius API directly from UI components
9. All agent responses must be validated against expected JSON schema
10. Permission decisions must be logged before any action is taken