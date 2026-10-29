/**
 * run-plus-slot — the ＋ under the now line is smart "from now until the next
 * event" (Koral, 18.10: "the + doesn't add any task; it needs to be smart from
 * now until the next event").
 *
 * What happened on her phone at 10:31: a call at 11:00, the interview's leave
 * at 12:12. Between now and the call there are 29 minutes. The timeline rows
 * only name windows of 45 minutes and up, so the + said just "Add something",
 * and its list said "no free window today" on every row — and a + on those rows
 * opened a screen instead of adding anything.
 *
 * Pure: utils/findGaps.plusSlot, driven with the same day she had.
 *
 * Run:  npx tsx tests/run-plus-slot.ts
 */
import { findDayGaps, plusSlot, PLUS_MIN_MINUTES } from '../src/utils/findGaps';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

let n = 0;
const mk = (over: Partial<Task>): Task => ({
  id: `t${++n}`, text: 'x', category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 30, date: '2026-10-18', status: 'pending', createdAt: 0, historicalDurations: [],
  ...over,
} as Task);

const opts = { dayStart: '07:00', dayEnd: '22:00' };
const windows = (day: Task[], now: string, minMinutes = PLUS_MIN_MINUTES) => findDayGaps(day, { ...opts, now, minMinutes });

// Her Sunday: a call at home 11:00–12:00, an interview in Haifa 13:30 (leave 12:12).
const call = mk({ text: 'Call with Michal', category: 'call', fixedTime: '11:00', durationMinutes: 60 });
const interview = mk({
  text: 'Technical interview', category: 'interview', fixedTime: '13:30', durationMinutes: 90,
  location: { address: 'Rafael, Haifa', lat: 32.8, lng: 35, confirmed: true, leaveHomeBy: '12:12', travelMinutes: 48 } as any,
});

console.log('\nFrom now to the next event');
{
  const day = [call, interview];
  const slot = plusSlot(windows(day, '10:31'), '10:31');
  eq('10:31 → a window she is IN, 29 minutes long', [slot?.startsNow, slot?.gap.minutes], [true, 29]);
  eq('a task added there starts at the next 5 minutes and ends at the call', [slot?.from, slot?.until], ['10:35', '11:00']);
  eq('the old 45-minute floor saw nothing now — which is the bug',
    windows(day, '10:31', 45)[0]?.start === '10:31', false);
}

console.log('\nWhen she is not in a window');
{
  const day = [call, interview];
  const slot = plusSlot(windows(day, '11:20'), '11:20');
  eq('mid-call → the next window, not "now"', slot?.startsNow, false);
  const noGaps = plusSlot([], '11:20');
  eq('no window at all → null, never an invented one', noGaps, null);
}

console.log('\nDefault length');
{
  const slot = plusSlot(windows([], '09:00'), '09:00');
  eq('an empty day is not one 13-hour task: capped at an hour', [slot?.from, slot?.until], ['09:00', '10:00']);
  const tight = plusSlot(windows([mk({ fixedTime: '11:00', durationMinutes: 30 })], '10:46'), '10:46');
  eq('14 minutes before a meeting: from 10:50 (rounded up) to 11:00', [tight?.from, tight?.until], ['10:50', '11:00']);
  const eight = plusSlot(windows([mk({ fixedTime: '11:00', durationMinutes: 30 })], '10:52'), '10:52');
  eq('8 minutes before a meeting is not a window: the + names the NEXT one (11:30), not now', [eight?.startsNow, eight?.gap.start], [false, '11:30']);
  const edge = plusSlot(windows([mk({ fixedTime: '11:00', durationMinutes: 30 })], '10:49'), '10:49');
  eq('rounding must not eat the window: 10:49 → 10:50 still leaves 10 minutes', [edge?.from, edge?.until], ['10:50', '11:00']);
}

console.log('\nA window ends at the DEPARTURE, not at the event');
{
  const lonely = [interview];
  const slot = plusSlot(windows(lonely, '11:50'), '11:50');
  eq('interview 13:30, leave 12:12 → the window closes at 12:12', [slot?.gap.end, slot?.until], ['12:12', '12:12']);
  eq('…and says it ends at a departure', slot?.gap.endsAtDeparture, true);
}

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
