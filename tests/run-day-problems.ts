/**
 * run-day-problems — one problem per pair, and the ones that matter.
 *
 * Koral's real Wednesday, 30.9 (tests/fixtures/clash-days.json): Nebius at
 * Azrieli until 12:00, coffee with Dana in Herzliya at 12:15 (54 min by train),
 * and a two-hour business plan laid over the 18:30 meetup at Sarona — filed as
 * a 'call'. The screen showed the Dana problem TWICE and the meetup not at all.
 *
 * Run: npx tsx tests/run-day-problems.ts
 */
import { readFileSync } from 'node:fs';
import { dayProblems, problemKey, moveSlotFor } from '../src/utils/dayProblems';
import { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

function main() {
  const days = JSON.parse(readFileSync('tests/fixtures/clash-days.json', 'utf8')).days;
  const wednesday: Task[] = days.find((d: any) => d.name.startsWith('30.9')).tasks;

  console.log('\nThe day\'s problems — 30.9\n');
  const problems = dayProblems(wednesday);
  check('exactly two problems', problems.length === 2, problems.map((p) => p.kind).join(', '));
  check('no pair appears twice', new Set(problems.map((p) => p.key)).size === problems.length);

  const travel = problems.find((p) => p.kind === 'travel');
  check('Nebius → Dana is a travel problem', Boolean(travel));
  if (travel && travel.kind === 'travel') {
    check('from Nebius to Dana', travel.from.id === 'nebius' && travel.to.id === 'dana');
    check('15 minutes between them', travel.gapMinutes === 15, `${travel.gapMinutes}`);
    check('the planned ride is 54 min', travel.travelMinutes === 54, `${travel.travelMinutes}`);
    check('she would be 39 min late', travel.lateBy === 39, `${travel.lateBy}`);
    check('arriving 12:54', travel.arriveAt === '12:54', travel.arriveAt);
    check('the round time to ask Dana for is 13:00', travel.askFor === '13:00', travel.askFor);
    check("the resolver's options ride along on the same entry", Boolean(travel.clash));
  }

  const overlap = problems.find((p) => p.kind === 'overlap');
  check('the business plan over the meetup is an overlap', Boolean(overlap));
  if (overlap && overlap.kind === 'overlap') {
    check('the business plan is the work that can move', overlap.work.id === 'plan', overlap.work.id);
    check('the meetup is the appointment', overlap.fixed.id === 'meetup', overlap.fixed.id);
    check('90 minutes shared', overlap.overlapMinutes === 90, `${overlap.overlapMinutes}`);
  }
  check('in the order she meets them — 12:15 before 18:30',
    problems[0]?.kind === 'travel' && problems[1]?.kind === 'overlap');

  console.log('\nWhere the business plan goes\n');
  const plan = wednesday.find((t) => t.id === 'plan')!;
  const at0902 = moveSlotFor(plan, wednesday, { now: '09:02', dayStart: '08:00', dayEnd: '23:00' });
  check('at 09:02 — 13:00, the first window its two hours fit, before the yoga ride', at0902 === '13:00', at0902);
  const at1410 = moveSlotFor(plan, wednesday, { now: '14:10', dayStart: '08:00', dayEnd: '23:00' });
  check('at 14:10 — no two hours left today, so tomorrow', at1410 === 'tomorrow', at1410);

  console.log('\nThings it must not say\n');
  const noRoute = wednesday.map((t) => (t.id === 'dana'
    ? { ...t, location: { address: (t.location as any).address } } as Task
    : t));
  check('an unrouted leg is not guessed into a warning',
    !dayProblems(noRoute).some((p) => p.kind === 'travel'));
  const done = wednesday.map((t) => (t.id === 'plan' ? { ...t, status: 'complete' } as Task : t));
  check('work she has finished is in nobody\'s way',
    !dayProblems(done).some((p) => p.kind === 'overlap'));
  const texting = wednesday.map((t) => (t.id === 'plan' ? { ...t, durationMinutes: 20 } as Task : t));
  check('twenty minutes of it during the meetup is not a problem',
    !dayProblems(texting).some((p) => p.kind === 'overlap'));
  check('keys are order-free', problemKey(wednesday[1], wednesday[2]) === problemKey(wednesday[2], wednesday[1]));

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
