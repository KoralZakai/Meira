/**
 * run-lead-learning — Lumi warns THIS person earlier once she keeps leaving late.
 *
 * `profile.learnedLeadMinutes` was read by utils/leadTime and written by
 * nothing, so every task got the category default forever. These are the
 * invariants of the observation that now fills it:
 *
 *   1. leaving late raises the lead; leaving early lowers it
 *   2. a reading with no plan or no detected departure teaches nothing
 *   3. an implausible gap is discarded, not averaged in
 *   4. one late morning moves the number a little; a habit moves it a lot
 *   5. the learned value actually reaches resolveLeadMinutes
 *
 * Run:  npx tsx tests/run-lead-learning.ts
 */
import {
  departureSlipMinutes,
  nextLearnedLead,
  learnLead,
  MAX_PLAUSIBLE_SLIP_MINUTES,
} from '../src/utils/leadLearning';
import { resolveLeadMinutes, CATEGORY_DEFAULT_LEAD } from '../src/utils/leadTime';
import { TaskCategory } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const DATE = '2026-08-28';
/** Epoch ms for a HH:MM on DATE — the same construction the app uses. */
const at = (hhmm: string) => new Date(`${DATE}T${hhmm}:00`).getTime();

function main() {
  console.log('\nLead learning\n');

  // ── 1. the slip is the gap between planned and real departure ───────────
  console.log('1. Slip measures how late the departure actually was');
  check('leaving 8 min after the plan is a slip of +8',
    departureSlipMinutes({ date: DATE, leaveHomeBy: '09:40', departedAt: at('09:48') }) === 8);
  check('leaving 5 min early is a slip of -5',
    departureSlipMinutes({ date: DATE, leaveHomeBy: '09:40', departedAt: at('09:35') }) === -5);
  check('leaving exactly on time is a slip of 0',
    departureSlipMinutes({ date: DATE, leaveHomeBy: '09:40', departedAt: at('09:40') }) === 0);

  // ── 2. nothing to compare means nothing to learn ────────────────────────
  console.log('\n2. An unmeasurable morning teaches nothing');
  check('no planned departure → undefined',
    departureSlipMinutes({ date: DATE, departedAt: at('09:48') }) === undefined);
  check('no detected departure → undefined',
    departureSlipMinutes({ date: DATE, leaveHomeBy: '09:40' }) === undefined);
  check('no date → undefined',
    departureSlipMinutes({ date: '', leaveHomeBy: '09:40', departedAt: at('09:48') }) === undefined);
  check('a malformed leave time → undefined',
    departureSlipMinutes({ date: DATE, leaveHomeBy: '9:4', departedAt: at('09:48') }) === undefined);

  // ── 3. noise is discarded rather than averaged in ───────────────────────
  console.log('\n3. An implausible gap is noise, not behaviour');
  const wayLate = at('09:40') + (MAX_PLAUSIBLE_SLIP_MINUTES + 10) * 60000;
  check(`${MAX_PLAUSIBLE_SLIP_MINUTES + 10} min late is discarded (forgotten phone, bad fix)`,
    departureSlipMinutes({ date: DATE, leaveHomeBy: '09:40', departedAt: wayLate }) === undefined);
  check('...and so is the same gap in the other direction',
    departureSlipMinutes({
      date: DATE, leaveHomeBy: '09:40',
      departedAt: at('09:40') - (MAX_PLAUSIBLE_SLIP_MINUTES + 10) * 60000,
    }) === undefined);
  check(`exactly ${MAX_PLAUSIBLE_SLIP_MINUTES} min is still inside the boundary`,
    departureSlipMinutes({
      date: DATE, leaveHomeBy: '09:40',
      departedAt: at('09:40') + MAX_PLAUSIBLE_SLIP_MINUTES * 60000,
    }) === MAX_PLAUSIBLE_SLIP_MINUTES);

  // ── 4. one morning nudges, a habit moves ────────────────────────────────
  console.log('\n4. One late morning nudges; a habit moves the number');
  const once = nextLearnedLead(30, 30 + 10);
  check('a single +10 slip moves 30 by less than the full 10', once > 30 && once < 40, `${once}`);
  // The habit must SETTLE at "ten minutes earlier", not climb forever: the slip
  // is measured against a fixed leaveHomeBy, so re-adding it each time would
  // push the lead up by 10 every morning without end.
  let lead = 30;
  for (let i = 0; i < 20; i += 1) lead = nextLearnedLead(lead, 30 + 10);
  check('twenty identical late mornings land on +10 (±1 for rounding)',
    lead >= 39 && lead <= 40, `${lead}`);
  // Settling matters more than hitting 40 exactly: a value that keeps creeping
  // is the divergence bug, and rounding leaves a stable fixed point a minute short.
  const settled = nextLearnedLead(lead, 30 + 10);
  check('...and stays there — it does not keep creeping', settled === lead, `${lead} → ${settled}`);
  check('leaving early pulls the lead back down', nextLearnedLead(40, 30 - 10) < 40);
  check('the lead never drops below a usable warning', nextLearnedLead(3, -60) >= 2);

  // ── 5. the learned value reaches the alert planner ───────────────────────
  console.log('\n5. What is learned is what gets used');
  const learned = learnLead(undefined, {
    category: 'gym' as TaskCategory,
    baseLead: 30,
    date: DATE,
    leaveHomeBy: '09:40',
    departedAt: at('09:50'),
  });
  check('a measurable morning produces a table', Boolean(learned?.gym), JSON.stringify(learned));
  check('gym default is 30 before learning', CATEGORY_DEFAULT_LEAD.gym[0] === 30);
  const planned = resolveLeadMinutes({ category: 'gym' }, { learned });
  check('resolveLeadMinutes now warns earlier than the default',
    planned[0] > 30, `${planned.join(', ')}`);

  // Successive observations must compound off the LEARNED value, not restart
  // from the default — otherwise every late morning re-derives the same first
  // correction and the number never reflects a habit.
  const second = learnLead(learned, {
    category: 'gym' as TaskCategory,
    baseLead: 30,
    date: DATE,
    leaveHomeBy: '09:40',
    departedAt: at('09:50'),
  });
  check('a second late morning compounds off the first',
    (second?.gym ?? 0) > (learned?.gym ?? 0), `${learned?.gym} → ${second?.gym}`);

  check('an unmeasurable morning writes nothing',
    learnLead(learned, {
      category: 'gym' as TaskCategory, baseLead: 30, date: DATE,
    }) === undefined);

  // A category that was never observed must stay on its default.
  check('learning gym leaves interview untouched',
    resolveLeadMinutes({ category: 'interview' }, { learned }).join() ===
      resolveLeadMinutes({ category: 'interview' }, {}).join());

  // An explicit "remind me 30 minutes before" still outranks anything learned.
  check('a spoken lead still wins over the learned one',
    resolveLeadMinutes({ category: 'gym', remindMinutesBefore: [25] }, { learned }).join() === '25');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
