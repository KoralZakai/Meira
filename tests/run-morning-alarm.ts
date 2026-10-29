/**
 * run-morning-alarm — the ⏰ at the top of Today never disappears; it moves on.
 *
 * Koral, 20.10: "an icon of an alarm clock that won't disappear even after
 * time has passed … enable/disable (Meira calculates it automatically) and
 * long press can change the time."
 *
 * Run:  npx tsx tests/run-morning-alarm.ts
 */
import {
  morningAlarmFor, nextMorningAlarm, alarmTimeChoices, morningAlarmLabel, momentOf, wakeOptions,
} from '../src/utils/morningAlarm';

const subtract = (hhmm: string, m: number) => {
  const [h, mm] = hhmm.split(':').map(Number);
  const t = h * 60 + mm - m;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const TODAY = '2026-10-20';
const TOMORROW = '2026-10-21';
const task = (extra: Partial<Task>): Task => ({
  id: 't', text: 'שיחה עם דותן', category: 'call', priority: 'must', isFixed: true,
  fixedTime: '09:30', durationMinutes: 15, date: TODAY, status: 'pending',
  createdAt: 0, historicalDurations: [], ...extra,
} as Task);
const inputs = { usualWakeTime: '07:00', routineMinutes: 60 };
const at = (date: string, hhmm: string) => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, m);
};

const call = task({ id: 'call' });
const study = task({ id: 'study', text: 'Morning study', category: 'course', fixedTime: '11:00' });
const interview = task({ id: 'iv', text: 'ראיון', category: 'interview', fixedTime: '10:00', date: TOMORROW });
const all = [call, study, interview];

console.log('\nMorning alarm\n');

console.log('1. Meira picks the hour from the first morning task');
{
  const p = morningAlarmFor(TODAY, all, inputs)!;
  check('the call owns today', p.task?.id === 'call', p.task?.id);
  check('a routine before it: 08:30', p.at === '08:30' && p.autoAt === '08:30', p.at);
  check('on by default', p.on && !p.custom);
}

console.log('2. It never disappears — after its hour it moves to the next morning');
{
  const before = nextMorningAlarm(all, inputs, {}, at(TODAY, '07:00'))!;
  check('at 07:00: today 08:30', before.date === TODAY && before.at === '08:30', `${before.date} ${before.at}`);
  const after = nextMorningAlarm(all, inputs, {}, at(TODAY, '08:50'))!;
  check('at 08:50: tomorrow, for the interview', after.date === TOMORROW && after.task?.id === 'iv', `${after.date} ${after.at}`);
  check('tomorrow 09:00 (10:00 − 60)', after.at === '09:00', after.at);
  const free = nextMorningAlarm([call], inputs, {}, at(TODAY, '09:00'));
  check('nothing ahead in a week → null (the pill says so, it is still drawn)', free === null);
  const later = nextMorningAlarm([call, task({ id: 'far', date: '2026-10-24', fixedTime: '08:00' })], inputs, {}, at(TODAY, '09:00'))!;
  check('a free tomorrow skips to the next morning with a task', later.date === '2026-10-24' && later.at === '07:00', `${later.date} ${later.at}`);
}

console.log('3. Tap = on/off, for that morning only');
{
  const off = nextMorningAlarm(all, inputs, { [TODAY]: { on: false } }, at(TODAY, '07:00'))!;
  check('off is still shown (so it can be turned on)', off.date === TODAY && off.on === false);
  const tmr = nextMorningAlarm(all, inputs, { [TODAY]: { on: false } }, at(TODAY, '08:50'))!;
  check('tomorrow is untouched by today\'s off', tmr.date === TOMORROW && tmr.on);
}

console.log('4. Long press = another hour');
{
  const p = nextMorningAlarm(all, inputs, { [TODAY]: { at: '08:00' } }, at(TODAY, '07:00'))!;
  check('her hour rings, and is marked hers', p.at === '08:00' && p.custom && p.on, `${p.at} custom=${p.custom}`);
  check('Meira\'s hour is kept beside it', p.autoAt === '08:30');
  const same = morningAlarmFor(TODAY, all, inputs, { at: '08:30' })!;
  check('picking Meira\'s own hour is not "custom"', !same.custom);
  const choices = alarmTimeChoices(morningAlarmFor(TODAY, all, inputs)!);
  check('choices start an hour earlier', choices[0] === '07:30', choices.join(' '));
  const odd = alarmTimeChoices({ at: '08:33', autoAt: '08:33', task: task({ fixedTime: '10:30' }) });
  check('her own hour is in the grid', alarmTimeChoices({ at: '08:03', autoAt: '08:33', task: task({ fixedTime: '10:30' }) }).includes('08:03'));
  check('round quarter hours, plus Meira\'s exact one', odd.join(' ') === '07:45 08:00 08:15 08:30 08:33 08:45 09:00', odd.join(' '));
  check('Meira\'s hour is offered', choices.includes('08:30'));
  check('never past the task\'s start', choices.every((c) => c < '09:30'), choices.join(' '));
  const none = morningAlarmFor(TOMORROW, [], inputs, { at: '07:15' })!;
  check('a morning with no task can still ring at an hour she picked', none.at === '07:15' && none.on && !none.task);
}

console.log('5. A morning Meira thinks needs no alarm still gets one she can turn on');
{
  const late = task({ id: 'late', fixedTime: '11:30' });
  const p = morningAlarmFor(TODAY, [late], { usualWakeTime: '07:00', routineMinutes: 60 })!;
  check('drawn', Boolean(p), p ? `${p.at} on=${p.on}` : 'null');
  const muted = morningAlarmFor(TODAY, [task({ alarmState: 'not_needed' })], inputs)!;
  check('the card\'s own mute reads as off', muted.on === false);
  const afternoon = morningAlarmFor(TODAY, [task({ fixedTime: '16:00' })], { usualWakeTime: '07:00', routineMinutes: 60 });
  check('an afternoon-only day has no morning alarm', afternoon === null || afternoon.on === false,
    afternoon ? `${afternoon.at} on=${afternoon.on}` : 'null');
}

console.log('6. Words and moments');
{
  const p = morningAlarmFor(TOMORROW, all, inputs)!;
  check('label says tomorrow', morningAlarmLabel(p, at(TODAY, '20:00'), false) === 'Tomorrow 09:00');
  check('in Hebrew', morningAlarmLabel(p, at(TODAY, '20:00'), true) === 'מחר 09:00');
  const flight = morningAlarmFor(TOMORROW, [task({ date: TOMORROW, fixedTime: '00:40', alarmAt: '22:55' })], inputs)!;
  check('a wake later than its start is the night before', momentOf(flight).getDate() === 20, String(momentOf(flight)));
}

console.log('7. The wake follows the bus (Koral 20.10: "depends on the bus time")');
{
  const leg = { type: 'bus', from: 'home', to: 'x', durationMinutes: 20, departureTime: '09:10', arrivalTime: '09:30', lineNumber: '251', stopName: 'Arlozorov' };
  const routed = (leave: string) => task({ id: 'iv', fixedTime: '10:00', date: TOMORROW, category: 'interview',
    location: { address: 'x', lat: 1, lng: 1, confirmed: true, leaveHomeBy: leave, wakeUpBy: subtract(leave, 60),
      transitPlan: { leaveHomeAt: leave, legs: [leg] } } as any });
  const p = morningAlarmFor(TOMORROW, [routed('09:00')], inputs)!;
  check('the anchor is the leave time', p.anchor?.kind === 'leave' && p.anchor.at === '09:00', JSON.stringify(p.anchor));
  check('and the bus on it', p.anchor?.ride?.line === '251' && p.anchor.ride.time === '09:10');
  check('Meira wakes her 60 min before leaving', p.at === '08:00' && p.beforeMin === 60, `${p.at} ${p.beforeMin}`);
  const opts = wakeOptions(p);
  check('options read as minutes before leaving', opts.some((o) => o.before === 90 && o.at === '07:30'), opts.map((o) => `${o.before}=${o.at}`).join(' '));
  check('Meira\'s option is marked', opts.find((o) => o.auto)?.before === 60);
  const mine = morningAlarmFor(TOMORROW, [routed('09:00')], inputs, { beforeMin: 90 })!;
  check('her choice: 90 min before leaving → 07:30', mine.at === '07:30' && mine.custom, mine.at);
  const busMoved = morningAlarmFor(TOMORROW, [routed('08:40')], inputs, { beforeMin: 90 })!;
  check('the bus moved earlier → her alarm moves with it (07:10)', busMoved.at === '07:10', busMoved.at);
  const noTrip = morningAlarmFor(TODAY, [call], inputs, { beforeMin: 45 })!;
  check('no trip: counts back from the start', noTrip.anchor?.kind === 'start' && noTrip.at === '08:45', noTrip.at);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
