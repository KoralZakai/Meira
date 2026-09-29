/**
 * run-task-source — one bad value must not cost her all 142 tasks.
 *
 * Read off her actual phone, 2026-09-22:
 *
 *   [TaskStorage] cloud syncAllTasks failed { code: '23514',
 *     message: 'new row for relation "tasks" violates check constraint
 *               "tasks_source_check"' }
 *   [App] post-sign-in: pushed 142 task(s)
 *
 * `tasks_source_check` allows six values. PostgREST upserts the whole array in
 * one statement, so a SINGLE row carrying a seventh fails the BATCH — every
 * task, every sync. And it looked fine on the phone, because the local write
 * had already succeeded and the row was simply marked as ahead of the cloud.
 *
 * `safePriority` had guarded its column against exactly this since the
 * beginning; `source` was written straight through. The app ships new kinds of
 * generated task long before anyone runs a migration, so losing the LABEL has
 * to be survivable — losing the row is not.
 *
 * Run:  npx tsx tests/run-task-source.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { prepTasksFor } from '../src/utils/interviewPrep';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const ROOT = join(__dirname, '..');
const migration = readFileSync(
  join(ROOT, 'supabase', 'migrations', '0003_whatsapp_sync.sql'), 'utf8');
const repo = readFileSync(join(ROOT, 'src', 'services', 'supabaseRepo.ts'), 'utf8');

// ── the allowed set, read from the migration itself ────────────────────────
console.log('\nThe database and the client agree on what a source may be\n');

const inSql = (migration.match(/check \("source" in \(([^)]+)\)\)/) ?? [])[1] ?? '';
const allowedInDb = [...inSql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
check('the constraint was parsed out of the migration',
  allowedInDb.length === 6, allowedInDb.join(','));

const inTs = (repo.match(/const VALID_SOURCES = \[([^\]]+)\]/) ?? [])[1] ?? '';
const allowedInTs = [...inTs.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
check('the client list matches the database exactly',
  allowedInTs.join(',') === allowedInDb.join(','),
  `ts=[${allowedInTs}] db=[${allowedInDb}]`);

check('taskToRow runs source through the guard',
  repo.includes('source: safeSource(t.source)'), 'not `t.source ?? null`');
check('the guard logs what it dropped, rather than dropping it silently',
  /function safeSource[\s\S]{0,600}console\.warn/.test(repo));

// ── every source the app actually writes onto a Task ───────────────────────
console.log('\nEvery source the app puts on a Task is accepted\n');

const interview = {
  id: 'gcal-ceva', text: 'Your in-person interview with Ceva',
  date: '2026-09-23', category: 'interview', priority: 'must',
  status: 'pending', isFixed: true, fixedTime: '14:30', durationMinutes: 90,
  createdAt: 0, historicalDurations: [],
} as unknown as Task;

const prep = prepTasksFor(interview, { lang: 'he', today: '2026-09-10' });
// Three since 2026-09-22: D-2, D-1 and the morning of the interview itself.
check('prep blocks are generated', prep.length === 3, `${prep.length}`);
check('and their source is one the database will take',
  prep.every((t) => allowedInDb.includes(String((t as any).source))),
  String((prep[0] as any).source));

// The id is what carries the link, so it must survive a cloud round trip —
// which means it must be a plain id, not a field the row mapping drops.
check('idempotence rides on the id, which does round-trip',
  prep.every((t) => t.id.startsWith('prep-') && t.id.includes('gcal-ceva')),
  prep[0].id);

// ── the whole-batch failure mode, stated ───────────────────────────────────
console.log('\nOne bad row must not take the batch down\n');

const batch = [
  { ...interview, source: 'calendar' },
  { ...interview, id: 'x2', source: 'interview_prep' },  // the seventh value
  { ...interview, id: 'x3', source: 'manual' },
] as unknown as Task[];
const coerced = batch.map((t) => {
  const v = (t as any).source;
  return allowedInDb.includes(v) ? v : null;
});
check('an unknown source becomes null instead of failing the row',
  coerced[1] === null, String(coerced[1]));
check('and the rows either side keep their real source',
  coerced[0] === 'calendar' && coerced[2] === 'manual',
  coerced.join(','));

console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
