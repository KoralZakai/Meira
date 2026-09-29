import type { RouteFailure } from '../utils/routeFailure';

export type TaskCategory =
  | 'interview'    // ראיונות עבודה
  | 'course'       // קורס
  | 'conference'   // כנסים
  | 'class'        // שיעורים
  | 'work'         // עבודה
  | 'meeting'      // פגישה
  | 'call'         // שיחת טלפון
  | 'doctor'       // תור לרופא
  | 'gym'          // אימון
  | 'aspiration'   // שאיפות
  | 'leisure'      // פנאי
  | 'general'      // כללי
  | 'zoom'         // זום
  | 'hobby_class'; // חוגים

export type TaskPriority = 'must' | 'have_to' | 'need_to' | 'nice_to_do';
/** Lifecycle of a task's real phone alarm — see Task.alarmState. */
export type AlarmState = 'not_needed' | 'planned' | 'armed';

export type TaskStatus = 'pending' | 'complete' | 'missed' | 'moved' | 'partial';
export type TransportType = 'bus' | 'train' | 'car' | 'walk' | 'bike';
export type AppLanguage = 'en' | 'he';
export type AppTheme = 'light' | 'dark';

export interface TransitLeg {
  type: 'walk' | 'bus' | 'train' | 'subway' | 'car' | 'bike';
  from: string;
  to: string;
  durationMinutes: number;
  departureTime: string;
  arrivalTime: string;
  lineNumber?: string;
  stopName?: string;
  stopLat?: number;
  stopLng?: number;
  /**
   * The direction sign on the platform — Google's `transit_details.headsign`.
   *
   * Koral: "for trains it's important מספר רציף. if we check many optionals of
   * train they are from other platform." Google's Directions API does not
   * return a platform number anywhere in Israel, and inventing one would be
   * the worst possible lie to tell someone running for a train. The direction
   * is what the departure boards are actually organised by, and it is the
   * thing that distinguishes two trains leaving the same station minutes
   * apart, so it is what we show.
   */
  headsign?: string;
  /**
   * The literal platform, when a provider gives one. Google does not, for any
   * Israeli station — the field exists so that the day one does, nothing has
   * to be redesigned, and so that "we don't have it" is a readable state
   * rather than an absent concept.
   */
  platform?: string;
}

export interface TransitPlan {
  /**
   * Where this plan was computed FROM.
   *
   * Without it a stored plan cannot be told apart from a wrong one: a route
   * worked out from home stays valid-looking forever, even after another task
   * is scheduled ahead of it and the journey should really start from there.
   * Absent on plans computed before this field existed — treat that as unknown.
   */
  originAddress?: string;
  /**
   * What to CALL the origin on screen: "Home", "My location now", or a place
   * she named. originAddress can be a bare "32.06,34.78" — honest as an input
   * to Google, useless as a label on a card.
   */
  originLabel?: string;
  totalDurationMinutes: number;
  leaveHomeAt: string;
  arriveAt: string;
  firstBusDeparture: string;
  firstBusStop: string;
  walkToStopMinutes: number;
  legs: TransitLeg[];
  /** Google encoded overview polyline — drawn by RouteMap (EAS builds). */
  overviewPolyline?: string;
  /** Route start point (home or shared location) for the map markers. */
  startLat?: number;
  startLng?: number;
  /**
   * Route END point — where the journey actually finishes.
   *
   * Google Directions returns it in the same leg the travel time comes from,
   * and it was being discarded. A task whose `location` arrived as a bare
   * address string had no coordinates at all, so the map had nothing to pin
   * and every site invented 0,0 instead (see utils/placeCoords). This is the
   * free, authoritative answer: the door Google routed us to.
   */
  destLat?: number;
  destLng?: number;
  source: 'google' | 'manual';
  /**
   * Which version of the CHOOSING rules produced this plan.
   *
   * A stored route is refreshed only when it is old AND its departure is near
   * — sensible for traffic, useless when the rules themselves change. On
   * 2026-09-23 the ranker learned to leave a `must` half an hour of margin,
   * and her interview that afternoon kept the plan chosen by the old rule:
   * arriving 14:29 for 14:30, with the next recompute due at 10:39 the same
   * morning. A plan chosen by rules we no longer believe in is stale whatever
   * its age. See ROUTE_RULES_VERSION in services/GoogleSync.
   */
  rulesVersion?: number;
  /**
   * The vehicle she asked for, recorded ONLY when the route could not honour
   * it. Google's `transit_mode` is a preference, not a filter: ask for rail on
   * a corridor with no train and it returns the bus anyway. Without this the
   * card shows a bus under a selected train chip and says nothing, which reads
   * as the app ignoring her.
   */
  unavailableMode?: TransportType;
  fetchedAt: number;
}

export interface TaskLocation {
  address: string;
  displayName?: string;
  lat: number;
  lng: number;
  travelMinutes?: number;
  wakeUpBy?: string;
  leaveHomeBy?: string;
  confirmed: boolean;
  /**
   * She asked for this mode and NO route of that kind exists at all.
   * Distinct from a missing plan (not computed yet) and from a plan carrying
   * `unavailableMode` (a route was found, on the wrong vehicle). Train is
   * strict: rather than hand back a bus, the planner returns nothing and this
   * records why, so the card can say so instead of showing a stale journey.
   */
  noRouteForMode?: TransportType;
  /**
   * WHY there is no route — Google's own verdict, not our guess.
   *
   * `noRouteForMode` above records only THAT a mode came back empty. It was
   * rendered as "no route for the chosen way of getting there", which is a
   * claim about transport, while her Google console showed the Directions API
   * at a 99% error rate: every lookup rejected before any routing ran. The
   * app had never received a route and was reporting there was no train.
   *
   * Set by GoogleSync from utils/routeFailure; undefined once a route lands.
   */
  routeFailure?: RouteFailure;
  transitPlan?: TransitPlan;
  missedBusHandled?: boolean;
  /** Per-task transport override; the profile's transportType is the fallback. */
  transportType?: TransportType;
  /**
   * Why the vehicle on this plan is not the one she asked for — e.g.
   * "No train to Ra'anana — bus instead". Set by the rail-first ladder in
   * utils/transitFallback; undefined when she got what she wanted.
   */
  modeNote?: string;
  /**
   * Where a two-mode journey changes over — "Hadera West". A real Israeli
   * trip is often train to a station and then a lift, and asking a single-mode
   * router for that is what produced a 06:00 departure for a 10:00 interview:
   * it finished the last ten kilometres on foot. See MultiModalPlanner.
   */
  viaStation?: string;
  /** How the last mile is covered from `viaStation`. */
  lastLegMode?: 'car' | 'taxi' | 'bike' | 'scooter' | 'walk';
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

/**
 * A researched pre-meeting brief, stored ON the task.
 *
 * See utils/briefDigest. Kept in both languages because it is a cache: a
 * settings change must not cost another Tavily search.
 */
export interface TaskBrief {
  headlineHe?: string;
  headlineEn?: string;
  linesHe: string[];
  linesEn: string[];
  questionsHe: string[];
  questionsEn: string[];
  confidence?: 'high' | 'medium' | 'low';
  fetchedAt: number;
}

export interface Task {
  id: string;
  text: string;
  category?: TaskCategory;
  priority?: TaskPriority;
  isFixed: boolean;
  fixedTime?: string;
  durationMinutes: number;
  actualDurationMinutes?: number;
  date: string;
  status: TaskStatus;
  progress?: string;
  subtasks?: Subtask[];
  deadline?: string;
  deadlineTime?: string;
  estimatedWorkMinutes?: number;
  latestStartBy?: string;
  scheduledTime?: string;
  /**
   * How early to warn, in minutes before fixedTime — several offsets allowed
   * ([1440, 120, 30] = evening before, 2 h, 30 min). Unset means "decide from
   * the category and what you've learned about me" (see utils/leadTime).
   */
  remindMinutesBefore?: number[];
  /** A standalone alarm at an absolute HH:MM, independent of the task's time. */
  alarmAt?: string;
  /**
   * Whether this task needs a REAL phone alarm, and whether one is actually set.
   *
   * Android's ACTION_SET_ALARM carries no date — it rings at the next occurrence
   * of HH:MM — so an alarm for an interview 12 days out cannot be set when the
   * task is created. It has to be planned now and armed once the ring time comes
   * within reach. Without this field there was no way to know which it was, so a
   * far-future task simply never got an alarm at all.
   *
   *   not_needed — nothing to ring for (afternoon/evening task, or no travel)
   *   planned    — needed, alarmAt is computed, NOT yet set on the phone
   *   armed      — physically set via ACTION_SET_ALARM
   */
  alarmState?: AlarmState;
  /** When the physical alarm was actually set (epoch ms). Set with 'armed'. */
  alarmArmedAt?: number;
  endTime?: string;              // HH:MM — end of the from→to time range (start is fixedTime)
  repeatDays?: number[];         // weekdays this task repeats on: 0=Sun … 6=Sat
  location?: TaskLocation | string;
  /**
   * WHAT KIND of place this task happens at ("חדר כושר", "משרד") when the user
   * named a kind without naming an address. It is the key Lumi remembers a
   * real address against, so "אימון בחדר כושר" only has to be answered once.
   * See utils/hebrewPlace and the server's known_places.
   */
  activityKey?: string;
  contact?: TaskContact;
  gmailThreadId?: string;
  calendarEventId?: string;
  verifiedArrival?: boolean;
  completedAt?: number | null;
  /**
   * When she explicitly UNticked it. Without this, "completion always wins"
   * in dedupeTasks cannot tell a task that was never done from one she has
   * just corrected, so a completed duplicate twin silently re-ticks it.
   */
  uncompletedAt?: number | null;
  createdAt: number;
  movedFromDate?: string;
  historicalDurations: number[];
  notificationIds?: string[];
  /**
   * What Lumi found out about the people in this meeting — written onto the
   * task so it is there when she opens it, and used as the body of the
   * night-before and hour-before alerts. utils/briefDigest builds it,
   * MeetingBriefService fetches it.
   */
  brief?: TaskBrief;
  // Additional convenience fields
  tags?: string[];
  subgroup?: string;
  /**
   * The task this one belongs under, e.g. "fix the notifications bug" sitting
   * under "improve Lumi".
   *
   * A real parent link rather than the existing `subtasks: Subtask[]`, because
   * a child here is a full task: it can have its own time, place, contact and
   * alerts. A Subtask cannot. Deliberately ONE level deep — a parent never has
   * a parent — so the list can never become a tree nobody can scan.
   */
  parentId?: string;
  dueDate?: string;
  how?: string;
  why?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  /** Video-call URL. Kept OUT of `location`, which means "a place to travel to". */
  meetingUrl?: string;
  /** Attendee emails from the calendar invite, for "tell them I'm late". */
  attendees?: string[];
  // whatsapp/gcal/gmail/calendar rows are written server-side and treated as
  // external by the sync layer (never deleted-by-absence; tombstoned on delete).
  /**
   * Where this task came from. 'voice' is speech in the app, 'chat' is the
   * in-app Coach tab, 'whatsapp' arrived over the bot. These were long
   * conflated — addTasksForDate stamped every task it created 'voice'
   * regardless of origin — which made a WhatsApp task indistinguishable
   * from a spoken one and left provenance unanswerable.
   */
  source?: 'voice' | 'chat' | 'manual' | 'suggested' | 'email' | 'calendar' | 'whatsapp' | 'gcal' | 'gmail';
  hasLocation?: boolean;
  hasDeadline?: boolean;
  locationLat?: number;
  locationLng?: number;
  lastNearbyReminderAt?: number;
  lastWakeReminderAt?: number;
  lastDepartureDetectedAt?: number;
  /**
   * Where she actually was when she left — the GPS fix taken at the moment
   * "I left ✓" was tapped (or the departure was detected). Local-only on
   * purpose: there is no column for it in Supabase, and it is a same-day
   * signal (travel-time learning, arrival verification), not history worth
   * syncing. See services/LiveRoute.confirmDeparture.
   */
  departedFromLat?: number;
  departedFromLng?: number;
  lastArrivalDetectedAt?: number;
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
  lumiSummary: string;
  lumiSummaryHe: string;
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
  defaultWakeTime: string;
  sleepTime: string;
  googleConnected: boolean;
  createdAt: number;
  /**
   * Per-category minutes-before that Lumi has measured for this user, e.g.
   * "you need 45 min of warning for interviews, not 30". Consumed by
   * utils/leadTime.resolveLeadMinutes, which has documented this field since
   * it was written; nothing populated it until the learning engine was wired.
   */
  learnedLeadMinutes?: Partial<Record<TaskCategory, number>>;
  // ─── MBTI / personality (optional; populated by Quick MBTI + behavioral learning) ───
  mbtiType?: MBTIType;
  mbtiProfile?: MBTIProfile;
  mbtiAssessmentComplete?: boolean;
  // ─── WhatsApp ───
  whatsAppPhone?: string;
  whatsAppConnected?: boolean;
  // ─── Knowledge base ───
  knowledgeBase?: UserKnowledgeBase;
}

// ─────────────────────────────────────────────────────────────
// MBTI PERSONALITY
// ─────────────────────────────────────────────────────────────

export type MBTIType =
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP';

export type MBTIDichotomy = 'E/I' | 'S/N' | 'T/F' | 'J/P';

// Unions kept broad on purpose: they must cover every value used in
// src/constants/mbti.ts (which is the source of truth for the 16 profiles).
export type MBTIPace = 'steady' | 'balanced' | 'flexible' | 'aggressive';
export type MBTIDeadlineStyle = 'early_bird' | 'deadline_driven' | 'flexible';
export type MBTISocialOverload = 'needs_breaks' | 'energized_by_interaction';
export type MBTIRiskTolerance = 'conservative' | 'balanced' | 'experimental' | 'aggressive';
export type MBTICommunicationStyle =
  | 'direct' | 'diplomatic' | 'analytical' | 'debating'
  | 'values_driven' | 'authentic' | 'inspiring' | 'enthusiastic' | 'warm';

export interface MBTIProfile {
  type: MBTIType;
  name: string;
  emoji: string;
  energySource: 'Extrovert' | 'Introvert';
  informationProcessing: 'Sensing' | 'iNtuition';
  decisionMaking: 'Thinking' | 'Feeling';
  lifeOrientation: 'Judging' | 'Perceiving';
  pacePreference: MBTIPace;
  deadlineStyle: MBTIDeadlineStyle;
  socialOverload: MBTISocialOverload;
  riskTolerance: MBTIRiskTolerance;
  communicationStyle: MBTICommunicationStyle;
}

export type PersonalitySignalType =
  | 'suggestion_accepted' | 'suggestion_rejected'
  | 'detail_requested' | 'big_picture_preferred'
  | 'logic_motivated' | 'emotion_motivated'
  | 'fixed_task_completed' | 'flexible_task_completed';

export interface PersonalitySignal {
  id: string;
  userId: string;
  signalType: PersonalitySignalType;
  dichotomy: MBTIDichotomy;
  confidence: number; // 0-1
  timestamp: number;
}

export interface LearnedPersonality {
  userId: string;
  quickAssessmentType?: MBTIType;
  quickAssessmentConfidence: number; // ~0.4
  behavioralType?: MBTIType;
  behavioralConfidence?: number; // 0.3 → 0.9
  finalType: MBTIType;
  finalConfidence: number;
  signalCount: number;
  lastUpdated: number;
}

/**
 * Resumable progress through the full 30-question MBTI quiz (see MBTI_QUESTIONS
 * in src/constants/mbti.ts, delivered in sections of 5). Persisted locally
 * (AsyncStorage) and to the cloud (Supabase `personality_quiz` table) so the
 * user can stop after any section and continue later — and so the same memory
 * (next question + full answer history) is available across devices.
 *
 * `answers` maps a question id → the chosen letter ('E'|'I'|'S'|'N'|'T'|'F'|'J'|'P');
 * running scores are DERIVED from it, so resume is exact and idempotent.
 */
export interface QuizProgress {
  /** questionId → chosen letter. The full answer history. */
  answers: Record<string, string>;
  /** Index (0-based) of the next section of 5 the user should see. */
  sectionIndex: number;
  /** True once all questions are answered and a type was derived. */
  completed: boolean;
  /** Derived 4-letter type, set only when `completed` is true. */
  finalType?: MBTIType;
  /** Epoch ms of the last save — used for last-write-wins across devices. */
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────
// KNOWLEDGE BASE
// ─────────────────────────────────────────────────────────────

export interface KBEntry {
  id: string;
  category: 'belief' | 'policy' | 'happiness_driver' | 'energy_pattern' | 'value';
  text: string;
  context?: string;
  source?: 'user_entered' | 'selected_book' | 'company_policy';
  active: boolean;
  createdAt: number;
}

export interface UserKnowledgeBase {
  userId: string;
  entries: KBEntry[];
  lastUpdated: number;
}

// ─────────────────────────────────────────────────────────────
// WHATSAPP
// ─────────────────────────────────────────────────────────────

export interface WhatsAppMessage {
  id: string;
  waMessageId: string;
  userId: string;
  fromPhone: string;
  content: string;
  messageType: 'text' | 'voice' | 'image';
  isFromUser: boolean;
  inferredIntent?: 'create_task' | 'ask_motivation' | 'ask_schedule' | 'other';
  taskCreatedFromMessage?: string;
  timestamp: number;
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
  weeklyHoursByCategory: Partial<Record<TaskCategory, number>>;
  weeklyTaskCountByCategory: Partial<Record<TaskCategory, number>>;
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
  /** The invite's sender. The best single signal for WHICH company this is
   *  with — except when it is a scheduling tool (Comeet, Calendly, lu.ma),
   *  which the server filters out rather than briefing you on the SaaS. */
  organizer?: string;
  /** hangoutLink / conferenceData / a URL found in location or description. */
  meetingUrl?: string;
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
