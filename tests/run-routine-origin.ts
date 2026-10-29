/**
 * run-routine-origin — "home first, or straight to the routine?" (21.10, Koral).
 * Run:  npx tsx tests/run-routine-origin.ts
 */
import { decideRoutineOrigin, goesStraightToRoutine, routineOriginKey } from '../src/utils/routineOrigin';
import { applyRoutineOrigin, detectRoutineOrigin, sheetText, questionOf } from '../src/questions/kinds/routineOrigin';
import type { Task } from '../src/types/index';
import type { RoutineRow } from '../src/utils/routineRows';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

const HOME = 'מורדי הגטאות 23, תל אביב-יפו';
const DATE = '2026-10-22';
const T = (over: Partial<Task> & { id: string }): Task => ({
  text: 'פגישה', category: 'meeting', priority: 'have_to', isFixed: true, fixedTime: '14:30', durationMinutes: 45,
  date: DATE, status: 'pending', createdAt: 1, historicalDurations: [],
  location: { address: 'יהודה הלוי 21 תל אביב', lat: 32, lng: 34, confirmed: true, travelMinutes: 26, transportType: 'bus' },
  ...over,
} as Task);
const ROW = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  routine: {} as any, start: '19:00', end: '20:00', title: 'יוגה', address: 'יגאל אלון 76, תל אביב', key: 'יוגה|19:00', ...over,
});

(async () => {
  const meeting = T({ id: 'm' });
  const ask = decideRoutineOrigin({ date: DATE, tasks: [meeting], rows: [ROW()], home: HOME, answers: {} });
  check('a routine with a place after the last trip: Meira asks', ask.ask === true);
  const data = ask.ask ? ask.data : null;
  check('the question names the trip, the routine and its hour', data?.fromTitle === 'פגישה' && data?.routineTitle === 'יוגה' && data?.routineStart === '19:00', JSON.stringify(data));
  check('its key is per day, trip and routine', Boolean(data) && questionOf(data!).key === routineOriginKey(DATE, 'm', 'יוגה|19:00'));

  check('a routine BEFORE the trip ends: nothing to ask',
    decideRoutineOrigin({ date: DATE, tasks: [meeting], rows: [ROW({ start: '14:00' })], home: HOME, answers: {} }).ask === false);
  check('a routine with no place: nothing to ask (no destination to go straight to)',
    decideRoutineOrigin({ date: DATE, tasks: [meeting], rows: [ROW({ address: undefined })], home: HOME, answers: {} }).ask === false);
  const none = decideRoutineOrigin({ date: DATE, tasks: [], rows: [ROW()], home: HOME, answers: {} });
  check('no trip away that day: no question, and it says why', none.ask === false && none.reason === 'no_trip');
  const key = routineOriginKey(DATE, 'm', 'יוגה|19:00');
  const done = decideRoutineOrigin({ date: DATE, tasks: [meeting], rows: [ROW()], home: HOME, answers: { [key]: 'home' } });
  check('answered: not asked again, and it says why', done.ask === false && done.reason === 'answered');

  check('"straight there" is read back for the way-home pass', goesStraightToRoutine([meeting], [ROW()], DATE, HOME, { [key]: 'direct' }));
  check('"home first" keeps the way home', !goesStraightToRoutine([meeting], [ROW()], DATE, HOME, { [key]: 'home' }));
  check('no answer keeps the way home', !goesStraightToRoutine([meeting], [ROW()], DATE, HOME, {}));

  // the words, both languages
  const w = sheetText(data!);
  check('both languages have every string', Object.values(w).every((x) => x.en && x.he));
  check('Hebrew asks her the way she put it: are you going?', /הולכת\?/.test(w.ask.he) && /יוגה/.test(w.ask.he) && /19:00/.test(w.ask.he));
  check('three answers: straight there · home first · not today', /ישר/.test(w.direct.he) && /קודם הביתה/.test(w.home.he) && /לא היום/.test(w.skip.he));

  // detect: derived from today + tomorrow, with injected deps
  const store: Record<string, any> = {};
  const deps = {
    now: () => new Date(2026, 9, 22, 8, 0),
    home: async () => HOME,
    tasksFor: async (d: string) => (d === DATE ? [meeting] : []),
    rowsFor: async (d: string) => (d === DATE ? [ROW()] : []),
    answers: async () => ({ ...store }),
  };
  const qs = await detectRoutineOrigin(deps);
  check('detect finds today\'s question', qs.length === 1 && qs[0].kind === 'routineOrigin');
  const bad = await detectRoutineOrigin({ ...deps, answers: async () => { throw new Error('boom'); } });
  check('unreadable answers: not asked (could undo her answer) — a warning, not a silence', bad.length === 0);
  const noRows = await detectRoutineOrigin({ ...deps, rowsFor: async () => { throw new Error('boom'); } });
  check('unreadable routines for a day: no question for it, the other day still read', noRows.length === 0);

  // apply
  const applyDeps = {
    save: async (k: string, c: any) => { store[k] = c; },
    read: async () => ({ ...store }),
    skipToday: async (date: string, key: string) => { skips.push(`${date}|${key}`); },
    replan: async () => { replans += 1; },
  };
  const skips: string[] = [];
  let replans = 0;
  const r = await applyRoutineOrigin(qs[0], { choice: 'direct' }, applyDeps);
  check('answering saves, re-plans the way home and says what changed', r.result.ok && store[qs[0].key] === 'direct' && replans === 1 && /ישר/.test(r.result.effect!.he));
  const skipped = await applyRoutineOrigin(qs[0], { choice: 'skip' }, applyDeps);
  check('"not today" waves the routine off for that date and says so', skipped.result.ok && skips.length === 1 && skips[0].startsWith(DATE) && /לא להיום/.test(skipped.result.effect!.he));
  const asked = await detectRoutineOrigin(deps);
  check('once answered it is not asked again', asked.length === 0);
  const lost = await applyRoutineOrigin(qs[0], { choice: 'home' }, { ...applyDeps, save: async () => { /* did not land */ } });
  check('a write that did not stick is not claimed', !lost.result.ok && lost.result.reason === 'local');
  const wrongKind = await applyRoutineOrigin({ ...qs[0], kind: 'place' } as any, { choice: 'home' }, applyDeps);
  check('an answer for another kind is refused', !wrongKind.result.ok);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
