/**
 * run-workout-category — a workout is a 💪, never a 💼 (15.10, Koral).
 *
 * "אימון" showed with the Work briefcase. Five tables label a task and three of
 * them wrote "workout" without the optional space, so "work out" (the way she
 * dictates it) fell to the `work` rule one line below:
 *
 *   server/categorize.py, utils/categorize.ts   — no "work out" in `gym`
 *   utils/routines.categoryFor                  — /workout/ then /work|office/
 *   services/TaskParser (fallbackParse, inferTaskDetails) — the same again
 *
 * and routineRows merged her five tellings into ONE card that showed the
 * plainest title ("אימון") over the WINNING line's routine — the spoken one,
 * "work out and…", already filed as work. Tasks saved from it carry that
 * category, so stored rows needed healing too.
 *
 * Run:  npx tsx tests/run-workout-category.ts
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
  if (request === './NotificationService' || request.endsWith('/NotificationService')) {
    return { __esModule: true, armTaskAlerts: async () => {}, cancelTaskNotifications: async () => {} };
  }
  // TaskParser imports LumiServer (react-native). The server is "unreachable"
  // here, which is exactly the path that runs the phone's own parser.
  if (request === './LumiServer' || request.endsWith('/LumiServer')) {
    return { __esModule: true, extractTasks: async () => null };
  }
  return origLoad.call(this, request, ...rest);
};

import { readFileSync } from 'fs';
import { join } from 'path';
import type { Task } from '../src/types/index';
import { inferFromText } from '../src/utils/categorize';
import { parseRoutineNotes, healWorkoutCategory, Routine } from '../src/utils/routines';
import { routineRowsFor } from '../src/utils/routineRows';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskStorage = require('../src/services/TaskStorage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskParser = require('../src/services/TaskParser');

let failures = 0; let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  console.log('\n1. The shared table: every spelling of a workout is gym\n');
  for (const text of [
    'אימון', 'work out', 'Work out at the gym', 'working out', 'workout',
    'אימון · יגאל אלון 76', 'אימון בערב · יום ראשון · 20:00', 'להתאמן ביגאל אלון',
    'אימונים בערב', 'אני מתאמנת בשלישי',
  ]) {
    const got = inferFromText(text).category;
    check(`"${text}" → gym`, got === 'gym', got);
  }
  check('real work is still work', inferFromText('deep work on the project').category === 'work');
  check('"עבודה" is still work', inferFromText('עבודה על הפרויקט').category === 'work');

  // Parity: the Python table carries the same two words, in front of `work`.
  const py = readFileSync(join(__dirname, '..', 'server', 'categorize.py'), 'utf8');
  const gymRule = py.slice(py.indexOf('("gym",'), py.indexOf('("course",'));
  check('server/categorize.py has "work out" in gym', /"work out"/.test(gymRule));
  check('server/categorize.py has "working out" in gym', /"working out"/.test(gymRule));

  console.log('\n2. Routines: categoryFor follows the same table\n');
  for (const line of [
    'work out · Sundays, Monday and Tuesdays · 20:00 · עיגל אלון 96',
    'I work out on Sundays, Monday and Tuesdays on 8pm. I train at עיגל אלון 96.',
    'אימון · יום ראשון, שני ושלישי · 20:00 · עיגול אלון 94, תל אביב',
    'להתאמן · ימי ראשון עד שלישי · 20:00',
    'yoga Friday 11:00',
  ]) {
    const r = parseRoutineNotes(line)[0];
    check(`routine "${line.slice(0, 40)}…" → gym`, r?.category === 'gym', String(r?.category));
  }
  const work = parseRoutineNotes('office shift Monday 09:00')[0];
  check('an office shift stays work', work?.category === 'work', String(work?.category));

  console.log('\n3. The merged routine card is a gym card\n');
  const HER_LINES = [
    'אימון · יום ראשון, שני ושלישי · 20:00 · עיגול אלון 94, תל אביב',
    'work out · Sundays, Monday and Tuesdays · 20:00 · עיגל אלון 96',
    'I work out on Sundays, Monday and Tuesdays on 8pm. I train at עיגל אלון 96.',
  ].join('\n');
  const rows = routineRowsFor(parseRoutineNotes(HER_LINES), '2026-10-12', []).filter((r) => r.start === '20:00');
  check('Monday 20:00 is ONE card', rows.length === 1, String(rows.length));
  check('its title is the plain one', rows[0]?.title === 'אימון', rows[0]?.title);
  check('and its category is gym', rows[0]?.routine.category === 'gym', String(rows[0]?.routine.category));

  // The exact failure: the WINNING line carries `work` (a routine that arrived
  // with the old categoryFor, or from history), the plain line carries gym.
  const mk = (over: Partial<Routine>): Routine => ({
    id: 'r', kind: 'habit', text: 'אימון', weekdays: [1], time: '20:00', durationMinutes: 60,
    category: 'gym', source: 'notes', daysFrom: 'said', ...over,
  });
  const merged = routineRowsFor([
    mk({ id: 'plain', text: 'אימון' }),
    mk({ id: 'spoken', text: 'work out and אימון · 20:00 · יגאל אלון 96', category: 'work' }),
  ], '2026-10-12', []);
  check('a stale `work` winner still draws ONE gym card',
    merged.length === 1 && merged[0].routine.category === 'gym',
    merged.map((m) => `${m.title}:${m.routine.category}`).join(' | '));
  const lone = routineRowsFor([mk({ text: 'work out · 20:00', category: 'work' })], '2026-10-12', []);
  check('a lone `work` row for a workout is gym too', lone[0]?.routine.category === 'gym', String(lone[0]?.routine.category));
  const real = routineRowsFor([mk({ text: 'office shift 20:00', category: 'work' })], '2026-10-12', []);
  check('a real work routine is left alone', real[0]?.routine.category === 'work', String(real[0]?.routine.category));

  console.log('\n4. The phone parser agrees with the table\n');
  const details = TaskParser.inferTaskDetails('work out at the gym');
  check('inferTaskDetails("work out") → gym 💪',
    details.category === 'gym' && details.icon === '💪', `${details.category} ${details.icon}`);
  check('inferTaskDetails("אימון") → gym', TaskParser.inferTaskDetails('אימון').category === 'gym');
  check('inferTaskDetails("project work") → work',
    TaskParser.inferTaskDetails('project work').category === 'work');
  const parsed = await TaskParser.parseSpeechToTasks('work out tomorrow at 7pm');
  check('fallbackParse("work out…") → gym', parsed[0]?.category === 'gym', String(parsed[0]?.category));
  const parsedHe = await TaskParser.parseSpeechToTasks('אימון ביגאל אלון');
  check('fallbackParse("אימון…") → gym', parsedHe[0]?.category === 'gym', String(parsedHe[0]?.category));

  console.log('\n5. Stored tasks are healed\n');
  const task = (over: Partial<Task>): Task => ({
    id: Math.random().toString(36).slice(2), text: 'task', category: 'general', priority: 'need_to',
    isFixed: false, durationMinutes: 60, date: '2026-10-15', status: 'pending', createdAt: 1_000,
    historicalDurations: [], ...over,
  } as Task);
  const a = task({ id: 'a', text: 'אימון', category: 'work', fixedTime: '20:00', isFixed: true });
  const b = task({ id: 'b', text: 'work out at the gym', category: 'work' });
  const c = task({ id: 'c', text: 'deep work on the roadmap', category: 'work' });
  const d = task({ id: 'd', text: 'אימון · יגאל אלון 76', category: 'gym' });

  check('pure: a work-filed workout comes back as gym', healWorkoutCategory(a).category === 'gym');
  check('pure: nothing to heal returns the SAME object', healWorkoutCategory(c) === c && healWorkoutCategory(d) === d);
  check('pure: the input is not mutated', a.category === 'work');

  store.clear();
  store.set('lumi.tasks.v1', JSON.stringify([a, b, c, d]));
  const read = await TaskStorage.getAllTasks();
  const cat = (rows: Task[], id: string) => rows.find((t) => t.id === id)?.category;
  check('getAllTasks reads the two workouts as gym', cat(read, 'a') === 'gym' && cat(read, 'b') === 'gym',
    `${cat(read, 'a')} ${cat(read, 'b')}`);
  check('…and leaves real work and a gym task alone', cat(read, 'c') === 'work' && cat(read, 'd') === 'gym');
  check('…without writing on READ (still work in the store)',
    JSON.parse(store.get('lumi.tasks.v1')!).find((t: Task) => t.id === 'a').category === 'work');
  check('a healed task keeps its other fields',
    read.find((t: Task) => t.id === 'a').fixedTime === '20:00' && read.find((t: Task) => t.id === 'a').isFixed === true);

  await TaskStorage.healTaskStore();
  const stored: Task[] = JSON.parse(store.get('lumi.tasks.v1')!);
  check('healTaskStore persists the two workouts as gym', cat(stored, 'a') === 'gym' && cat(stored, 'b') === 'gym',
    stored.map((t) => `${t.id}:${t.category}`).join(' '));
  check('…and does not touch the rest', cat(stored, 'c') === 'work' && cat(stored, 'd') === 'gym' && stored.length === 4);
  const again = await TaskStorage.healWorkoutCategories();
  check('a second heal finds nothing to do', again === 0, String(again));

  console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
