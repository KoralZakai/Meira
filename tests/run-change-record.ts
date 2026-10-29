/**
 * run-change-record — the calendar moved something: when it earns a card, and what the card says (19.10).
 * Run:  npx tsx tests/run-change-record.ts
 */
import { readFileSync } from 'node:fs';
import { describeChange, effectLine, headline, isStillOpen, momentLabel } from '../src/utils/changeRecord';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const TODAY = '2026-10-19'; const NOW = '10:00';
const interview = (o: Partial<Task> = {}): Task => ({
  id: 'gcal-w', text: 'Your Phone Screen at Workday', category: 'interview', priority: 'must', isFixed: true,
  date: '2026-10-20', fixedTime: '13:00', durationMinutes: 60, status: 'pending', createdAt: 0, historicalDurations: [], ...o,
} as Task);
const dentist = (o: Partial<Task> = {}): Task => interview({ id: 'gcal-d', text: 'Dentist', category: 'doctor', ...o });

// ── later ──
const later = describeChange({ date: '2026-10-19', fixedTime: '13:00' }, interview(), TODAY, NOW)!;
check('an interview moved a day later earns a card', !!later && later.kind === 'later' && later.daysDelta === 1 && later.prep);
check('the key holds the NEW state (a re-import of it is not new)', later.key === 'change:gcal-w:2026-10-20:13:00');
check('HE headline + one extra day', headline(later, 'he') === 'הראיון ב-Workday הוזז' || headline(later, 'he').includes('הוזז'));
check('HE says one more day to prepare', effectLine(later, 'he').includes('עוד יום להתכונן'));
check('EN says one more day to prepare', effectLine(later, 'en').includes('one more day to prepare'));
check('both moments are dated, with weekday (rule 4)',
  momentLabel(later.before, 'he') === 'ב׳ 19.10 13:00' && momentLabel(later.after, 'en') === 'Tue 20.10 13:00');
const three = describeChange({ date: '2026-10-19', fixedTime: '13:00' }, interview({ date: '2026-10-22' }), TODAY, NOW)!;
check('three days later: "3 more days"', effectLine(three, 'he').includes('עוד 3 ימים') && effectLine(three, 'en').includes('3 more days'));

// ── earlier ──
const earlier = describeChange({ date: '2026-10-23', fixedTime: '13:00' }, interview({ date: '2026-10-21' }), TODAY, NOW)!;
check('earlier says less time, not more', earlier.kind === 'earlier' && effectLine(earlier, 'he').includes('פחות') && effectLine(earlier, 'en').includes('less'));

// ── same day ──
const shift = describeChange({ date: '2026-10-20', fixedTime: '13:00' }, interview({ fixedTime: '13:40' }), TODAY, NOW)!;
check('40 minutes later on the same day', shift.kind === 'sameDay' && shift.minutesDelta === 40 && effectLine(shift, 'en').startsWith('40 min later'));
check('a 10-minute nudge earns no card', describeChange({ date: '2026-10-20', fixedTime: '13:00' }, interview({ fixedTime: '13:10' }), TODAY, NOW) === null);
check('two hours reads as hours', effectLine(describeChange({ date: '2026-10-20', fixedTime: '13:00' }, interview({ fixedTime: '15:00' }), TODAY, NOW)!, 'he').includes('2 שעות'));

// ── not an interview ──
const doc = describeChange({ date: '2026-10-20', fixedTime: '09:00' }, dentist({ date: '2026-10-22', fixedTime: '09:00' }), TODAY, NOW)!;
check('a dentist: the move, no promise about preparing', !doc.prep && effectLine(doc, 'en') === 'Moved in your calendar' && headline(doc, 'en') === 'Dentist moved');

// ── when there is nothing to say ──
check('nothing changed', describeChange({ date: '2026-10-20', fixedTime: '13:00' }, interview(), TODAY, NOW) === null);
check('moved INTO the past: no card', describeChange({ date: '2026-10-20', fixedTime: '13:00' }, interview({ date: '2026-10-18' }), TODAY, NOW) === null);
check('today but the hour has gone: no card', describeChange({ date: '2026-10-19', fixedTime: '15:00' }, interview({ date: '2026-10-19', fixedTime: '09:00' }), TODAY, NOW) === null);
check('a done task: no card', describeChange({ date: '2026-10-19' }, interview({ status: 'complete' }), TODAY, NOW) === null);
check('a prep block follows its interview silently',
  describeChange({ date: '2026-10-19', fixedTime: '19:00' }, interview({ id: 'prep-gcal-w-1', text: 'Prep for the Workday interview — company, role', date: '2026-10-20', fixedTime: '19:00' }), TODAY, NOW) === null);
check('missing data is no card, not a crash', describeChange(null, interview(), TODAY, NOW) === null);

// ── lifetime ──
check('open until the event day passes', isStillOpen(later, '2026-10-20') && !isStillOpen(later, '2026-10-21'));

// ── the trigger exists (rule 7): reconcile writes it; Today draws it ──
const sync = readFileSync('src/services/GoogleSync.ts', 'utf8');
check('GoogleSync reconcile records a calendar move', sync.includes('describeChange(') && sync.includes('recordChange('));
const today = readFileSync('src/screens/TodaySchedule.tsx', 'utf8');
// 28.10 (Koral): changes live under the 🔔, not on the day — Today feeds the bell, the bell draws them.
const bell = readFileSync('src/components/today/AlertsSheet.tsx', 'utf8');
check('the bell draws the cards', bell.includes('<ChangeCard ') && today.includes('changes={changes}'));
check('…and Today no longer does', !today.includes('<ChangeCards'));
const store = readFileSync('src/services/ChangeRecordStore.ts', 'utf8');
check('a failed read says so (rule 1), no bare catch { return [] }', store.includes('error') && !/catch\s*\{\s*return \[\]/.test(store));
check('no travel question anywhere in the card text',
  !/how will you get|איך תגיעי|איך תגיעו/i.test(readFileSync('src/utils/changeRecord.ts', 'utf8') + readFileSync('src/components/ChangeCards.tsx', 'utf8')));

// ── the offer on the card (19.10) ──
const cards = readFileSync('src/components/ChangeCards.tsx', 'utf8');
check('the chips book through the service, not by hand', cards.includes('acceptStudy(') && cards.includes('acceptWake(') && cards.includes('suggestionFor('));
check('a booked line comes from the booking result', cards.includes('res.line') && cards.includes('if (!res.saved)'));
check('a server that cannot be reached is shown as such, not as "no hour"', cards.includes('No connection to the server') && cards.includes('No free window'));
check('the record keeps the category for the server', later.category === 'interview' && doc.category === 'doctor');

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
