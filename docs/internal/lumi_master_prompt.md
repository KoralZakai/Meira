# LUMI — MASTER CLAUDE CODE PROMPT
# העבר לקלוד קוד ב-VS Code. הוא יקרא את הקוד הקיים ויעדכן רק מה שצריך.
# PASTE THIS ENTIRE FILE INTO CLAUDE CODE IN VS CODE

---

## BEFORE YOU WRITE ANY CODE — READ FIRST

1. List every file in this project
2. Read: package.json, app.json, .env (if exists)
3. Read every file in: src/services/, src/screens/, src/components/, src/types/
4. Identify what exists, what is broken, what is missing
5. Then proceed section by section below
6. DO NOT overwrite .env or app.json unless told explicitly
7. DO NOT delete working code — fix or upgrade it

---

## SECTION 0 — ENVIRONMENT & CONFIG

### .env (CREATE if missing, DO NOT overwrite if exists — only ADD missing keys)
```
EXPO_PUBLIC_NEBIUS_API_KEY=v1.CmMK...        # already exists
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...       # already exists  
EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=123456....apps.googleusercontent.com
```

### app.json — UPDATE these fields only, keep everything else:
```json
{
  "expo": {
    "name": "Lumi",
    "slug": "lumi",
    "version": "1.0.0",
    "orientation": "portrait",
    "platforms": ["android"],
    "android": {
      "package": "com.lumi.app",
      "adaptiveIcon": { "backgroundColor": "#FFD166" },
      "permissions": [
        "RECORD_AUDIO",
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION", 
        "ACCESS_BACKGROUND_LOCATION",
        "READ_CONTACTS",
        "RECEIVE_BOOT_COMPLETED",
        "VIBRATE"
      ]
    },
    "plugins": [
      "expo-router",
      "expo-notifications",
      ["expo-av", { "microphonePermission": "Lumi needs the microphone to hear your tasks." }],
      ["expo-location", {
        "locationAlwaysAndWhenInUsePermission": "Lumi tracks your location to verify you arrived on time.",
        "locationAlwaysPermission": "Lumi needs background location to verify arrivals.",
        "locationWhenInUsePermission": "Lumi uses your location for travel time calculations."
      }],
      ["expo-contacts", { "contactsPermission": "Lumi reads contacts to match names you mention." }],
      ["expo-build-properties", {
        "android": { "newArchEnabled": false }
      }]
    ],
    "extra": {
      "eas": { "projectId": "placeholder" }
    },
    "scheme": "lumi"
  }
}
```

### Install missing packages only (check package.json first):
```bash
npx expo install expo-speech expo-av expo-notifications expo-location
npx expo install expo-contacts expo-auth-session expo-secure-store
npx expo install expo-web-browser expo-dev-client expo-build-properties
npx expo install @react-native-async-storage/async-storage
npx expo install expo-constants expo-router
npm install compromise openai
npx expo install --fix
```

---

## SECTION 1 — TYPES (src/types/index.ts)

OVERWRITE this file completely:

```typescript
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
export type TaskStatus = 'pending' | 'complete' | 'missed' | 'moved' | 'partial';
export type TransportType = 'bus' | 'car' | 'walk' | 'bike';
export type AppLanguage = 'en' | 'he';
export type AppTheme = 'light' | 'dark';

export interface TransitLeg {
  type: 'walk' | 'bus' | 'train' | 'subway';
  from: string;
  to: string;
  durationMinutes: number;
  departureTime: string;
  arrivalTime: string;
  lineNumber?: string;
  stopName?: string;
  stopLat?: number;
  stopLng?: number;
}

export interface TransitPlan {
  totalDurationMinutes: number;
  leaveHomeAt: string;
  arriveAt: string;
  firstBusDeparture: string;
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
  wakeUpBy?: string;
  leaveHomeBy?: string;
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

## SECTION 2 — THEME & CONSTANTS

### src/constants/theme.ts — CREATE or OVERWRITE:
```typescript
export const COLORS = {
  yellow: '#FFD166',
  purple: '#6C63FF',
  purpleLight: '#A89CFF',
  
  // Light mode
  lightBg: '#FFFDF5',
  lightCard: '#FFF8E7',
  lightText: '#2D2D2D',
  lightTextSecondary: '#8A8A9A',
  lightBorder: '#EEE8D5',
  
  // Dark mode
  darkBg: '#1A1A2E',
  darkCard: '#252542',
  darkText: '#F0F0F0',
  darkTextSecondary: '#9090AA',
  darkBorder: '#333355',
  
  // Status
  success: '#06D6A0',
  danger: '#EF476F',
  warning: '#FF9F1C',
  info: '#118AB2',
};

export const CATEGORY_META: Record<string, { color: string; icon: string; labelEn: string; labelHe: string }> = {
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
};

export const PRIORITY_META = {
  must:        { color: '#EF476F', labelEn: 'Must Do',      labelHe: 'חייב לעשות' },
  have_to:     { color: '#FF9F1C', labelEn: 'Have To',      labelHe: 'צריך לעשות' },
  need_to:     { color: '#FFD166', labelEn: 'Need To',      labelHe: 'כדאי לעשות' },
  nice_to_do:  { color: '#06D6A0', labelEn: 'Nice To Do',   labelHe: 'אפשר לעשות' },
};

export const LEVELS = [
  { level: 1, minPoints: 0,    titleEn: 'Getting Started 🌱', titleHe: 'מתחיל 🌱' },
  { level: 2, minPoints: 100,  titleEn: 'Building Momentum 🚀', titleHe: 'בדרך 🚀' },
  { level: 3, minPoints: 300,  titleEn: 'On a Roll 🔥', titleHe: 'בתנופה 🔥' },
  { level: 4, minPoints: 600,  titleEn: 'Time Master ⚡', titleHe: 'מאסטר זמן ⚡' },
  { level: 5, minPoints: 1000, titleEn: 'Lumi Champion 👑', titleHe: 'אלוף לומי 👑' },
];

export const POINTS = {
  task_complete: 10,
  on_time: 20,
  verified_arrival: 25,
  perfect_day: 50,
  streak_bonus: 15,
  task_with_details: 5,
  goal_achieved: 100,
  time_estimate_accurate: 10,
};
```

### src/constants/strings.ts — CREATE or OVERWRITE:
All UI and spoken strings in both languages:
```typescript
export const STRINGS = {
  en: {
    // Greetings
    morningGreeting: "Good morning! What are your plans for today?",
    afternoonGreeting: "Good afternoon! What did you get done?",
    eveningGreeting: "Good evening! Let's wrap up your day.",
    // Listening
    listeningPrompt: "I'm listening...",
    typeInstead: "Type instead",
    // Tasks
    taskConfirm: "Got it! Here are your tasks:",
    noTasks: "You have a free day! Want to add a workout, some reading, or tell me what's on your mind?",
    // Questions Lumi asks
    askDuration: "How long do you think this will take?",
    askDeadline: "When do you need to submit this?",
    askStarted: "Have you started any part of this yet?",
    askConfirmLocation: "Is this the right place?",
    // Transit
    leaveNow: "Time to leave now for {task}! Bus {line} departs {stop} in {minutes} min.",
    missedBus: "Your bus is in {minutes} min and you haven't left yet! Next bus at {next}.",
    arrivedConfirm: "You made it to {place}! Great job! +25 points 🎉",
    // Rewards
    levelUp: "Amazing! You reached level {level}! Keep it up! 🎉",
    streakMessage: "You're on a {streak}-day streak! Unstoppable! 🔥",
    perfectDay: "Perfect day! You completed everything! +50 points 👑",
    timeAccurate: "Spot on! You estimated {task} perfectly! +10 points ⭐",
    // Gap filler
    gapQuestion: "You have {duration} free. What would you like to do?",
    gapSuggestion: "How about: {suggestion}",
    gapReason: "{reason}",
    // Motivational
    motivational: [
      "Every task you complete brings you closer to your goals! 💪",
      "You're doing great — one step at a time! 🚀",
      "Progress, not perfection! Keep going! ⭐",
    ],
    // Time verification popup
    timeVerifyTitle: "How long did {task} actually take?",
    timeVerifyLearned: "Got it! I'll remember {task} takes about {minutes} min for you.",
  },
  he: {
    morningGreeting: "בוקר טוב! מה התוכניות שלך להיום?",
    afternoonGreeting: "צהריים טובים! מה הספקת לעשות?",
    eveningGreeting: "ערב טוב! בואי נסכם את היום.",
    listeningPrompt: "מקשיבה...",
    typeInstead: "הקלד במקום",
    taskConfirm: "מעולה! הנה המשימות שלך:",
    noTasks: "יש לך יום פנוי! רוצה להוסיף אימון, קריאה, או לספר לי מה יש לך?",
    askDuration: "כמה זמן לדעתך זה ייקח?",
    askDeadline: "מתי צריך להגיש?",
    askStarted: "כבר התחלת חלק מזה?",
    askConfirmLocation: "זה המקום הנכון?",
    leaveNow: "הגיע הזמן לצאת ל{task}! אוטובוס {line} יוצא מ{stop} בעוד {minutes} דקות.",
    missedBus: "האוטובוס שלך בעוד {minutes} דקות ועוד לא יצאת! האוטובוס הבא ב-{next}.",
    arrivedConfirm: "הגעת ל{place}! כל הכבוד! +25 נקודות 🎉",
    levelUp: "וואו! הגעת לרמה {level}! המשך כך! 🎉",
    streakMessage: "אתה ב-streak של {streak} ימים! אין לך עצירה! 🔥",
    perfectDay: "יום מושלם! השלמת הכל! +50 נקודות 👑",
    timeAccurate: "מדויק! הערכת את {task} בול! +10 נקודות ⭐",
    gapQuestion: "יש לך {duration} פנויות. מה תרצה לעשות?",
    gapSuggestion: "מה דעתך על: {suggestion}",
    gapReason: "{reason}",
    motivational: [
      "כל משימה שאתה מסיים מקרבת אותך ליעדים שלך! 💪",
      "אתה עושה עבודה נהדרת — צעד אחד בכל פעם! 🚀",
      "התקדמות, לא שלמות! המשך! ⭐",
    ],
    timeVerifyTitle: "כמה זמן {task} לקח לך באמת?",
    timeVerifyLearned: "הבנתי! אזכור ש{task} לוקח לך כ-{minutes} דקות.",
  },
};
```

---

## SECTION 3 — UTILITIES (src/utils/)

### src/utils/timeUtils.ts — CREATE or OVERWRITE:
```typescript
export const getTodayString = (): string => {
  return new Date().toISOString().split('T')[0];
};

export const getTomorrowString = (): string => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
};

export const timeToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const minutesToTime = (minutes: number): string => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export const subtractMinutes = (hhmm: string, mins: number): string =>
  minutesToTime(timeToMinutes(hhmm) - mins);

export const addMinutes = (hhmm: string, mins: number): string =>
  minutesToTime(timeToMinutes(hhmm) + mins);

export const calculateWakeTime = (
  fixedTime: string,
  travelMinutes: number,
  routineMinutes: number,
  bufferMinutes: number = 15
): { wakeBy: string; leaveHomeBy: string } => {
  const leaveHomeBy = subtractMinutes(fixedTime, travelMinutes + bufferMinutes);
  const wakeBy = subtractMinutes(leaveHomeBy, routineMinutes);
  return { wakeBy, leaveHomeBy };
};

export const calculateLatestStartTime = (
  deadlineDate: string,
  deadlineTime: string,
  estimatedMinutes: number,
  bufferMinutes: number = 30
): { date: string; time: string } => {
  const totalBack = estimatedMinutes + bufferMinutes;
  const deadlineTotal = timeToMinutes(deadlineTime);
  if (deadlineTotal >= totalBack) {
    return { date: deadlineDate, time: minutesToTime(deadlineTotal - totalBack) };
  }
  // Goes to previous day
  const prevDate = new Date(deadlineDate);
  prevDate.setDate(prevDate.getDate() - 1);
  return {
    date: prevDate.toISOString().split('T')[0],
    time: minutesToTime(24 * 60 - (totalBack - deadlineTotal)),
  };
};

export const getDaysUntilDeadline = (deadlineDate: string): number => {
  const today = new Date(getTodayString());
  const deadline = new Date(deadlineDate);
  return Math.ceil((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

export const formatDuration = (minutes: number, lang: 'en' | 'he' = 'en'): string => {
  if (minutes < 60) return lang === 'he' ? `${minutes} דק'` : `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return lang === 'he' ? `${h} שעות` : `${h}h`;
  return lang === 'he' ? `${h}ש' ${m}ד'` : `${h}h ${m}m`;
};

export const getSortKey = (task: {
  location?: { leaveHomeBy?: string };
  fixedTime?: string;
  scheduledTime?: string;
}): string => {
  return task.location?.leaveHomeBy || task.fixedTime || task.scheduledTime || '23:59';
};

export const sortTasksByPriorityAndTime = (tasks: any[]): any[] => {
  const priorityOrder: Record<string, number> = {
    must: 0, have_to: 1, need_to: 2, nice_to_do: 3,
  };
  return [...tasks].sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 4;
    const pb = priorityOrder[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return getSortKey(a).localeCompare(getSortKey(b));
  });
};

export const getCurrentPeriod = (): 'morning' | 'afternoon' | 'evening' | null => {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 23) return 'evening';
  return null;
};

export const isExpoGo = (): boolean => {
  try {
    const Constants = require('expo-constants').default;
    return (
      Constants.appOwnership === 'expo' ||
      Constants.executionEnvironment === 'storeClient'
    );
  } catch { return false; }
};
```

### src/utils/fuzzyMatch.ts — CREATE or OVERWRITE:
```typescript
export const fuzzyScore = (a: string, b: string): number => {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  let matches = 0;
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
};

export const findBestMatch = (
  query: string,
  candidates: string[]
): { match: string; score: number; index: number } => {
  let best = { match: '', score: 0, index: -1 };
  candidates.forEach((c, i) => {
    const score = fuzzyScore(query, c);
    if (score > best.score) best = { match: c, score, index: i };
  });
  return best;
};

// Hebrew <-> English name variants for contact matching
export const HEBREW_NAME_VARIANTS: Record<string, string[]> = {
  'דני': ['Danny', 'Dani', 'Daniel', 'דניאל'],
  'יוסי': ['Yossi', 'Yosef', 'Joseph', 'יוסף'],
  'משה': ['Moshe', 'Moshi', 'Moses'],
  'שרה': ['Sarah', 'Sara'],
  'רחל': ['Rachel', 'Racheli'],
  'מירי': ['Miri', 'Miriam', 'מרים'],
  ' איתי': ['Itay', 'Itai'],
  'רון': ['Ron', 'Roni', 'רוני'],
  'גל': ['Gal'],
  'תום': ['Tom', 'Tomer', 'תומר'],
  'נועה': ['Noa', 'Noah'],
  'עידו': ['Ido', 'Eido'],
  'אבי': ['Avi', 'Avraham', 'אברהם'],
  'ליאור': ['Lior'],
  'עמית': ['Amit'],
};

export const getNameVariants = (name: string): string[] => {
  const lower = name.toLowerCase();
  for (const [heb, variants] of Object.entries(HEBREW_NAME_VARIANTS)) {
    if (lower === heb || variants.map(v => v.toLowerCase()).includes(lower)) {
      return [heb, ...variants];
    }
  }
  return [name];
};

// Known place name corrections for Israeli locations
export const PLACE_NAME_CORRECTIONS: Record<string, string> = {
  'igal alon': 'יגאל אלון',
  'איגל אלון': 'יגאל אלון',
  'even gvirol': 'אבן גבירול',
  'dizengof': 'דיזנגוף',
  'biniamina': 'בנימינה',
  'binimina': 'בנימינה',
  'space gym': 'Space Gym',
  'kickbox': 'קיקבוקס',
};

export const correctPlaceName = (text: string): string => {
  let result = text;
  for (const [wrong, correct] of Object.entries(PLACE_NAME_CORRECTIONS)) {
    const regex = new RegExp(wrong, 'gi');
    result = result.replace(regex, correct);
  }
  return result;
};
```

---

## SECTION 4 — STORAGE (src/services/TaskStorage.ts)

CREATE or OVERWRITE with full AsyncStorage CRUD:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Task, DailyLog, DailySchedule, UserProfile, UserStats, RewardEvent, Goal } from '../types';
import { getTodayString, getTomorrowString } from '../utils/timeUtils';

const KEYS = {
  TASKS: (date: string) => `tasks:${date}`,
  LOG: (date: string) => `log:${date}`,
  PROFILE: 'user_profile',
  STATS: 'user_stats',
  SCHEDULE: (date: string) => `schedule:${date}`,
  REWARDS: 'reward_events',
  GOALS: 'goals',
};

export const TaskStorage = {
  // Tasks
  async saveTasks(date: string, tasks: Task[]): Promise<void> {
    await AsyncStorage.setItem(KEYS.TASKS(date), JSON.stringify(tasks));
  },
  async loadTasks(date: string): Promise<Task[]> {
    const raw = await AsyncStorage.getItem(KEYS.TASKS(date));
    return raw ? JSON.parse(raw) : [];
  },
  async loadAllPendingTasks(): Promise<Task[]> {
    const keys = await AsyncStorage.getAllKeys();
    const taskKeys = keys.filter(k => k.startsWith('tasks:'));
    const all: Task[] = [];
    for (const key of taskKeys) {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const tasks: Task[] = JSON.parse(raw);
        all.push(...tasks.filter(t => t.status === 'pending' || t.status === 'partial'));
      }
    }
    return all;
  },
  async loadTaskById(taskId: string): Promise<Task | null> {
    const keys = await AsyncStorage.getAllKeys();
    const taskKeys = keys.filter(k => k.startsWith('tasks:'));
    for (const key of taskKeys) {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const tasks: Task[] = JSON.parse(raw);
        const found = tasks.find(t => t.id === taskId);
        if (found) return found;
      }
    }
    return null;
  },
  async updateTask(task: Task): Promise<void> {
    const tasks = await this.loadTasks(task.date);
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) tasks[idx] = task;
    else tasks.push(task);
    await this.saveTasks(task.date, tasks);
  },
  async deleteTask(taskId: string, date: string): Promise<void> {
    const tasks = await this.loadTasks(date);
    await this.saveTasks(date, tasks.filter(t => t.id !== taskId));
  },
  async moveUnfinishedToTomorrow(date: string): Promise<void> {
    const tasks = await this.loadTasks(date);
    const tomorrow = getTomorrowString();
    const tomorrowTasks = await this.loadTasks(tomorrow);
    const toMove = tasks.filter(t => t.status === 'pending' || t.status === 'partial');
    const updated = toMove.map(t => ({ ...t, status: 'moved' as const, date: tomorrow, movedFromDate: date }));
    await this.saveTasks(date, tasks.map(t => toMove.includes(t) ? { ...t, status: 'moved' as const } : t));
    await this.saveTasks(tomorrow, [...tomorrowTasks, ...updated]);
  },

  // Log
  async saveLog(log: DailyLog): Promise<void> {
    await AsyncStorage.setItem(KEYS.LOG(log.date), JSON.stringify(log));
  },
  async loadLog(date: string): Promise<DailyLog> {
    const raw = await AsyncStorage.getItem(KEYS.LOG(date));
    return raw ? JSON.parse(raw) : { date, morningDone: false, afternoonDone: false, eveningDone: false };
  },

  // Profile
  async saveProfile(profile: UserProfile): Promise<void> {
    await AsyncStorage.setItem(KEYS.PROFILE, JSON.stringify(profile));
  },
  async loadProfile(): Promise<UserProfile | null> {
    const raw = await AsyncStorage.getItem(KEYS.PROFILE);
    return raw ? JSON.parse(raw) : null;
  },

  // Stats
  async saveStats(stats: UserStats): Promise<void> {
    await AsyncStorage.setItem(KEYS.STATS, JSON.stringify(stats));
  },
  async loadStats(): Promise<UserStats> {
    const raw = await AsyncStorage.getItem(KEYS.STATS);
    return raw ? JSON.parse(raw) : {
      totalPoints: 0, level: 1, currentStreak: 0, longestStreak: 0,
      totalTasksCompleted: 0, totalTasksOnTime: 0, totalTasksMissed: 0,
      categoryDurationAverages: {}, lastUpdated: Date.now(),
    };
  },

  // Schedule
  async saveSchedule(schedule: DailySchedule): Promise<void> {
    await AsyncStorage.setItem(KEYS.SCHEDULE(schedule.date), JSON.stringify(schedule));
  },
  async loadSchedule(date: string): Promise<DailySchedule | null> {
    const raw = await AsyncStorage.getItem(KEYS.SCHEDULE(date));
    return raw ? JSON.parse(raw) : null;
  },

  // Rewards
  async saveRewardEvent(event: RewardEvent): Promise<void> {
    const existing = await this.loadRewardEvents();
    existing.unshift(event);
    await AsyncStorage.setItem(KEYS.REWARDS, JSON.stringify(existing.slice(0, 50)));
  },
  async loadRewardEvents(): Promise<RewardEvent[]> {
    const raw = await AsyncStorage.getItem(KEYS.REWARDS);
    return raw ? JSON.parse(raw) : [];
  },

  // Goals
  async saveGoals(goals: Goal[]): Promise<void> {
    await AsyncStorage.setItem(KEYS.GOALS, JSON.stringify(goals));
  },
  async loadGoals(): Promise<Goal[]> {
    const raw = await AsyncStorage.getItem(KEYS.GOALS);
    return raw ? JSON.parse(raw) : [];
  },
};
```

---

## SECTION 5 — LLM SERVICE (src/services/LLMService.ts)

CREATE or OVERWRITE:

```typescript
import OpenAI from 'openai';
import { Task, UserProfile, DailySchedule, CalendarEvent, TaskCategory } from '../types';
import { getTodayString, sortTasksByPriorityAndTime, calculateWakeTime } from '../utils/timeUtils';
import { preprocessTranscript } from './SpeechService';
import { CATEGORY_META } from '../constants/theme';

// Nebius AI — OpenAI-compatible endpoint
const getClient = () => new OpenAI({
  apiKey: process.env.EXPO_PUBLIC_NEBIUS_API_KEY || '',
  baseURL: 'https://api.studio.nebius.ai/v1/',
  dangerouslyAllowBrowser: true,
});

const MODEL = 'Qwen/Qwen3-235B-A22B'; // or 'meta-llama/Meta-Llama-3.1-70B-Instruct'

// ─── TOOL DEFINITIONS ───
const LUMI_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'categorize_task',
      description: 'Analyze a task — determine category, priority, estimated duration, whether it is fixed with others',
      parameters: {
        type: 'object',
        properties: {
          task_text: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['task_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'split_into_subtasks',
      description: 'Split a complex task into ordered subtasks with time estimates',
      parameters: {
        type: 'object',
        properties: {
          task_text: { type: 'string' },
          already_done: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['task_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transit_plan',
      description: 'Calculate transit route from home to destination including walking to bus stop',
      parameters: {
        type: 'object',
        properties: {
          destination_address: { type: 'string' },
          arrival_deadline: { type: 'string', description: 'HH:MM' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['destination_address', 'arrival_deadline'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_wake_time',
      description: 'Calculate when user must wake up and leave home to arrive on time',
      parameters: {
        type: 'object',
        properties: {
          fixed_time: { type: 'string' },
          travel_minutes: { type: 'number' },
          routine_minutes: { type: 'number' },
          buffer_minutes: { type: 'number' },
        },
        required: ['fixed_time', 'travel_minutes', 'routine_minutes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_contacts',
      description: 'Search device contacts by name including Hebrew/English variants',
      parameters: {
        type: 'object',
        properties: { name_query: { type: 'string' } },
        required: ['name_query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_gap_filler',
      description: 'Suggest a task to fill a free time slot based on user goals and aspirations',
      parameters: {
        type: 'object',
        properties: {
          gap_start: { type: 'string', description: 'HH:MM' },
          gap_end: { type: 'string', description: 'HH:MM' },
          user_goals_summary: { type: 'string' },
        },
        required: ['gap_start', 'gap_end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_schedule',
      description: 'Build optimized daily schedule — fixed tasks first, then flexible by priority and time',
      parameters: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'object' } },
          wake_constraint: { type: 'string' },
          sleep_time: { type: 'string' },
          language: { type: 'string', enum: ['en', 'he'] },
        },
        required: ['tasks'],
      },
    },
  },
];

// ─── SYSTEM PROMPT ───
const getSystemPrompt = (profile: UserProfile, date: string, language: 'en' | 'he'): string => `
You are Lumi, a warm and smart daily scheduler assistant.
You speak ${language === 'he' ? 'Hebrew' : 'English'} and understand both Hebrew and English mixed input.

Your job: analyze the user's spoken tasks and build an optimized daily schedule.

For EACH task mentioned:
1. Call categorize_task → get category, priority, duration, isFixed
2. If task mentions a location → call get_transit_plan, then calculate_wake_time
3. If task mentions a person's name → call search_contacts
4. If task is complex/assignment → call split_into_subtasks
5. After ALL tasks analyzed → call build_schedule

User profile:
- Name: ${profile.name}
- Transport: ${profile.transportType}
- Morning routine: ${profile.morningRoutineMinutes} minutes
- Wake buffer: ${profile.wakeBufferMinutes} minutes
- Home: ${profile.homeAddress}
- Language: ${language}

Today: ${date}
Current time: ${new Date().toTimeString().slice(0, 5)}

Be warm, encouraging, and efficient. Respond in ${language === 'he' ? 'Hebrew' : 'English'}.
Return schedule summary in BOTH English and Hebrew.
`;

// ─── TOOL EXECUTOR ───
export interface AgentContext {
  userProfile: UserProfile;
  googleTokens?: any;
  date: string;
  language: 'en' | 'he';
}

async function executeToolCall(
  toolName: string,
  toolInput: any,
  context: AgentContext
): Promise<any> {
  const { userProfile, language } = context;

  switch (toolName) {
    case 'categorize_task': {
      // Keyword-based categorization using CATEGORY_META
      const text = toolInput.task_text.toLowerCase();
      let detectedCategory: TaskCategory = 'general';
      let isFixed = false;
      let priority: string = 'need_to';
      let durationMinutes = 30;

      const keywords: Record<TaskCategory, string[]> = {
        interview: ['interview', 'ראיון', 'job'],
        course: ['course', 'קורס', 'learn', 'ללמוד', 'study'],
        conference: ['conference', 'כנס', 'summit'],
        class: ['class', 'שיעור', 'lesson'],
        work: ['work', 'עבודה', 'office', 'משרד'],
        meeting: ['meeting', 'פגישה', 'appointment'],
        call: ['call', 'שיחה', 'phone', 'להתקשר', 'טלפון'],
        doctor: ['doctor', 'רופא', 'medical', 'תור', 'clinic'],
        gym: ['gym', 'workout', 'אימון', 'קיקבוקס', 'kickbox', 'fitness', 'run', 'ריצה'],
        aspiration: ['aspiration', 'שאיפה', 'dream', 'goal', 'יעד'],
        leisure: ['leisure', 'פנאי', 'relax', 'movie', 'סרט'],
        general: ['general', 'כללי'],
        zoom: ['zoom', 'זום', 'video call', 'teams', 'meet'],
        hobby_class: ['חוג', 'hobby', 'class', 'workshop', 'סדנא'],
      };

      for (const [cat, kws] of Object.entries(keywords)) {
        if (kws.some(kw => text.includes(kw))) {
          detectedCategory = cat as TaskCategory;
          break;
        }
      }

      // Duration estimates by category
      const durations: Partial<Record<TaskCategory, number>> = {
        gym: 60, meeting: 45, interview: 90, doctor: 60,
        call: 15, zoom: 45, class: 90, course: 60,
      };
      durationMinutes = durations[detectedCategory] || 30;

      // Fixed if involves another person or specific time
      isFixed = ['interview', 'meeting', 'doctor', 'zoom', 'class', 'conference'].includes(detectedCategory);
      priority = ['interview', 'doctor'].includes(detectedCategory) ? 'must' :
                 ['meeting', 'work', 'zoom'].includes(detectedCategory) ? 'have_to' : 'need_to';

      return { category: detectedCategory, priority, durationMinutes, isFixed, confidence: 0.8 };
    }

    case 'calculate_wake_time': {
      const result = calculateWakeTime(
        toolInput.fixed_time,
        toolInput.travel_minutes,
        toolInput.routine_minutes,
        toolInput.buffer_minutes || userProfile.wakeBufferMinutes
      );
      return result;
    }

    case 'split_into_subtasks': {
      // Simple split for now — LLM will handle complex cases
      return {
        subtasks: [
          { text: `Start: ${toolInput.task_text}`, durationMinutes: 30, order: 1 },
          { text: `Complete: ${toolInput.task_text}`, durationMinutes: 30, order: 2 },
        ],
      };
    }

    case 'get_transit_plan': {
      // Import and call GoogleService
      try {
        const { GoogleService } = await import('./GoogleService');
        return await GoogleService.getTransitPlan(
          toolInput.destination_address,
          toolInput.arrival_deadline,
          userProfile,
          toolInput.date || context.date
        );
      } catch {
        return { minutes: 30, summary: 'Unable to fetch transit — using estimate', source: 'manual' };
      }
    }

    case 'search_contacts': {
      try {
        const { ContactService } = await import('./ContactService');
        return await ContactService.getBestContactMatch(toolInput.name_query);
      } catch {
        return null;
      }
    }

    case 'suggest_gap_filler': {
      const suggestions = language === 'he'
        ? ['קרא פרק בספר 📚', 'התקשר למשפחה 📞', 'צא להליכה קצרה 🚶', 'מדיטציה קצרה 🧘']
        : ['Read a chapter 📚', 'Call family 📞', 'Short walk 🚶', 'Quick meditation 🧘'];
      const picked = suggestions[Math.floor(Math.random() * suggestions.length)];
      return {
        suggestion: picked,
        reason: language === 'he' ? 'טוב לך לנוח ולהטעין אנרגיה' : 'Good time to recharge',
      };
    }

    case 'build_schedule': {
      const sorted = sortTasksByPriorityAndTime(toolInput.tasks || []);
      const firstFixed = sorted.find((t: any) => t.location?.wakeUpBy);
      return {
        tasks: sorted,
        wakeUpTime: firstFixed?.location?.wakeUpBy || userProfile.defaultWakeTime,
        lumiSummary: `You have ${sorted.length} tasks today. Let's make it great!`,
        lumiSummaryHe: `יש לך ${sorted.length} משימות היום. בואו נעשה יום מעולה!`,
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── MAIN REACT AGENT LOOP ───
export async function runLumiAgent(
  transcript: string,
  context: AgentContext
): Promise<DailySchedule> {
  const client = getClient();
  const cleaned = preprocessTranscript(transcript, context.language);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: getSystemPrompt(context.userProfile, context.date, context.language),
    },
    { role: 'user', content: cleaned },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: LUMI_TOOLS,
      tool_choice: 'auto',
      max_tokens: 2000,
    });

    const choice = response.choices[0];
    messages.push({ role: 'assistant', content: choice.message.content, tool_calls: choice.message.tool_calls });

    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      // Final answer — try to extract DailySchedule
      break;
    }

    // Execute all tool calls
    for (const toolCall of choice.message.tool_calls) {
      const input = JSON.parse(toolCall.function.arguments);
      const result = await executeToolCall(toolCall.function.name, input, context);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Build final schedule from last build_schedule result
  // Fall back to basic parsing if needed
  return {
    date: context.date,
    tasks: [],
    wakeUpTime: context.userProfile.defaultWakeTime,
    generatedAt: Date.now(),
    lumiSummary: "Here's your day!",
    lumiSummaryHe: "הנה היום שלך!",
  };
}

// ─── BASIC FALLBACK PARSER (offline, no LLM) ───
export function parseTasksBasic(transcript: string, date: string, language: 'en' | 'he'): Task[] {
  const triggers = [
    "i need to", "i want to", "i must", "i have to", "also", "and then", "and also",
    "אני צריך ל", "אני צריכה ל", "אני רוצה ל", "גם", "ואז",
  ];

  let text = transcript;
  triggers.forEach(t => { text = text.replace(new RegExp(t, 'gi'), '|||'); });
  text = text.replace(/[,\.]/g, '|||');

  return text
    .split('|||')
    .map(s => s.trim())
    .filter(s => s.length > 3)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .map(s => ({
      id: Math.random().toString(36).substr(2, 9),
      text: s,
      category: 'general' as TaskCategory,
      priority: 'need_to' as const,
      isFixed: false,
      durationMinutes: 30,
      date,
      status: 'pending' as const,
      createdAt: Date.now(),
      historicalDurations: [],
    }));
}
```

---

## SECTION 6 — SPEECH SERVICE (src/services/SpeechService.ts)

CREATE or OVERWRITE:

```typescript
import * as Speech from 'expo-speech';
import { isExpoGo } from '../utils/timeUtils';
import { correctPlaceName } from '../utils/fuzzyMatch';
import { AppLanguage } from '../types';

const FILLER_WORDS = ['um', 'uh', 'like', 'you know', 'so', 'כאילו', 'אממ', 'אה', 'אממ'];

export const preprocessTranscript = (text: string, language: AppLanguage): string => {
  let result = text;
  // Remove fillers
  FILLER_WORDS.forEach(fw => {
    result = result.replace(new RegExp(`\\b${fw}\\b`, 'gi'), '');
  });
  // Correct place names
  result = correctPlaceName(result);
  // Normalize numbers
  result = result
    .replace(/\bעשר\b/g, '10').replace(/\bאחת עשרה\b/g, '11')
    .replace(/\bשתיים עשרה\b/g, '12').replace(/\bשמונה\b/g, '8')
    .replace(/\bתשע\b/g, '9').replace(/\bשבע\b/g, '7')
    .replace(/\bשש\b/g, '6').replace(/\bחמש\b/g, '5');
  return result.trim();
};

export const SpeechService = {
  async speak(text: string, language: AppLanguage = 'en'): Promise<void> {
    try {
      return new Promise(resolve => {
        Speech.speak(text, {
          language: language === 'he' ? 'he-IL' : 'en-US',
          rate: 0.9,
          onDone: resolve,
          onError: () => resolve(),
        });
      });
    } catch (e) {
      console.log('[Speech] TTS error:', e);
    }
  },

  stop(): void {
    try { Speech.stop(); } catch {}
  },

  // STT — real in EAS build, text input fallback in Expo Go
  startListening(
    callbacks: {
      onPartialResult: (text: string) => void;
      onFinalResult: (text: string) => void;
      onSilence: () => void;
      onError: () => void;
    },
    language: AppLanguage = 'en'
  ): void {
    if (isExpoGo()) {
      // Expo Go: trigger text input fallback via onError
      callbacks.onError();
      return;
    }
    try {
      // EAS build: use expo-speech-recognition
      const ExpoSpeech = require('expo-speech-recognition');
      ExpoSpeech.ExpoSpeechRecognitionModule.requestPermissionsAsync().then(() => {
        ExpoSpeech.ExpoSpeechRecognitionModule.start({
          lang: language === 'he' ? 'he-IL' : 'en-US',
          interimResults: true,
          continuous: false,
        });
      });
      // Event handlers
      ExpoSpeech.ExpoSpeechRecognitionModule.addListener('result', (e: any) => {
        const text = e.results?.[0]?.transcript || '';
        if (e.isFinal) callbacks.onFinalResult(text);
        else callbacks.onPartialResult(text);
      });
      ExpoSpeech.ExpoSpeechRecognitionModule.addListener('end', callbacks.onSilence);
      ExpoSpeech.ExpoSpeechRecognitionModule.addListener('error', callbacks.onError);
    } catch {
      callbacks.onError();
    }
  },

  stopListening(): void {
    try {
      const ExpoSpeech = require('expo-speech-recognition');
      ExpoSpeech.ExpoSpeechRecognitionModule.stop();
    } catch {}
  },
};
```

---

## SECTION 7 — GOOGLE SERVICE (src/services/GoogleService.ts)

CREATE or OVERWRITE:

```typescript
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { UserProfile, CalendarEvent, TransitPlan } from '../types';
import { calculateWakeTime } from '../utils/timeUtils';
import { correctPlaceName } from '../utils/fuzzyMatch';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const MAPS_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '';

export const GoogleService = {
  async signInWithGoogle(): Promise<boolean> {
    try {
      const clientId = process.env.EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || '';
      const redirectUri = AuthSession.makeRedirectUri({ scheme: 'lumi' });
      const discovery = await AuthSession.fetchDiscoveryAsync('https://accounts.google.com');
      const request = new AuthSession.AuthRequest({
        clientId,
        scopes: GOOGLE_SCOPES,
        redirectUri,
      });
      const result = await request.promptAsync(discovery);
      if (result.type === 'success') {
        await SecureStore.setItemAsync('google_access_token', result.authentication?.accessToken || '');
        return true;
      }
      return false;
    } catch (e) {
      console.log('[Google] Auth error:', e);
      return false;
    }
  },

  async getToken(): Promise<string | null> {
    return SecureStore.getItemAsync('google_access_token');
  },

  async getCalendarEventsToday(date: string): Promise<CalendarEvent[]> {
    const token = await this.getToken();
    if (!token) return [];
    try {
      const start = `${date}T00:00:00Z`;
      const end = `${date}T23:59:59Z`;
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start}&timeMax=${end}&singleEvents=true`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      return (data.items || []).map((item: any) => ({
        id: item.id,
        title: item.summary,
        startTime: item.start?.dateTime?.slice(11, 16) || '00:00',
        endTime: item.end?.dateTime?.slice(11, 16) || '00:00',
        location: item.location,
        description: item.description,
      }));
    } catch { return []; }
  },

  async searchGmailForTask(keywords: string): Promise<{ threadId: string; subject: string; sender: string; snippet: string } | null> {
    const token = await this.getToken();
    if (!token) return null;
    try {
      const q = encodeURIComponent(keywords);
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=3`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      if (!data.messages?.[0]) return null;
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${data.messages[0].id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const msg = await msgRes.json();
      const headers = msg.payload?.headers || [];
      return {
        threadId: msg.threadId,
        subject: headers.find((h: any) => h.name === 'Subject')?.value || '',
        sender: headers.find((h: any) => h.name === 'From')?.value || '',
        snippet: msg.snippet || '',
      };
    } catch { return null; }
  },

  async getTransitPlan(
    destinationAddress: string,
    arrivalDeadline: string,
    userProfile: UserProfile,
    date: string
  ): Promise<TransitPlan | null> {
    if (!MAPS_KEY) return null;
    try {
      const corrected = correctPlaceName(destinationAddress);
      const [hour, min] = arrivalDeadline.split(':').map(Number);
      const arrivalTimestamp = Math.floor(new Date(`${date}T${arrivalDeadline}:00`).getTime() / 1000);
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(userProfile.homeAddress)}&destination=${encodeURIComponent(corrected)}&mode=transit&arrival_time=${arrivalTimestamp}&region=il&language=he&key=${MAPS_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.routes?.[0]) return null;

      const route = data.routes[0].legs[0];
      const steps = route.steps || [];

      // Extract walk leg + transit leg
      const walkStep = steps.find((s: any) => s.travel_mode === 'WALKING');
      const transitStep = steps.find((s: any) => s.travel_mode === 'TRANSIT');

      const walkMinutes = walkStep ? Math.ceil(walkStep.duration.value / 60) : 10;
      const transitMinutes = transitStep ? Math.ceil(transitStep.duration.value / 60) : 30;
      const lineNumber = transitStep?.transit_details?.line?.short_name || '';
      const stopName = transitStep?.transit_details?.departure_stop?.name || '';
      const busDeparture = transitStep?.transit_details?.departure_time?.text || arrivalDeadline;

      const leaveHomeAt = (() => {
        const [bh, bm] = busDeparture.split(':').map(Number);
        const leaveMin = bh * 60 + bm - walkMinutes - 5;
        const lh = Math.floor(leaveMin / 60);
        const lm = leaveMin % 60;
        return `${String(lh).padStart(2, '0')}:${String(lm).padStart(2, '0')}`;
      })();

      const wakeResult = calculateWakeTime(
        leaveHomeAt,
        0,
        userProfile.morningRoutineMinutes,
        userProfile.wakeBufferMinutes
      );

      return {
        totalDurationMinutes: Math.ceil(route.duration.value / 60),
        leaveHomeAt,
        arriveAt: arrivalDeadline,
        firstBusDeparture: busDeparture,
        firstBusStop: stopName,
        walkToStopMinutes: walkMinutes,
        legs: [
          { type: 'walk', from: 'Home', to: stopName, durationMinutes: walkMinutes, departureTime: leaveHomeAt, arrivalTime: busDeparture },
          { type: 'bus', from: stopName, to: corrected, durationMinutes: transitMinutes, departureTime: busDeparture, arrivalTime: arrivalDeadline, lineNumber, stopName },
        ],
        source: 'google',
        fetchedAt: Date.now(),
      };
    } catch (e) {
      console.log('[Google] Transit error:', e);
      return null;
    }
  },

  async searchPlaces(query: string): Promise<{ name: string; address: string; lat: number; lng: number; confidence: number }[]> {
    if (!MAPS_KEY) return [];
    try {
      const corrected = correctPlaceName(query);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(corrected)}&region=il&key=${MAPS_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      return (data.results || []).slice(0, 3).map((r: any, i: number) => ({
        name: r.name,
        address: r.formatted_address,
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        confidence: i === 0 ? 0.9 : i === 1 ? 0.7 : 0.5,
      }));
    } catch { return []; }
  },
};
```

---

## SECTION 8 — CONTACT SERVICE (src/services/ContactService.ts)

CREATE or OVERWRITE (short version):

```typescript
import * as Contacts from 'expo-contacts';
import { TaskContact } from '../types';
import { fuzzyScore, getNameVariants } from '../utils/fuzzyMatch';

let cachedContacts: Contacts.Contact[] = [];

export const ContactService = {
  async requestPermission(): Promise<boolean> {
    const { status } = await Contacts.requestPermissionsAsync();
    return status === 'granted';
  },

  async loadContacts(): Promise<void> {
    if (cachedContacts.length > 0) return;
    const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails] });
    cachedContacts = data;
  },

  async getBestContactMatch(nameQuery: string): Promise<TaskContact | null> {
    await this.loadContacts();
    const variants = getNameVariants(nameQuery);
    let bestScore = 0;
    let bestContact: Contacts.Contact | null = null;

    for (const contact of cachedContacts) {
      const fullName = contact.name || '';
      for (const variant of variants) {
        const score = fuzzyScore(fullName, variant);
        if (score > bestScore) { bestScore = score; bestContact = contact; }
      }
    }

    if (!bestContact || bestScore < 0.5) return null;
    return {
      name: bestContact.name || '',
      phone: bestContact.phoneNumbers?.[0]?.number,
      email: bestContact.emails?.[0]?.email,
      contactId: bestContact.id,
    };
  },
};
```

---

## SECTION 9 — NOTIFICATION SERVICE (src/services/NotificationService.ts)

CREATE or OVERWRITE with full transit + deadline notifications:

```typescript
import * as Notifications from 'expo-notifications';
import { Task, TransitPlan, AppLanguage, UserProfile } from '../types';
import { isExpoGo, getDaysUntilDeadline, calculateLatestStartTime } from '../utils/timeUtils';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export const NotificationService = {
  async requestPermission(): Promise<boolean> {
    if (isExpoGo()) return false;
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  },

  // Schedule all 3 check-in notifications
  async scheduleCheckIns(morningTime: string, afternoonTime: string, eveningTime: string, lang: AppLanguage): Promise<void> {
    if (isExpoGo()) return;
    await Notifications.cancelAllScheduledNotificationsAsync();
    const schedule = async (hhmm: string, title: string, body: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      await Notifications.scheduleNotificationAsync({
        content: { title, body, data: { type: 'checkin' } },
        trigger: { hour: h, minute: m, repeats: true } as any,
      });
    };
    await schedule(morningTime, '☀️ Lumi', lang === 'he' ? 'בוקר טוב! הגיע הזמן לתכנן את היום' : 'Good morning! Time to plan your day');
    await schedule(afternoonTime, '🌤 Lumi', lang === 'he' ? 'מה הספקת?' : 'What did you accomplish?');
    await schedule(eveningTime, '🌙 Lumi', lang === 'he' ? 'זמן לסכם את היום' : 'Time to wrap up your day');
  },

  // Transit task: 3 notifications
  async scheduleTransitNotifications(task: Task, lang: AppLanguage): Promise<void> {
    if (isExpoGo() || !task.location?.transitPlan) return;
    const tp = task.location.transitPlan;
    const ids: string[] = [];

    // 1. Wake-up
    if (task.location.wakeUpBy) {
      const [h, m] = task.location.wakeUpBy.split(':').map(Number);
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: `⏰ ${lang === 'he' ? 'קום!' : 'Wake up!'} — ${task.text}`,
          body: lang === 'he'
            ? `האוטובוס ${tp.firstBusDeparture} מ${tp.firstBusStop}. צריך לצאת ב-${tp.leaveHomeAt}`
            : `Bus at ${tp.firstBusDeparture} from ${tp.firstBusStop}. Leave home by ${tp.leaveHomeAt}`,
          data: { taskId: task.id, notificationType: 'wake_up', language: lang },
          priority: 'max',
        },
        trigger: { hour: h, minute: m, repeats: false } as any,
      });
      ids.push(id);
    }

    // 2. Leave home
    const [lh, lm] = tp.leaveHomeAt.split(':').map(Number);
    const leaveId = await Notifications.scheduleNotificationAsync({
      content: {
        title: lang === 'he' ? `🚪 הגיע הזמן לצאת!` : `🚪 Time to leave!`,
        body: lang === 'he'
          ? `אוטובוס ${tp.legs[1]?.lineNumber || ''} יוצא מ${tp.firstBusStop} ב-${tp.firstBusDeparture} (הליכה ${tp.walkToStopMinutes} דק')`
          : `Bus ${tp.legs[1]?.lineNumber || ''} departs ${tp.firstBusStop} at ${tp.firstBusDeparture} (${tp.walkToStopMinutes} min walk)`,
        data: { taskId: task.id, notificationType: 'leave_home', language: lang },
        priority: 'max',
      },
      trigger: { hour: lh, minute: lm, repeats: false } as any,
    });
    ids.push(leaveId);

    // 3. Re-check 30 min before leave
    const reCheckMin = lh * 60 + lm - 30;
    if (reCheckMin > 0) {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Lumi',
          body: lang === 'he' ? 'בדיקת זמן נסיעה...' : 'Checking transit times...',
          data: { taskId: task.id, notificationType: 're_check', language: lang },
        },
        trigger: { hour: Math.floor(reCheckMin / 60), minute: reCheckMin % 60, repeats: false } as any,
      });
      ids.push(id);
    }

    // Save IDs to task
    task.notificationIds = ids;
  },

  // Deadline notifications
  async scheduleDeadlineNotifications(task: Task, lang: AppLanguage): Promise<void> {
    if (isExpoGo() || !task.deadline) return;
    const ids: string[] = [];
    const deadlineTime = task.deadlineTime || '23:59';
    const daysLeft = getDaysUntilDeadline(task.deadline);
    const latestStart = task.estimatedWorkMinutes
      ? calculateLatestStartTime(task.deadline, deadlineTime, task.estimatedWorkMinutes)
      : null;

    // Day before at 18:00
    if (daysLeft >= 1) {
      const dayBefore = new Date(task.deadline);
      dayBefore.setDate(dayBefore.getDate() - 1);
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: `📚 ${lang === 'he' ? 'מחר הדדליין' : 'Deadline tomorrow'}: ${task.text}`,
          body: lang === 'he'
            ? `הגשה מחר ב-${deadlineTime}. צריך ~${task.estimatedWorkMinutes || 60} דקות.`
            : `Due tomorrow at ${deadlineTime}. Need ~${task.estimatedWorkMinutes || 60} min.`,
          data: { taskId: task.id, notificationType: 'deadline_reminder' },
        },
        trigger: { date: new Date(`${dayBefore.toISOString().split('T')[0]}T18:00:00`) } as any,
      });
      ids.push(id);
    }

    // Day of at 09:00
    if (daysLeft <= 1) {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: `🔴 ${lang === 'he' ? 'היום הדדליין' : 'Deadline today'}: ${task.text}`,
          body: lang === 'he'
            ? `חייב להגיש עד ${deadlineTime}!${latestStart ? ` התחל לכל המאוחר ב-${latestStart.time}` : ''}`
            : `Must submit by ${deadlineTime}!${latestStart ? ` Start by ${latestStart.time} at latest` : ''}`,
          priority: 'max',
          data: { taskId: task.id, notificationType: 'deadline_today' },
        },
        trigger: { date: new Date(`${task.deadline}T09:00:00`) } as any,
      });
      ids.push(id);
    }

    // Latest start alert
    if (latestStart) {
      const [lh, lm] = latestStart.time.split(':').map(Number);
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: `🔴 ${lang === 'he' ? 'התחל עכשיו' : 'Start NOW'}: ${task.text}`,
          body: lang === 'he'
            ? `אם לא תתחיל עכשיו לא תספיק! דדליין ב-${deadlineTime}`
            : `If you don't start now you won't finish! Deadline at ${deadlineTime}`,
          priority: 'max',
          data: { taskId: task.id, notificationType: 'latest_start' },
        },
        trigger: { date: new Date(`${latestStart.date}T${latestStart.time}:00`) } as any,
      });
      ids.push(id);
    }

    task.notificationIds = [...(task.notificationIds || []), ...ids];
  },

  async cancelTaskNotifications(task: Task): Promise<void> {
    if (!task.notificationIds) return;
    for (const id of task.notificationIds) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
    }
  },

  async sendImmediate(title: string, body: string, data?: any): Promise<void> {
    if (isExpoGo()) { console.log(`[NOTIF] ${title}: ${body}`); return; }
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data },
      trigger: null,
    });
  },
};
```

---

## SECTION 10 — REWARD & LEARNING SERVICES

### src/services/RewardService.ts — CREATE:
```typescript
import { UserStats, RewardEvent, AppLanguage } from '../types';
import { TaskStorage } from './TaskStorage';
import { POINTS, LEVELS } from '../constants/theme';

export const RewardService = {
  getLevelForPoints(points: number): number {
    return [...LEVELS].reverse().find(l => points >= l.minPoints)?.level || 1;
  },

  async awardPoints(
    type: RewardEvent['type'],
    stats: UserStats,
    language: AppLanguage,
    context?: string
  ): Promise<{ stats: UserStats; leveledUp: boolean; newLevel?: number }> {
    const pointsMap: Record<string, number> = {
      task_complete: POINTS.task_complete,
      on_time: POINTS.on_time,
      arrival: POINTS.verified_arrival,
      streak: POINTS.streak_bonus * Math.min(stats.currentStreak, 5),
      level_up: 0,
      perfect_day: POINTS.perfect_day,
    };
    const earned = pointsMap[type] || 0;
    const oldLevel = stats.level;
    const newStats: UserStats = {
      ...stats,
      totalPoints: stats.totalPoints + earned,
      totalTasksCompleted: type === 'task_complete' ? stats.totalTasksCompleted + 1 : stats.totalTasksCompleted,
      totalTasksOnTime: type === 'on_time' ? stats.totalTasksOnTime + 1 : stats.totalTasksOnTime,
      level: this.getLevelForPoints(stats.totalPoints + earned),
      lastUpdated: Date.now(),
    };
    const leveledUp = newStats.level > oldLevel;
    const messages: Record<string, { en: string; he: string }> = {
      task_complete: { en: `Task done! +${earned} pts`, he: `משימה הושלמה! +${earned} נק'` },
      on_time: { en: `On time! +${earned} pts 🎯`, he: `בזמן! +${earned} נק' 🎯` },
      arrival: { en: `Arrived! +${earned} pts 📍`, he: `הגעת! +${earned} נק' 📍` },
      perfect_day: { en: `Perfect day! +${earned} pts 👑`, he: `יום מושלם! +${earned} נק' 👑` },
      streak: { en: `Streak bonus! +${earned} pts 🔥`, he: `בונוס streak! +${earned} נק' 🔥` },
    };
    const msg = messages[type] || { en: `+${earned} pts`, he: `+${earned} נק'` };
    await TaskStorage.saveRewardEvent({
      id: Math.random().toString(36).substr(2),
      type,
      points: earned,
      message: msg.en,
      messageHe: msg.he,
      timestamp: Date.now(),
    });
    await TaskStorage.saveStats(newStats);
    return { stats: newStats, leveledUp, newLevel: leveledUp ? newStats.level : undefined };
  },
};
```

### src/services/LearningService.ts — CREATE:
```typescript
import { Task, TaskCategory } from '../types';
import { TaskStorage } from './TaskStorage';

const DEFAULT_DURATIONS: Record<TaskCategory, number> = {
  interview: 90, course: 60, conference: 120, class: 90,
  work: 60, meeting: 45, call: 15, doctor: 60,
  gym: 60, aspiration: 30, leisure: 60, general: 30,
  zoom: 45, hobby_class: 90,
};

export const LearningService = {
  async recordTaskCompletion(task: Task, actualMinutes: number): Promise<void> {
    const stats = await TaskStorage.loadStats();
    const avgs = { ...stats.categoryDurationAverages };
    const existing = avgs[task.category] || DEFAULT_DURATIONS[task.category];
    // Rolling average weighted toward recent
    avgs[task.category] = Math.round(existing * 0.7 + actualMinutes * 0.3);
    await TaskStorage.saveStats({ ...stats, categoryDurationAverages: avgs });
  },

  async getLearnedDuration(category: TaskCategory): Promise<number> {
    const stats = await TaskStorage.loadStats();
    return stats.categoryDurationAverages[category] || DEFAULT_DURATIONS[category];
  },
};
```

---

## SECTION 11 — VERIFY & RUN

After all sections complete:

1. Run: `npx expo start --clear`
2. Confirm app launches without crashing
3. List every file created or modified
4. List any packages that need installing
5. List any TODO items remaining

If any section fails, fix it before moving to the next section.
Do NOT skip errors.

## SECTION 12 — EAS BUILD: DEBUG + RELEASE (Android only)

Create/update eas.json with 3 profiles:

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

Add to package.json scripts:
  "android:debug":   "eas build --platform android --profile development",
  "android:release": "eas build --platform android --profile preview",
  "android:store":   "eas build --platform android --profile production",
  "start:dev":       "npx expo start --dev-client --clear",
  "start:tunnel":    "npx expo start --dev-client --tunnel"