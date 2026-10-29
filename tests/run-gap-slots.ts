/**
 * run-gap-slots — free time on the timeline, and what Lumi offers to put in it.
 *
 * Two layers, both pure:
 *   utils/findGaps       — WHERE the day is actually free. The old private
 *                          finder in TodaySchedule saw only the space between
 *                          two consecutive tasks: nothing before the first,
 *                          nothing after the last, and an hour before a
 *                          meeting you must leave for in ten minutes counted
 *                          as a free hour.
 *   utils/routines       — her standing week: the Monday gym to offer, and
 *                          the 16:00 school run that means those hours were
 *                          never free. Both were collected at onboarding and
 *                          then read by exactly one regex looking for "gym".
 *   GapFillService.rank  — WHAT to do with it: the habit due today, near where
 *                          she is, prep for what's coming, finish what
 *                          slipped, rest after a heavy morning, home tasks at
 *                          home, wish list last — and nothing social in the
 *                          shadow of an obligation.
 *
 * GapFillService reaches storage at import time, so AsyncStorage and the
 * Supabase client are stubbed before it loads (same trick as run-concurrency).
 *
 * Run: npx tsx tests/run-gap-slots.ts
 */
const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) { store.set(k, v); },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
    return { __esModule: true, default: memoryAsyncStorage };
  }
  if (request === './supabaseClient' || request.endsWith('/supabaseClient')) {
    return { __esModule: true, isSupabaseConfigured: false, supabase: null };
  }
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return { __esModule: true, getUserId: async () => null, getSession: async () => null };
  }
  // UserProfileStorage pulls expo-secure-store and expo-location through
  // NearbyTaskReminderService; the ranking under test never reads a profile.
  if (request === './UserProfileStorage' || request.endsWith('/UserProfileStorage')) {
    return { __esModule: true, loadProfile: async () => null, saveProfile: async () => {} };
  }
  return origLoad.call(this, request, ...rest);
};

import assert from 'node:assert';
import { findDayGaps, fitsInDay } from '../src/utils/findGaps';
import {
  constrainGaps, habitsFromHistory, parseRoutineNotes, blockedForGap,
} from '../src/utils/routines';
import type { Task, Goal } from '../src/types/index';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rankGapIdeas } = require('../src/services/GapFillService');

const DATE = '2026-08-31';

const task = (over: Partial<Task>): Task => ({
  id: Math.random().toString(36).slice(2),
  text: 'task',
  category: 'general',
  priority: 'need_to',
  isFixed: false,
  durationMinutes: 60,
  date: DATE,
  status: 'pending',
  createdAt: 0,
  historicalDurations: [],
  ...over,
} as Task);

let checks = 0;
const check = (label: string, fn: () => void) => {
  checks += 1;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nFree windows\n');

console.log('1. Where the day is free');
check('the window between two tasks', () => {
  const gaps = findDayGaps(
    [task({ fixedTime: '09:00', durationMinutes: 60 }), task({ fixedTime: '13:00' })],
    { dayStart: '08:00', dayEnd: '22:00' },
  );
  const between = gaps.find((g) => g.start === '10:00');
  assert.ok(between, 'expected a 10:00 window');
  assert.equal(between!.end, '13:00');
});
check('the window BEFORE the first task (never offered before)', () => {
  const gaps = findDayGaps([task({ fixedTime: '13:00' })], { dayStart: '08:00', dayEnd: '22:00' });
  assert.equal(gaps[0].start, '08:00');
  assert.equal(gaps[0].end, '13:00');
});
check('the window AFTER the last task (never offered before)', () => {
  const gaps = findDayGaps([task({ fixedTime: '09:00', durationMinutes: 60 })], {
    dayStart: '08:00', dayEnd: '22:00',
  });
  assert.ok(gaps.some((g) => g.start === '10:00' && g.end === '22:00'), 'expected an evening window');
});
check('nothing before NOW is free', () => {
  const gaps = findDayGaps([task({ fixedTime: '13:00' })], {
    dayStart: '08:00', dayEnd: '22:00', now: '12:00',
  });
  assert.equal(gaps[0].start, '12:00');
});
check('a window ends when she must LEAVE, not when the meeting starts', () => {
  const away = task({
    fixedTime: '13:00',
    location: { address: 'Haifa', lat: 32.8, lng: 34.99, confirmed: true, leaveHomeBy: '12:10' } as any,
  });
  const gaps = findDayGaps([task({ fixedTime: '09:00', durationMinutes: 60 }), away], {
    dayStart: '08:00', dayEnd: '22:00',
  });
  const before = gaps.find((g) => g.start === '10:00')!;
  assert.equal(before.end, '12:10', 'the hour before a trip is not free');
  assert.equal(before.endsAtDeparture, true);
});
check('overlapping tasks do not invent a window between them', () => {
  const gaps = findDayGaps(
    [task({ fixedTime: '10:00', durationMinutes: 120 }), task({ fixedTime: '11:00', durationMinutes: 60 })],
    { dayStart: '08:00', dayEnd: '22:00' },
  );
  assert.ok(!gaps.some((g) => g.start >= '10:00' && g.end <= '12:00'), 'no window inside a clash');
});
check('a short window is not offered', () => {
  const gaps = findDayGaps(
    [task({ fixedTime: '09:00', durationMinutes: 60 }), task({ fixedTime: '10:20' })],
    { dayStart: '09:00', dayEnd: '11:20', minMinutes: 30 },
  );
  assert.equal(gaps.length, 0);
});

console.log('\n2. Does a block fit');
check('two hours fit the afternoon, with travel either side', () => {
  const gaps = findDayGaps([task({ fixedTime: '09:00', durationMinutes: 60 })], {
    dayStart: '08:00', dayEnd: '22:00',
  });
  assert.ok(fitsInDay(gaps, 120, 40, 40).length > 0);
});
check('a block that needs more than the day has left does NOT fit', () => {
  const gaps = findDayGaps([task({ fixedTime: '09:00', durationMinutes: 60 })], {
    dayStart: '08:00', dayEnd: '12:00',
  });
  assert.equal(fitsInDay(gaps, 120, 30, 30).length, 0);
});

console.log('\n3. What to put in it');
const baseCtx = {
  gap: { start: '12:00', end: '14:00', minutes: 120, endsAtDeparture: false },
  today: DATE,
  todayTasks: [] as Task[],
  overdue: [] as Task[],
  tomorrowTasks: [] as Task[],
  goals: [] as Goal[],
  rotation: 0,
};

check('a task near where she is comes first', () => {
  const errand = task({
    text: 'pick up the prescription',
    date: '2026-08-30',
    location: { address: 'Herzl 5', lat: 32.8156, lng: 34.9892, confirmed: true } as any,
  });
  const ideas = rankGapIdeas({
    ...baseCtx,
    overdue: [errand],
    place: { lat: 32.8184, lng: 34.9885, isHome: false },
  });
  assert.equal(ideas[0].kind, 'nearby');
  assert.equal(ideas[0].taskId, errand.id);
});
check("tomorrow's interview turns the window into prep", () => {
  const ideas = rankGapIdeas({
    ...baseCtx,
    tomorrowTasks: [task({ text: 'ראיון עבודה', date: '2026-09-01', category: 'interview' })],
  });
  assert.ok(ideas.some((i: any) => i.kind === 'prep'), 'expected a prep block');
});
check('something left from an earlier day is offered back', () => {
  const ideas = rankGapIdeas({
    ...baseCtx,
    overdue: [task({ text: 'send the form', date: '2026-08-28' })],
  });
  assert.ok(ideas.some((i: any) => i.kind === 'finish'));
});
check('a heavy morning earns a break', () => {
  const ideas = rankGapIdeas({
    ...baseCtx,
    todayTasks: [
      task({ fixedTime: '07:00', durationMinutes: 90, status: 'complete' }),
      task({ fixedTime: '09:00', durationMinutes: 60, status: 'complete' }),
      task({ fixedTime: '10:30', durationMinutes: 60, status: 'complete' }),
    ],
  });
  assert.ok(ideas.some((i: any) => i.kind === 'rest'), 'expected a break');
});
check('at home, the place-less tasks are the ones offered', () => {
  const chore = task({ text: 'laundry' });
  const ideas = rankGapIdeas({
    ...baseCtx,
    todayTasks: [chore],
    place: { isHome: true },
  });
  assert.ok(ideas.some((i: any) => i.kind === 'home' && i.taskId === chore.id));
});
check('an empty day still gets the wish list', () => {
  const ideas = rankGapIdeas({
    ...baseCtx,
    goals: [{
      id: 'g1', text: 'learn guitar', category: 'aspiration', type: 'aspiration',
      linkedTaskIds: [], completedTasksCount: 0, totalTasksCount: 0, progressPercent: 0,
      status: 'active', createdAt: 0,
    } as Goal],
  });
  assert.equal(ideas[0].kind, 'goal');
});
check('the same task is never offered twice', () => {
  const near = task({
    text: 'gym', date: '2026-08-30',
    location: { address: 'Herzl 5', lat: 32.8156, lng: 34.9892, confirmed: true } as any,
  });
  const ideas = rankGapIdeas({
    ...baseCtx,
    overdue: [near],
    place: { lat: 32.8184, lng: 34.9885, isHome: false },
  });
  assert.equal(ideas.filter((i: any) => i.taskId === near.id).length, 1);
});

console.log('\n4. Travel is part of the window');
check('the evening does not start the minute the gym ends', () => {
  const gym = task({
    text: 'gym', fixedTime: '20:00', durationMinutes: 60,
    location: { address: 'Space Gym', lat: 32.1, lng: 34.8, confirmed: true, travelMinutes: 25 } as any,
  });
  const gaps = findDayGaps([gym], { dayStart: '08:00', dayEnd: '23:00' });
  const evening = gaps[gaps.length - 1];
  assert.equal(evening.start, '21:30', 'home at 21:30 — 25 min ride + 5 packing up');
  assert.equal(evening.travelHomeMinutes, 30);
});
check('a task at home costs no travel', () => {
  const gaps = findDayGaps([task({ text: 'zoom', fixedTime: '20:00', durationMinutes: 60 })], {
    dayStart: '08:00', dayEnd: '23:00',
  });
  const evening = gaps[gaps.length - 1];
  assert.equal(evening.start, '21:00');
  assert.equal(evening.travelHomeMinutes, undefined);
});
check('a located task with no route yet is still assumed to be a trip', () => {
  const away = task({
    text: 'class', fixedTime: '20:00', durationMinutes: 60,
    location: { address: 'somewhere', lat: 32.1, lng: 34.8, confirmed: true } as any,
  });
  const gaps = findDayGaps([away], { dayStart: '08:00', dayEnd: '23:00' });
  assert.ok(gaps[gaps.length - 1].start > '21:00', 'not treated as next door');
});

console.log('\n5. Routines, habits and constraints');

// 2026-08-31 is a Monday; 2026-09-01 a Tuesday.
const MONDAY = '2026-08-31';

check('her notes parse into a Monday habit and a daily obligation', () => {
  const routines = parseRoutineNotes('gym Mon/Wed 18:00, kids 16:00 every day');
  const gym = routines.find((r) => /gym/i.test(r.text))!;
  assert.equal(gym.kind, 'habit');
  assert.deepEqual(gym.weekdays, [1, 3]);
  assert.equal(gym.time, '18:00');
  const kids = routines.find((r) => /kids/i.test(r.text))!;
  assert.equal(kids.kind, 'constraint', 'a pickup is an obligation, not a habit');
  assert.equal(kids.weekdays.length, 7);
});
check('Hebrew notes work too ("צריכה לקחת את הילדים ב-16:00")', () => {
  const routines = parseRoutineNotes('אימון בימי שני ב-18:00; צריכה לקחת את הילדים ב-16:00 כל יום');
  assert.equal(routines.find((r) => /אימון/.test(r.text))?.kind, 'habit');
  assert.deepEqual(routines.find((r) => /אימון/.test(r.text))?.weekdays, [1]);
  assert.equal(routines.find((r) => /ילדים/.test(r.text))?.kind, 'constraint');
});
check('the school run is CUT OUT of the free window, not suggested around', () => {
  const routines = parseRoutineNotes('kids 16:00 every day');
  const trimmed = constrainGaps(
    [{ start: '14:00', end: '19:00', minutes: 300, endsAtDeparture: false }],
    routines, MONDAY,
  );
  assert.equal(trimmed.length, 2, 'one window becomes two');
  assert.equal(trimmed[0].end, '16:00');
  assert.equal(trimmed[1].start, '17:00');
});
check('a habit is inferred from what she actually did', () => {
  const history = [
    task({ text: 'Pilates', date: '2026-08-17', fixedTime: '18:00', category: 'gym' }),
    task({ text: 'Pilates', date: '2026-08-24', fixedTime: '18:00', category: 'gym' }),
  ];
  const habits = habitsFromHistory(history);
  assert.equal(habits.length, 1);
  assert.deepEqual(habits[0].weekdays, [1], 'both were Mondays');
  assert.equal(habits[0].time, '18:00');
});
check('one-off tasks are NOT habits', () => {
  assert.equal(habitsFromHistory([task({ text: 'dentist', date: '2026-08-24' })]).length, 0);
});
check("the Monday habit is the first thing offered in Monday's evening window", () => {
  const ideas = rankGapIdeas({
    ...baseCtx,
    today: MONDAY,
    gap: { start: '17:30', end: '20:00', minutes: 150, endsAtDeparture: false },
    routines: parseRoutineNotes('gym Mon/Wed 18:00'),
  });
  assert.equal(ideas[0].kind, 'habit');
  assert.match(ideas[0].reason, /usually/);
});
check('a habit already on the list is not offered twice', () => {
  const ideas = rankGapIdeas({
    ...baseCtx,
    today: MONDAY,
    gap: { start: '17:30', end: '20:00', minutes: 150, endsAtDeparture: false },
    todayTasks: [task({ text: 'gym Mon/Wed 18:00', fixedTime: '18:00' })],
    routines: parseRoutineNotes('gym Mon/Wed 18:00'),
  });
  assert.ok(!ideas.some((i: any) => i.kind === 'habit'));
});
check('nothing social in the shadow of the pickup', () => {
  const routines = parseRoutineNotes('kids 16:00 every day');
  const gap = { start: '14:30', end: '16:00', minutes: 90, endsAtDeparture: false };
  assert.ok(blockedForGap(routines, MONDAY, gap).includes('leisure'));
  const ideas = rankGapIdeas({
    ...baseCtx,
    today: MONDAY,
    gap,
    routines,
    goals: [{
      id: 'g1', text: 'coffee with Dana', category: 'leisure', type: 'aspiration',
      linkedTaskIds: [], completedTasksCount: 0, totalTasksCount: 0, progressPercent: 0,
      status: 'active', createdAt: 0,
    } as Goal],
  });
  assert.ok(!ideas.some((i: any) => i.kind === 'goal'), 'the wish-list coffee is withheld');
});
check('…but the morning window on the same day is unaffected', () => {
  const routines = parseRoutineNotes('kids 16:00 every day');
  const gap = { start: '09:00', end: '11:00', minutes: 120, endsAtDeparture: false };
  assert.equal(blockedForGap(routines, MONDAY, gap).length, 0);
});

console.log(`\n${checks} checks${process.exitCode ? ' — FAILURES' : ' — all good'}\n`);
