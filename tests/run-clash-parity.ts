/**
 * run-clash-parity — the phone and the server must resolve a day the same way.
 *
 * `resolveClashes` used to exist only here, so a day the app called impossible
 * was a day WhatsApp had no opinion about. It now exists twice (server/clashes.py),
 * and two copies of a rule drift — that is the entire history of this codebase.
 *
 * This runs the TypeScript over tests/fixtures/clash-days.json and writes the
 * result to tests/fixtures/clash-golden.json. `server/tests/test_clash_parity.py`
 * runs the SAME fixtures through Python and fails if the answers differ.
 *
 * So: change a rule here, run this, and the Python test tells you at once
 * whether you have to change it there too.
 *
 * Run:  npx tsx tests/run-clash-parity.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveClashes } from '../src/utils/resolveClashes';
import { Task } from '../src/types/index';

const FIXTURES = 'tests/fixtures/clash-days.json';
const GOLDEN = 'tests/fixtures/clash-golden.json';

function main() {
  const input = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  const golden = input.days.map((day: any) => ({
    name: day.name,
    clashes: resolveClashes(day.tasks as Task[], day.dayEnd).map((c) => ({
      a: c.a.id,
      b: c.b.id,
      overlapMinutes: c.overlapMinutes,
      travelShortfall: c.travelShortfall ?? null,
      questionEn: c.questionEn,
      questionHe: c.questionHe,
      options: c.options.map((o) => ({
        kind: o.kind, taskId: o.taskId, newTime: o.newTime ?? null,
        labelEn: o.labelEn, labelHe: o.labelHe,
      })),
    })),
  }));

  const before = (() => { try { return readFileSync(GOLDEN, 'utf8'); } catch { return ''; } })();
  const after = `${JSON.stringify(golden, null, 2)}\n`;
  writeFileSync(GOLDEN, after);

  const days = golden.length;
  const clashes = golden.reduce((n: number, d: any) => n + d.clashes.length, 0);
  console.log(`\nClash parity golden written: ${days} days, ${clashes} clashes.`);
  if (before && before !== after) {
    console.log('  ! the golden CHANGED — run the Python parity test before committing.');
  }
  console.log('  → server/tests/test_clash_parity.py checks Python against this file.\n');
}

main();
