/**
 * run-leave-countdown — a trip tomorrow is not a trip she has missed.
 *
 * The Leave-Now screen showed a red **LATE BY 165 min** over the Ceva
 * interview: a route leaving at 13:18 TOMORROW, looked at 16:03 today. The
 * countdown was pure clock arithmetic —
 *
 *     timeToMinutes(leaveStep.time) - (now.getHours() * 60 + now.getMinutes())
 *
 * — so the calendar was thrown away and every future departure read as already
 * gone, in red, on the one screen whose job is to say whether she is late.
 *
 *   npx tsx tests/run-leave-countdown.ts
 */
import {
  minutesUntilDeparture, isLate, formatCountdown, countdownLabel,
} from '../src/utils/leaveCountdown';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const section = (s: string) => console.log(`\n${s}`);

// The exact moment on her screen.
const NOW = new Date(2026, 8, 22, 16, 3);        // 2026-09-22 16:03
const INTERVIEW_DAY = '2026-09-23';
const LEAVE = '13:18';

// ── 1. THE BUG ─────────────────────────────────────────────────────────────
section('1. the regression itself');

const left = minutesUntilDeparture(INTERVIEW_DAY, LEAVE, NOW);
ok(left !== null, 'tomorrow 13:18 produces a countdown');
ok(!isLate(left), 'a departure TOMORROW is not late');
// The old code computed 13*60+18 - (16*60+3) = -165.
ok(left !== -165, 'the old clock-only answer (-165) is gone');
ok(left! > 0, `it is ahead of her, not behind (${left} min)`);
ok(left === 21 * 60 + 15, `21h15m away — ${left} min`);
ok(
  countdownLabel(left, 'en') === 'LEAVE IN' && countdownLabel(left, 'he') === 'לצאת בעוד',
  'the label says LEAVE IN, in both languages',
);

// ── 2. Genuinely late still reads as late ──────────────────────────────────
section('2. real lateness is preserved');

const goneToday = minutesUntilDeparture('2026-09-22', '15:00', NOW);
ok(goneToday === -63, `a departure an hour ago is -63 (${goneToday})`);
ok(isLate(goneToday), 'and it IS late');
ok(countdownLabel(goneToday, 'en') === 'LATE BY', 'labelled LATE BY');

const soon = minutesUntilDeparture('2026-09-22', '16:20', NOW);
ok(soon === 17, 'a departure in 17 minutes');
ok(!isLate(soon), 'and it is not late');

// Yesterday's departure is late by more than a day, not by minutes-on-a-clock.
const yesterday = minutesUntilDeparture('2026-09-21', '13:18', NOW);
ok(isLate(yesterday), 'yesterday is late');
ok(yesterday! < -24 * 60, `by more than a day (${yesterday} min)`);

// ── 3. Missing or malformed input is NOT "now" ─────────────────────────────
section('3. nothing to judge means no judgement');

ok(minutesUntilDeparture(undefined, LEAVE, NOW) === null, 'no date → null');
ok(minutesUntilDeparture(INTERVIEW_DAY, undefined, NOW) === null, 'no time → null');
ok(minutesUntilDeparture('tomorrow', LEAVE, NOW) === null, 'a non-ISO date → null');
ok(minutesUntilDeparture(INTERVIEW_DAY, '25:00', NOW) === null, 'hour 25 → null');
ok(minutesUntilDeparture(INTERVIEW_DAY, '13:70', NOW) === null, 'minute 70 → null');
ok(minutesUntilDeparture(INTERVIEW_DAY, 'soon', NOW) === null, 'prose → null');
// The important one: an unjudgeable step must not default into "late".
ok(!isLate(null), 'null is never late');
ok(
  countdownLabel(null, 'en') === 'NO LEAVE TIME',
  'and it says so rather than showing a number',
);

// ── 4. Month and year boundaries ───────────────────────────────────────────
section('4. the calendar, not just the clock');

const newYearEve = new Date(2026, 11, 31, 23, 50);
const newYearDay = minutesUntilDeparture('2027-01-01', '00:10', newYearEve);
ok(newYearDay === 20, `across a year boundary: 20 min (${newYearDay})`);
ok(!isLate(newYearDay), 'and not late');

const monthEnd = new Date(2026, 8, 30, 23, 30);
ok(minutesUntilDeparture('2026-10-01', '00:30', monthEnd) === 60, 'across a month boundary');

// ── 5. A number she can feel ───────────────────────────────────────────────
section('5. "165 min" is not an answer for tomorrow');

for (const lang of ['he', 'en'] as const) {
  ok(formatCountdown(17, lang).value === '17', `[${lang}] minutes stay minutes`);
  ok(formatCountdown(59, lang).value === '59', `[${lang}] 59 is still minutes`);
  ok(formatCountdown(60, lang).value === '1', `[${lang}] 60 becomes 1 hour`);
  ok(formatCountdown(165, lang).value === '2:45', `[${lang}] 165 becomes 2:45`);
  const day = formatCountdown(21 * 60 + 15, lang);
  ok(day.value === '21:15', `[${lang}] tomorrow's trip is 21:15, not 1275`);
  const twoDays = formatCountdown(2 * 24 * 60 + 3 * 60, lang);
  ok(twoDays.value === '2d 3h', `[${lang}] beyond a day it counts days (${twoDays.value})`);
  // Lateness is shown as a magnitude; the label carries the direction.
  ok(formatCountdown(-165, lang).value === '2:45', `[${lang}] a late value is absolute`);
}

// Both languages must produce a unit — a bare number is not information.
for (const mins of [17, 90, 1275, 4000]) {
  for (const lang of ['he', 'en'] as const) {
    ok(formatCountdown(mins, lang).unit.trim().length > 0, `[${lang}] ${mins} has a unit`);
  }
  ok(
    formatCountdown(mins, 'he').unit !== formatCountdown(mins, 'en').unit,
    `${mins}: the unit is actually translated`,
  );
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
