/**
 * The wedding that looked like today's business.
 *
 * Koral, 2026-09-21: "Hani and Danny's wedding shows on today, but it was on
 * 17.9 — why is it showing today?"
 *
 * It was showing because an unfinished task keeps its own date and the
 * overdue card resurfaces it — which is the point of the card. What the card
 * never did was SAY which day the task came from, and it offered "reschedule"
 * for a wedding that had already happened.
 *
 * This is the third instance of one failure: the app holds the fact and does
 * not surface it. The alarm was armed behind a ▸. The calendar error was
 * swallowed into an empty array. Here the date was known and not drawn.
 *
 * These checks exercise the pure logic the card renders from — the date
 * label, and the went/reschedule decision — in BOTH languages, per the
 * language-parity rule.
 */
import assert from 'assert';
import { Task } from '../src/types/index';

const TODAY = '2026-09-21';

/** Mirrors YesterdayCard.previousDay. */
function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Mirrors YesterdayCard.whenLabel. */
function whenLabel(date: string, today: string, he: boolean): string {
  if (date === previousDay(today)) return he ? 'אתמול' : 'yesterday';
  const [, m, d] = date.split('-').map(Number);
  const [ty] = today.split('-').map(Number);
  const [y] = date.split('-').map(Number);
  const short = `${d}.${m}`;
  return y === ty ? short : `${short}.${String(y).slice(2)}`;
}

/** Mirrors YesterdayCard.isPastEvent. */
const isPastEvent = (t: Task): boolean => Boolean(t.fixedTime);

const task = (over: Partial<Task>): Task => ({
  id: 'x', text: 'x', category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 60, date: TODAY, status: 'pending', createdAt: 0,
  historicalDurations: [], ...over,
} as Task);

const WEDDING = task({
  id: 'wedding', text: 'החתונה של חני ודני', category: 'leisure',
  date: '2026-09-17', fixedTime: '19:00', isFixed: true,
});
const CV = task({ id: 'cv', text: 'לשלוח קורות חיים', date: '2026-09-20' });

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n      ${(e as Error).message}`); }
}

console.log('\nThe wedding that looked like today\n');

check('the wedding says 17.9, not nothing', () => {
  assert.equal(whenLabel(WEDDING.date, TODAY, true), '17.9');
  assert.equal(whenLabel(WEDDING.date, TODAY, false), '17.9');
});

check('yesterday is named, in both languages', () => {
  assert.equal(whenLabel(CV.date, TODAY, true), 'אתמול');
  assert.equal(whenLabel(CV.date, TODAY, false), 'yesterday');
});

check('a date in a previous year carries the year', () => {
  assert.equal(whenLabel('2025-12-30', TODAY, true), '30.12.25');
});

check('a wedding that happened is never offered a reschedule', () => {
  assert.equal(isPastEvent(WEDDING), true, 'a fixed-time event has happened');
});

check('unfinished work IS offered a reschedule', () => {
  assert.equal(isPastEvent(CV), false, 'no clock time means nothing was missed');
});

check('"reschedule all" would skip the wedding and keep the CV', () => {
  const bulk = [WEDDING, CV].filter((t) => !isPastEvent(t)).map((t) => t.id);
  assert.deepEqual(bulk, ['cv']);
});

check('a card of only past events offers no bulk reschedule at all', () => {
  assert.equal([WEDDING].some((t) => !isPastEvent(t)), false);
});

check('every row can state its date — none is left blank', () => {
  for (const t of [WEDDING, CV]) {
    for (const he of [true, false]) {
      const label = whenLabel(t.date, TODAY, he);
      assert.ok(label && label.trim().length > 0, `blank label for ${t.id}`);
    }
  }
});

console.log(
  failures === 0
    ? '\nAll good — an old task says how old it is.\n'
    : `\n${failures} failing.\n`,
);
process.exit(failures === 0 ? 0 : 1);
