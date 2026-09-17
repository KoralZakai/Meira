@AGENTS.md
# LUMI AI — Full Project Brief & Roles

## Project Memory
Always read this file before any task. This is a persistent AI life assistant 
app called "Lumi AI". Yellow warm design system. Cross-platform (iOS + Android).

---

## ROLES

You are acting as:
- Senior Mobile Engineer (React Native / Swift / Kotlin)
- AI/NLP Engineer (task parsing, intent recognition)  
- UX Engineer (warm, friendly, minimal design)
- Integration Engineer (Google APIs)
- ML Engineer (Lumi learning engine)

Always apply the Interview skill before writing code (see ~/.claude/skills/interview/SKILL.md).

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

## FEATURE ROADMAP & TASKS

### 1. SPEECH TO TEXT — TASK PARSING
Status: In progress

Rules for splitting voice input into tasks:

  Trigger words (start of a task):
  "I need to", "I need", "I must", "I have to", 
  "I have", "I want to", "I want", "remind me to"

  Separator words (split into next task):
  "and", "and also", "also", "plus", "as well as", 
  "another thing", "don't forget"

  Example:
  Input: "I need to call the doctor and also buy groceries 
          and I have to pick up the kids"
  Output:
    ☐ Call the doctor
    ☐ Buy groceries  
    ☐ Pick up the kids

  - Strip filler words ("um", "uh", "like", "so")
  - Capitalize first letter of each task
  - Save each task with: { id, text, createdAt, 
    completedAt, source: "voice", timeOfDay }

---

### 2. TWO MAIN FLOWS

#### "TALK TO LUMI" (new task capture)
- Greeting: "What are your plans for today? Tell me your to-do list!"
- Listen → parse → display as NEW unchecked tasks
- Do NOT match existing tasks
- Show checklist UI with yellow checkboxes

#### "START CHECK-IN" (review existing tasks)
- Greeting: "Hi, good [morning/afternoon/evening]! 
  What have you completed?"
- Listen → match against EXISTING task list
- Mark matched tasks as ✓ complete
- Do NOT create new tasks
- Time of day logic:
  - Morning: 5am–12pm
  - Afternoon: 12pm–5pm  
  - Evening: 5pm–10pm

---

### 3. DAILY CHECK-IN SCHEDULE (3x per day)

#### Morning (7am or user-set time)
- Notification: "Good morning! Ready to plan your day? 🌅"
- On open: show today's tasks, ask what's new
- Prompt: "What do you want to get done today?"

#### Afternoon (1pm)
- Notification: "Hey! How's your day going? ✅"
- Prompt: "What have you already done?"
- Match spoken items → mark complete

#### Evening (8pm or user-set time)
- Notification: "Evening check-in with Lumi 🌙"
- Prompt: "What did you accomplish today?"
- Unfinished tasks → auto-roll to tomorrow
- Show summary: X done, X moved to tomorrow

---

### 4. WAKE-UP / MORNING TRIGGER

#### Android
- Use WorkManager with setExactAndAllowWhileIdle
- On boot: re-register alarm via BOOT_COMPLETED receiver
- Permission: SCHEDULE_EXACT_ALARM, RECEIVE_BOOT_COMPLETED
- On notification tap → open Lumi directly to morning flow

#### iOS
- Use UNUserNotificationCenter for scheduled notifications
- Background app refresh for soft wake
- Note: iOS cannot auto-open mic — show a large 
  "Start Morning Check-in" button on launch
- Use BGTaskScheduler for background refresh at 6:30am

---

### 5. GOOGLE API INTEGRATIONS

#### Google Calendar
- Scope: https://www.googleapis.com/auth/calendar.readonly
- Pull today's events on morning check-in
- Show events alongside tasks
- Lumi says: "You have a meeting at 3pm — I'll keep that in mind"

#### Gmail
- Scope: https://www.googleapis.com/auth/gmail.readonly  
- Scan for action-needed emails (flagged, unread from contacts)
- Suggest tasks: "You have an unanswered email from [name] — 
  want me to add 'Reply to [name]' to your list?"

#### Google Maps + Location
- Scope: location (foreground + background when needed)
- For tasks with locations: estimate travel time
- Lumi says: "You need to go to the pharmacy — 
  it's 12 min away, leave by 3:45 to make it before 4pm"

#### Google Sign-In
- Use as primary auth
- Store tokens securely (Keychain / EncryptedSharedPreferences)
- Refresh silently on app open

---

### 6. LUMI LEARNING ENGINE

#### Phase 1 — Routine Detection
Track and learn:
- Wake time (first app open each day)
- Task patterns by time of day
- Repeated daily tasks (shower, food, gym, dog walk, 
  makeup, commute, etc.)
- Average task duration per category

Store as UserRoutine model:
{
  userId, 
  morningTasks: [],    // tasks done before 10am
  afternoonTasks: [],  // tasks done 10am–5pm
  eveningTasks: [],    // tasks done after 5pm
  avgWakeTime,
  avgSleepTime,
  weekdayPattern,
  weekendPattern
}

#### Phase 2 — Smart Suggestions
After 7 days of data:
- Suggest routine tasks automatically: 
  "You usually walk the dog at 8am — want me to add it?"
- Pre-fill morning list with detected routine

#### Phase 3 — Smart Scheduling
- Combine tasks by location (errands near each other)
- Schedule around calendar events
- Respect deadlines
- Buffer travel time using Maps API
- Suggest optimal order:
  "Based on your schedule, I suggest: gym → shower → 
   grocery store (it's on the way to your 11am) → work"

---

### 7. TASK DATA MODEL

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
  timeOfDay: "morning" | "afternoon" | "evening" | "any"
  priority: "must" | "want" | "nice"  // from trigger word
}

---

### 8. PRIORITY FROM TRIGGER WORDS

"must" / "have to" / "need to" → priority: "must"
"want to" / "I want"          → priority: "want"  
"remind me"                   → priority: "nice"

Display:
- "must" tasks: bold, shown first
- "want" tasks: normal weight
- "nice" tasks: lighter, shown last

---

## DEVELOPMENT RULES
1. Always apply Interview skill before coding
2. Never break existing flows when adding new ones
3. Log all AI parsing steps to console during debug
4. Keep all strings in a constants/strings file (for future i18n)
5. Test each flow on both iOS and Android before marking done
6. Commit after each completed feature with a clear message

---

### 9. SMART TASK CATEGORIZATION

Lumi automatically categorizes every task based on keywords in the voice/text input.

CATEGORY RULES (apply in order, first match wins):

  🧘 HEALTH & FITNESS
  Keywords: yoga, gym, workout, training, run, pilates, swim, 
            sport, exercise, class, session, meditation
  Example: "I have yoga class at 19:00" → category: health_fitness
           Display label: "Yoga" | Icon: 🧘

  💼 WORK & PROJECTS  
  Keywords: meeting, call with [name], presentation, deadline, 
            client, project, report, email, task, sprint, standup,
            demo, review code, PR, deploy, Lumi app, app task,
            skill, rule, feature, bug, fix
  Example: "I need to add rules to my Lumi app" → category: work_project
           Display label: "Lumi App" | Icon: 💼

  📅 INTERVIEWS
  Keywords: interview, job interview, hiring, candidate, 
            talent talk, recruiter
  Example: "I have a talent talk at 19:00" → category: interview
           "I need to arrive to an interview at Grant's" → category: interview
           Display label: "Interview" | Icon: 🎯

  📞 PERSONAL & SOCIAL
  Keywords: call [name], mom, dad, family, friend, birthday, 
            dinner with, lunch with, coffee with, meet [name]
  Example: "Need to call mom" → category: personal_social
           Display label: "Personal" | Icon: 📞

  🛒 ERRANDS
  Keywords: buy, shop, grocery, pharmacy, bank, post office, 
            pick up, drop off, return, store
  Example: "Buy groceries" → category: errand
           Display label: "Errand" | Icon: 🛒

  🏠 HOME
  Keywords: clean, laundry, dishes, cook, fix, repair, 
            organize, bills, pay rent
  Example: "Clean the house" → category: home
           Display label: "Home" | Icon: 🏠

  📍 LOCATION-BASED (auto-detect when address/place mentioned)
  Trigger: any task containing a place name, address, city, 
           or "at [place]", "in [place]", "arrive to"
  Example: "Interview at Grant's in Binyamina" → 
           flag: has_location: true, location: "Grant's, Binyamina"

  📋 GENERAL (fallback)
  Everything else that doesn't match above.
  Example: "Need to call mom" if no other match → category: general

---

CATEGORY DISPLAY IN UI:
- Each task card shows a small colored category pill/badge
- Task list can be filtered by category
- Morning summary groups tasks by category

---

### 10. LOCATION-AWARE WAKE-UP CALCULATOR

When a task has a location + deadline time, Lumi calculates 
the optimal wake-up time considering personal habits.

FLOW:

  Step 1 — Extract from task:
  - Destination: "Grant's, Binyamina"
  - Arrival time: "10:00 on June 10"

  Step 2 — Google Maps API:
  - Calculate travel time from home location to destination
  - Consider real-time traffic at that departure hour
  - Add 10 min buffer automatically

  Step 3 — Learn morning habits (from Lumi Learning Engine):
  Pull the user's learned morning routine duration, e.g.:
  - Shower: 15 min
  - Getting dressed: 10 min
  - Breakfast: 20 min
  - Makeup: 20 min (if applicable, learned from pattern)
  - Dog walk: 20 min (if detected in routine)
  - Total learned morning buffer: X minutes

  Step 4 — Calculate:
  departure_time = arrival_time - travel_time - 10min_buffer
  wake_up_time   = departure_time - total_morning_routine_duration

  Step 5 — Notify user:
  Lumi says (evening before or morning of):
  "You have an interview at Grant's in Binyamina at 10:00.
   It's about 35 minutes away with traffic.
   Based on your usual morning routine (~65 minutes),
   I suggest waking up at 8:10 and leaving by 9:15. 
   Want me to set an alarm? 🌅"

  Step 6 — Set alarm (with user confirmation):
  - Create alarm for calculated wake_up_time
  - Create reminder 5 min before departure_time: 
    "Time to leave for your interview! 🚗"

---

WAKE-UP CALCULATOR DATA NEEDED:
- User home address (set in onboarding, stored securely)
- Learned morning routine duration (from Learning Engine)
- Google Maps Directions API with departure_time for traffic
- Google Maps Distance Matrix API as fallback

GOOGLE APIs REQUIRED FOR THIS FEATURE:
- Maps Directions API
- Maps Distance Matrix API  
- Maps Places API (to resolve place names → coordinates)
- Google Calendar API (to auto-detect events with locations)
- Maps Geocoding API (home address → lat/lng)

---

### 11. CATEGORY ICON UI & WIDGET SYSTEM

MAIN SCREEN — CATEGORY ICONS ROW
Display categories as tappable icon bubbles on the home screen:

  🧘 Yoga / Fitness     — soft coral/pink    #FFD6CC
  💼 Work / Lumi App    — soft blue           #CCE5FF
  🏠 Home               — soft green          #D6F5D6
  🎯 Interviews         — soft purple         #E8D6FF
  📞 Personal / Social  — soft peach          #FFE8CC
  🛒 Errands            — soft yellow         #FFF5CC
  📚 Learning           — soft teal           #CCF5F0
  📋 General            — soft gray           #F0F0F0

Each icon:
- Rounded square bubble (like app icons)
- Shows category name below
- Shows badge count of pending tasks
- Warm drop shadow, slightly 3D feel matching Lumi style

ON PRESS — WIDGET POP-UP:
- Slides up from bottom as a modal card (not full screen)
- Shows category title + icon at top
- Lists all tasks in that category as checklist
- Each task has: checkbox | task text | time/date if set
- Background color = light category color
- Can check off tasks directly from widget
- "Add task" button at bottom of widget
- Dismiss by swiping down or tapping outside

---

### 12. CALENDAR VIEW (Day / Week)

Toggle between DAY and WEEK view at top of calendar section.

FEATURES:
- Drag & drop tasks onto time slots
- Stretch/pinch to resize task duration (top or bottom handle)
- Tasks shown as colored blocks (using category colors above)
- Unscheduled tasks shown in a tray below calendar — 
  drag from tray onto calendar to schedule
- Current time shown as red/yellow line
- Tap task block → opens task detail popup

GESTURE SPECS:
  Drag:    long press (300ms) → drag to new time slot
  Resize:  drag top handle = change start time
           drag bottom handle = change end time
  Snap:    tasks snap to 15-minute intervals
  Minimum: task block minimum height = 30 min

WEEK VIEW:
- Horizontal scroll for days
- Tap any day → zoom into day view
- Show category color dots on days with tasks

---

### 13. LUMI OPTIMIZE BUTTON

Large floating button on main screen and calendar:
  Label: "✨ Optimize my day"
  Color: #F5C842 (Lumi yellow), warm glow effect

ON PRESS — LUMI SCHEDULES YOUR DAY:
Lumi analyzes:
  - All tasks for today (priority, category, duration estimate)
  - Calendar events (fixed, cannot move)
  - Learned energy patterns (user is more focused in morning?)
  - Travel time between location tasks
  - Deadlines

Output — Lumi proposes a full day schedule, e.g.:
  "Here's your optimized day ✨
   
   08:00 – 11:00  📚 Lecture prep (3 hrs)
   11:00 – 16:00  💼 AI Agent project (5 hrs)  
   16:00 – 18:00  🧘 Gym (2 hrs)
   18:30 – 19:00  📞 Call mom
   19:00 – 19:30  🎯 Talent Talk
   
   Want me to apply this to your calendar?"

User can:
  - Accept all → blocks applied to calendar
  - Drag to adjust within the proposal
  - Reject individual items
  - Tap "Apply" → tasks populate calendar with colored blocks

OPTIMIZATION RULES:
  - Fixed events (calendar) = cannot move
  - "Must" priority tasks = scheduled first
  - Focus tasks (work, learning) = morning slots preferred
  - Errands = grouped together, near each other on map
  - Health/gym = after main work block
  - Social/calls = end of day
  - Leave 10 min buffer between tasks
  - Never schedule past user's learned sleep time

---

### 14. POST-TASK SNOOZE SYSTEM

When a task's scheduled end time arrives, Lumi sends a 
notification/in-app nudge:

SNOOZE MESSAGE (personalized per category):

  Generic:
  "Hey! Did you finish [task name]? ✅
   Options: Done ✓ | Need 15 more min ⏱ | Skip for now →"

  Next task reminder included:
  "Up next: [next task name] starting now.
   Don't forget: [any related task or deadline reminder]"

  Examples by category:
  
  After gym:
  "Great workout? 💪 Mark gym as done?
   Up next: Shower → then AI project at 4pm"

  After work block:
  "Did you finish the AI agent work? 
   Need more time or moving on?
   Next up: Call mom at 6pm 📞"

  After errand:
  "Did you pick everything up? 🛒
   Next stop: [next location task if nearby]"

SNOOZE OPTIONS:
  ✅ Done         → mark complete, show next task
  ⏱ +15 min      → reschedule block, push next task
  ⏱ +30 min      → same
  ➡ Skip          → mark skipped, move to tomorrow
  📝 Add note     → user can speak/type what happened

LEARNING FROM SNOOZE:
  Track per category:
  - How often user needs more time
  - Average real duration vs estimated
  - Update duration estimates in learning model:
    e.g. "Gym always takes 2.5 hrs not 2 — update default"
  - If task skipped 3x → Lumi asks:
    "You keep skipping [task] — want to remove it 
     or find a better time for it?"