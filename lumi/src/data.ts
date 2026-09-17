// Mock data for Lumi. Everything the UI renders originates here. Swap this file
// (and the store actions) for a real backend later — the shapes are the contract.
import type {
  AISuggestion,
  Category,
  InboxItem,
  Task,
  UserProfile,
} from './types';

// "Today" is pinned so the seeded schedule always lines up with the demo.
export const TODAY = '2026-06-18'; // Thursday
export const TODAY_LABEL = 'Thursday, June 18';
// Simulated "now" so the dashboard's now-line sits in a nice spot for the demo.
export const NOW = '12:15';

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

export const CATEGORY_META: Record<
  Category,
  { label: string; color: string; soft: string }
> = {
  work: { label: 'Work', color: '#7C3AED', soft: 'rgba(124,58,237,0.16)' },
  meeting: { label: 'Meeting', color: '#06B6D4', soft: 'rgba(6,182,212,0.16)' },
  focus: { label: 'Focus', color: '#22C55E', soft: 'rgba(34,197,94,0.16)' },
  personal: { label: 'Personal', color: '#F59E0B', soft: 'rgba(245,158,11,0.16)' },
  health: { label: 'Health', color: '#EF4444', soft: 'rgba(239,68,68,0.16)' },
  learning: { label: 'Learning', color: '#8B5CF6', soft: 'rgba(139,92,246,0.16)' },
};

export const PRIORITY_META = {
  high: { label: 'High', color: '#EF4444' },
  medium: { label: 'Medium', color: '#F59E0B' },
  low: { label: 'Low', color: '#71717A' },
} as const;

export const seedProfile: UserProfile = {
  name: 'Koral',
  role: 'MLOps Student',
  workStart: '08:00',
  workEnd: '22:00',
  focusBlockMinutes: 50,
  ai: {
    autoSchedule: true,
    proactiveSuggestions: true,
    voice: false,
    summaries: true,
  },
};

export const seedTasks: Task[] = [
  {
    id: 't_email',
    title: 'Morning email triage',
    category: 'work',
    priority: 'low',
    status: 'done',
    bucket: 'today',
    column: 'done',
    start: '08:30',
    durationMinutes: 30,
    date: TODAY,
    tags: ['inbox'],
    notes: 'Clear overnight email, flag anything urgent.',
    subtasks: [],
    activity: [{ id: uid('a'), at: '08:58', text: 'Marked done', source: 'user' }],
    order: 0,
  },
  {
    id: 't_meeting',
    title: 'Meeting — Ramat Gan office',
    category: 'meeting',
    priority: 'medium',
    status: 'todo',
    bucket: 'today',
    column: 'today',
    start: '10:30',
    durationMinutes: 45,
    date: TODAY,
    location: 'Ramat Gan office',
    inPerson: true,
    tags: ['in-person'],
    notes: 'Sync on Q3 roadmap. Leave 20 min early for traffic.',
    subtasks: [],
    activity: [],
    order: 1,
  },
  {
    id: 't_zoom',
    title: 'Zoom call',
    category: 'meeting',
    priority: 'medium',
    status: 'todo',
    bucket: 'today',
    column: 'today',
    start: '11:30',
    durationMinutes: 45,
    date: TODAY,
    location: 'Zoom',
    inPerson: false,
    tags: ['remote'],
    notes: 'Vendor demo. Recording link in calendar invite.',
    subtasks: [],
    activity: [],
    order: 2,
  },
  {
    id: 't_hw2',
    title: 'Finish & submit HW2 — MLOps',
    category: 'learning',
    priority: 'high',
    status: 'todo',
    bucket: 'today',
    column: 'in_progress',
    start: '13:00',
    durationMinutes: 180,
    date: TODAY,
    due: 'Today 23:59',
    tags: ['deadline', 'mlops'],
    notes: 'Deep work block. Phone on silent. Submit on course portal.',
    subtasks: [
      { id: uid('s'), text: 'Re-run training pipeline', done: true },
      { id: uid('s'), text: 'Write up evaluation section', done: false },
      { id: uid('s'), text: 'Export model card', done: false },
      { id: uid('s'), text: 'Submit on portal', done: false },
    ],
    activity: [{ id: uid('a'), at: '13:05', text: 'Started focus block', source: 'user' }],
    order: 3,
  },
  {
    id: 't_workshop',
    title: 'Workshop',
    category: 'learning',
    priority: 'medium',
    status: 'todo',
    bucket: 'today',
    column: 'today',
    start: '20:00',
    durationMinutes: 90,
    date: TODAY,
    location: 'Online',
    inPerson: false,
    tags: ['evening'],
    notes: 'Guest speaker on model monitoring.',
    subtasks: [],
    activity: [],
    order: 4,
  },
  // This-week + later items so Tasks/Calendar feel alive
  {
    id: 't_groceries',
    title: 'Grocery run',
    category: 'personal',
    priority: 'low',
    status: 'todo',
    bucket: 'week',
    column: 'backlog',
    durationMinutes: 40,
    date: '2026-06-20',
    tags: ['errand'],
    notes: '',
    subtasks: [],
    activity: [],
    order: 5,
  },
  {
    id: 't_gym',
    title: 'Strength session',
    category: 'health',
    priority: 'medium',
    status: 'todo',
    bucket: 'week',
    column: 'backlog',
    start: '18:00',
    durationMinutes: 60,
    date: '2026-06-19',
    location: 'Space Gym',
    tags: ['gym'],
    notes: 'Leg day.',
    subtasks: [],
    activity: [],
    order: 6,
  },
  {
    id: 't_paper',
    title: 'Read VLM survey paper',
    category: 'learning',
    priority: 'low',
    status: 'todo',
    bucket: 'later',
    column: 'backlog',
    durationMinutes: 90,
    date: '2026-06-24',
    tags: ['reading'],
    notes: '',
    subtasks: [],
    activity: [],
    order: 7,
  },
  {
    id: 't_dentist',
    title: 'Book dentist appointment',
    category: 'health',
    priority: 'low',
    status: 'todo',
    bucket: 'later',
    column: 'backlog',
    durationMinutes: 15,
    date: '2026-06-25',
    tags: [],
    notes: '',
    subtasks: [],
    activity: [],
    order: 8,
  },
];

export const seedSuggestions: AISuggestion[] = [
  {
    id: uid('sug'),
    title: 'Protect a 90-min focus block before HW2',
    detail: 'You have a gap 16:15–17:45. Want me to hold it for deep work?',
    start: '16:15',
    durationMinutes: 90,
  },
  {
    id: uid('sug'),
    title: 'Leave 20 min early for Ramat Gan',
    detail: 'Traffic is heavier than usual — I can nudge your 10:30 reminder.',
  },
  {
    id: uid('sug'),
    title: 'Batch the two meetings',
    detail: 'Your 10:30 and 11:30 are back-to-back. Add a 15-min reset between them?',
  },
];

export const seedInbox: InboxItem[] = [
  {
    id: uid('in'),
    kind: 'insight',
    text: 'HW2 is due tonight — it’s your only high-priority item left.',
    at: '09:02',
    unread: true,
  },
  {
    id: uid('in'),
    kind: 'suggestion',
    text: 'I found a 90-min gap this afternoon. Reserve it for focus?',
    at: '09:02',
    unread: true,
  },
  {
    id: uid('in'),
    kind: 'reminder',
    text: 'Leave by 10:10 to reach Ramat Gan on time.',
    at: '09:40',
    unread: false,
  },
];

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The 7-day window the calendar renders (this week, Sun–Sat).
export const WEEK_DATES = [
  '2026-06-14',
  '2026-06-15',
  '2026-06-16',
  '2026-06-17',
  '2026-06-18',
  '2026-06-19',
  '2026-06-20',
];
