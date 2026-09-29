/**
 * run-reconcile-persistence — a field that cannot be stored must not be
 * reconciled.
 *
 * Read off her phone, on every single sync, forever:
 *
 *   [GoogleSync] reconcile: {"seen":1,"updated":1,
 *     "notes":["corrected \"Your in-person interview with Ceva\": attendees"]}
 *
 * `attendees` was on GoogleSync's `owned` list — the fields Google is allowed
 * to correct — but it was not a column in Supabase and not in `taskToRow`. So
 * every push dropped it, cloud hydration handed back a row without it, and the
 * next reconcile found a difference and "corrected" it again: a local write
 * and a cloud push every 15 minutes, over nothing.
 *
 * `sameValue` had already been taught to compare arrays by value, which was
 * necessary and not sufficient — the two sides really were different each
 * time, because one of them kept being erased. **A reconcile of a field that
 * does not survive storage cannot converge, whatever the comparison does.**
 *
 * So this asserts the invariant directly, against the source of both halves.
 *
 * Run:  npx tsx tests/run-reconcile-persistence.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const ROOT = join(__dirname, '..');
const sync = readFileSync(join(ROOT, 'src', 'services', 'GoogleSync.ts'), 'utf8');
const repo = readFileSync(join(ROOT, 'src', 'services', 'supabaseRepo.ts'), 'utf8');

// ── the fields Google is allowed to correct ────────────────────────────────
const ownedBlock = (sync.match(/const owned: string\[\] = \[([\s\S]*?)\];/) ?? [])[1] ?? '';
const owned = [...ownedBlock.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);

// ...and the ones that can be pushed to the cloud at all.
const rowBlock = (repo.match(/function taskToRow[\s\S]*?\n}/) ?? [])[0] ?? '';
const persisted = new Set([...rowBlock.matchAll(/^\s{4}([A-Za-z]+):/gm)].map((m) => m[1]));

console.log('\nWhat Google owns, and what storage can keep\n');

check('the owned list was parsed', owned.length >= 5, owned.join(', '));
check('taskToRow was parsed', persisted.size > 20, `${persisted.size} columns`);

const unstorable = owned.filter((f) => !persisted.has(f));
check('EVERY reconciled field survives a round trip through the cloud row',
  unstorable.length === 0,
  unstorable.length
    ? `${unstorable.join(', ')} would loop forever — add to taskToRow (and a migration) or drop from owned`
    : owned.join(', '));

check('attendees is no longer reconciled — it was the one that looped',
  !owned.includes('attendees'));

// ── the conditionally-owned address fields obey it too ─────────────────────
const pushBlock = (sync.match(/owned\.push\(([^)]*)\)/) ?? [])[1] ?? '';
const conditional = [...pushBlock.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
const condUnstorable = conditional.filter((f) => !persisted.has(f));
check('the conditionally-owned fields are storable too',
  condUnstorable.length === 0,
  condUnstorable.join(', ') || conditional.join(', '));

// ── the two that were being dropped are now carried ────────────────────────
console.log('\nThe fields that were silently dropped\n');
check('meetingUrl is in the cloud row now', persisted.has('meetingUrl'));
check('attendees is in the cloud row now', persisted.has('attendees'));

const migration = readFileSync(
  join(ROOT, 'supabase', 'migrations', '0011_task_calendar_fields.sql'), 'utf8');
check('and a migration adds the columns', /meetingUrl/.test(migration) && /attendees/.test(migration));
check('the migration is idempotent — safe to run twice',
  (migration.match(/add column if not exists/g) ?? []).length === 2);

// ── and an unknown column must not break the write before it is run ────────
check('upsertTolerant drops an unknown column and warns, rather than failing',
  /missingColumnOf\(error\)/.test(repo) && /does not exist in this database/.test(repo));

console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
