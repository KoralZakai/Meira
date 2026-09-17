# Lumi Claude Code Playbook

## 1) Product Direction (Condensed)
Build Lumi as a daily AI assistant that:
- Starts user day with proactive check-in and voice-first flow.
- Tracks tasks by morning, afternoon, evening checkpoints.
- Learns routine patterns and optimizes schedule around deadlines and travel time.
- Integrates Google services (Calendar, Gmail, Maps/Routes) to improve planning quality.

## 2) Design Direction (Yellow Warm Cool)
Use a warm-cool contrast system:
- Warm primary: amber/yellow scale for action and energy states.
- Cool secondary: teal/slate scale for calm context and structure.
- Neutral support: soft off-white backgrounds and charcoal text.
- Avoid pure white + neon contrast; use layered gradients and subtle texture.

Token starter:
- --color-warm-50: #FFF7E6
- --color-warm-200: #FFD98A
- --color-warm-500: #F4B400
- --color-cool-100: #DDF2F1
- --color-cool-400: #3FA7A1
- --color-cool-700: #205E61
- --color-bg: #F8F6F2
- --color-text: #1F2933

## 3) Claude Code Team Roles
Use these as explicit task ownership roles in prompts.

1. Product Architect
- Owns requirements, edge cases, and feature boundaries.
- Produces implementation briefs and acceptance criteria.

2. Mobile App Engineer (Expo/React Native)
- Owns UI screens, hooks, app state, navigation, permissions.
- Implements platform-safe notification and background behavior.

3. Voice/AI Engineer
- Owns speech-to-text pipeline, intent extraction, task labeling.
- Owns confidence scoring and fallback question strategy.

4. Integration Engineer (Google APIs)
- Owns OAuth scopes, token lifecycle, API wrappers, quota strategy.
- Adds mock mode and retry/backoff patterns.

5. Scheduling Intelligence Engineer
- Owns routine learning, duration predictions, and task ordering.
- Owns constraints engine (deadlines, commute, user preferences).

6. QA + Release Engineer
- Owns test plan, smoke scripts, platform matrix, release checklist.
- Owns rollback and feature-flag strategy.

7. Privacy/Security Reviewer
- Owns consent UX, data minimization, encryption posture, retention windows.

## 4) Interview Rule (How To Enforce In Claude Code)
Before any non-trivial code change, enforce this gate:
- Ask 3-10 targeted questions in a single batch.
- Cover: spec, design impact, test proof, definition of done.
- Restate one-paragraph execution plan after answers.

Skip interview for:
- Tiny trivial edits.
- Explicit "just do it / no questions" requests.
- Immediate continuation where scope is already clear.
- Read-only diagnostics/reviews.

## 5) Full Task Breakdown by Epic

### Epic A: Voice Input -> Parsed Task -> Labeled Task
Goal: Convert speech into structured tasks reliably.

Tasks:
1. Define speech event schema
- Fields: transcript, sourceLocale, startedAt, endedAt, confidence, rawSegments.
- Add schema validation and safe defaults.

2. Build STT adapter layer
- Interface: startListening, stopListening, cancel, onPartial, onFinal.
- Start with provider abstraction so Android/iOS providers can differ.

3. Add task parsing pipeline
- Step 1: transcript normalization (punctuation/time phrases).
- Step 2: intent extraction (task/create/checkin/query).
- Step 3: entity extraction (when, duration, priority, location).

4. Implement labeling strategy
- Labels: Work, Health, Home, Family, Errand, Travel, Personal, Admin.
- Include confidence score + suggested label list.
- If confidence < threshold, ask one disambiguation question.

5. Persist parse decisions
- Save final label, model confidence, and manual corrections.
- Track correction events to improve future predictions.

Acceptance:
- Voice capture to task creation succeeds in <= 2 user actions.
- Low-confidence transcripts trigger clarification prompt.

### Epic B: Morning/Afternoon/Evening Check-In Loop
Goal: Daily progress loop with carry-forward logic.

Tasks:
1. Define check-in windows
- Morning: planning and priorities.
- Afternoon: progress and blockers.
- Evening: reflection and carry-over.

2. Create check-in question sets
- Morning: top 3 priorities + fixed commitments.
- Afternoon: done/not done + re-plan remaining.
- Evening: completed summary + unfinished rollover.

3. Add unfinished-task rollover
- At day close, move unfinished tasks to next day bucket.
- Preserve original deadline and create warning badges.

4. Implement conversation shortcuts
- "Mark done", "Move to tomorrow", "Need 20 min", "Defer to Friday".

Acceptance:
- Unfinished tasks appear in next-day morning list automatically.
- User can confirm rollover in a single action.

### Epic C: Morning Wake/Proactive Start
Goal: Let users begin day immediately with Lumi.

Android solution:
1. Use local notifications with deep links into check-in screen.
2. Optional foreground service for active morning session timer if needed.
3. Add quick actions in notification (Start Check-In, Snooze 10m).

iOS solution suggestions:
1. Use UNUserNotificationCenter local push with category actions.
2. Open app to check-in intent via deep link.
3. For voice on wake: user taps notification action (true fully autonomous wake is constrained).

Acceptance:
- Notification opens app directly to morning check-in route.
- Snooze action schedules next reminder reliably.

### Epic D: Google API Integrations (Calendar, Gmail, Maps, Location)
Goal: Context-aware schedule optimization.

Tasks:
1. OAuth and scope design
- Calendar read/write (events).
- Gmail read metadata only (start with minimal scope).
- Maps routing and ETA.
- Device location permission + fallback manual location.

2. Integration wrappers
- Create service clients with strict typed response mappers.
- Add retry with exponential backoff and user-friendly error states.

3. Calendar sync strategy
- Pull fixed events for next 24-72h.
- Keep local cache; run incremental sync.

4. Gmail signal extraction (privacy-first)
- Parse only relevant scheduling signals (meeting confirmations, travel updates).
- No full-body retention unless user opts in.

5. Maps + arrival planner
- For location-bound tasks, compute travel time + buffer.
- Suggest "leave by" time and schedule slot accordingly.

Acceptance:
- Commute-aware tasks display leave-by recommendation.
- Calendar conflicts are detected before final schedule save.

### Epic E: Routine Learning + Smart Scheduling
Goal: Learn behavior and optimize timing over time.

Tasks:
1. Event telemetry for learning
- Collect planned duration vs actual completion.
- Collect preferred time windows and skip patterns.

2. Routine model v1 (rules + heuristics)
- Learn morning habits (food/shower/training/dog walk/makeup/etc.).
- Predict realistic duration blocks and sequence templates.

3. Scheduling optimizer
- Inputs: tasks, deadlines, fixed events, commute times, energy window.
- Objective: maximize on-time completion while minimizing context-switch cost.

4. Explainability panel
- Show why Lumi suggested a specific order.
- Let user accept, edit, or reject with one tap.

Acceptance:
- User sees "recommended day plan" with reasons.
- Edits feed back into future recommendations.

## 6) Data Model Starter
Core entities:
- UserProfile
- RoutinePattern
- TaskItem
- TaskCompletionEvent
- CheckInRecord
- CalendarEventMirror
- CommuteEstimate
- SuggestionDecision

High-value fields:
- TaskItem: title, labels[], dueAt, estimatedMinutes, location, priority, status.
- RoutinePattern: activityName, typicalStartRange, typicalDuration, confidence.
- SuggestionDecision: proposedOrder, accepted, edited, rejectionReason.

## 7) Testing Plan (Smallest Happy Paths)
1. Voice happy path
- Speak one task with date/time -> appears with correct label and due time.

2. Check-in happy path
- Morning check-in creates top priorities.
- Afternoon marks one done, one blocked.
- Evening rolls unfinished to next day.

3. Integration happy path
- Calendar sync fetches upcoming events.
- Location task calculates travel and leave-by time.

4. Regression suite
- Existing task CRUD unchanged.
- Notification permissions denied path handled gracefully.

## 8) Definition of Done Checklist
For each feature branch:
1. DEV-ready
- Feature flag present.
- Unit tests for parsing and scheduling logic.
- Manual test notes for Android + iOS.

2. Live-ready
- Crash-free smoke run on physical Android + iOS.
- Privacy copy and permission prompts reviewed.
- Rollback switch documented.

3. Delivery artifacts
- One concise PR summary.
- Before/after behavior notes.
- Known limitations section.

## 9) Suggested Claude Code Task Queue (Copy/Paste)
1. "Create typed schema for speech transcript event + validators."
2. "Refactor SpeechService into provider interface with Android/iOS adapters."
3. "Implement transcript -> intent/entity parser with confidence and tests."
4. "Add task label prediction with disambiguation prompt below threshold."
5. "Implement Morning/Afternoon/Evening check-in states and storage."
6. "Add unfinished-task rollover job to next day with deadline preservation."
7. "Implement notification deep-link actions for morning start (Android first)."
8. "Add Google Calendar sync wrapper and conflict checker with mocks."
9. "Add commute ETA service and leave-by recommendation in task card."
10. "Build routine learning heuristics and explainable schedule recommender."
11. "Write end-to-end smoke script for daily loop from wake to evening review."

## 10) Platform Constraints Notes
- iOS cannot provide unrestricted always-on voice wake like an assistant daemon in normal app mode.
- Use notification action + immediate in-app voice entry as practical iOS pattern.
- On Android, foreground service should be used sparingly and only when justified.

## 11) Execution Rhythm
For each task:
1. Run interview gate (3-5 targeted questions unless skip condition).
2. Restate one-paragraph plan.
3. Implement smallest vertical slice.
4. Verify with happy-path test.
5. Commit with clear rollback note.
