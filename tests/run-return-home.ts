/**
 * run-return-home — after the day's last trip she goes home (21.10, Koral).
 * Run:  npx tsx tests/run-return-home.ts
 */
import { returnHomeFor, returnHomeWhy, homeReturnLine, returnHomeId, isReturnHomeTask } from '../src/utils/returnHome';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

const HOME = 'מורדי הגטאות 23, תל אביב-יפו';
const T = (over: Partial<Task> & { id: string }): Task => ({
  text: 'x', category: 'meeting', priority: 'have_to', isFixed: true, fixedTime: '10:30', durationMinutes: 60,
  date: '2026-10-22', status: 'pending', createdAt: 1, historicalDurations: [],
  location: { address: 'Asaf ha-Rofe Street, Tel Aviv-Yafo', lat: 32, lng: 34, confirmed: true, travelMinutes: 35, transportType: 'bus' },
  ...over,
} as Task);

const r = returnHomeFor([T({ id: 'a', text: 'תור לרופא' })], '2026-10-22', HOME);
check('the last trip gets a way home', Boolean(r));
check('she leaves when it ends, home about as long after as the way there took', r?.leaveAt === '11:30' && r?.arriveAt === '12:05', JSON.stringify(r));
check('said as an estimate, both languages', /~12:05/.test(homeReturnLine(r!, true)) && /~12:05/.test(homeReturnLine(r!, false)));
check('something later in the day: no row yet (she may go elsewhere)',
  returnHomeFor([T({ id: 'a' }), T({ id: 'b', fixedTime: '15:00', location: { address: 'הרצל 5, חיפה', lat: 1, lng: 1, confirmed: true, travelMinutes: 20 } as any })], '2026-10-22', HOME)?.fromId === 'b');
check('the last task at home: she is already home',
  returnHomeFor([T({ id: 'a' }), T({ id: 'h', fixedTime: '18:00', location: { address: HOME, lat: 1, lng: 1, confirmed: true } as any })], '2026-10-22', HOME) === null);
check('a study block with no place after the last trip: she still has to get home first',
  returnHomeFor([T({ id: 'a', fixedTime: '14:30' }), T({ id: 's', fixedTime: '20:00', location: undefined, category: 'course' } as any)], '2026-10-22', HOME)?.fromId === 'a');
check('a task at home later: the travel chain plans that trip, no second one',
  returnHomeFor([T({ id: 'a' }), T({ id: 'h', fixedTime: '18:00', location: { address: HOME, lat: 1, lng: 1, confirmed: true } as any })], '2026-10-22', HOME) === null);
check('a video call: nothing to travel back from', returnHomeFor([T({ id: 'z', category: 'zoom', location: undefined, meetingUrl: 'https://zoom.us/j/1' } as any)], '2026-10-22', HOME) === null);
check('no way there on record: no invented number', returnHomeFor([T({ id: 'n', location: { address: 'x, חיפה', lat: 1, lng: 1, confirmed: true } as any })], '2026-10-22', HOME) === null);
check('a finished task is not left from', returnHomeFor([T({ id: 'd', status: 'complete' })], '2026-10-22', HOME) === null);

check('the generated way-home task is never the trip it leaves from',
  returnHomeFor([T({ id: 'a' }), T({ id: returnHomeId('a'), fixedTime: '11:30', location: undefined } as any)], '2026-10-22', HOME)?.fromId === 'a'
  && isReturnHomeTask({ id: returnHomeId('a') }) && !isReturnHomeTask({ id: 'a' }));
check('an event added after it makes THAT the last trip',
  returnHomeFor([T({ id: 'a' }), T({ id: returnHomeId('a'), fixedTime: '11:30', location: undefined } as any),
    T({ id: 'c', fixedTime: '16:00', location: { address: 'ויצמן 5, תל אביב', lat: 1, lng: 1, confirmed: true, travelMinutes: 12 } as any })], '2026-10-22', HOME)?.fromId === 'c');

// 21.10 — every "no way home" says why (rule 1), and a trip ending at midnight leaves at 23:59, not 00:00.
const noDay = returnHomeWhy([], '2026-10-22', HOME);
check('a day with no trip: said so', 'why' in noDay && noDay.why === 'no_trip');
const laterPlace = returnHomeWhy([T({ id: 'a' }), T({ id: 'b', fixedTime: '16:00', location: { address: HOME, lat: 1, lng: 1, confirmed: true } as any })], '2026-10-22', HOME);
check('a task at home follows (the chain plans that trip): which one, by id', 'why' in laterPlace && laterPlace.why === 'later_has_place' && 'byId' in laterPlace && laterPlace.byId === 'b');
const noMinutes = returnHomeWhy([T({ id: 'a', location: { address: 'x 1, תל אביב', lat: 1, lng: 1, confirmed: true } as any })], '2026-10-22', HOME);
check('no way there on record: said so, never an invented number', 'why' in noMinutes && noMinutes.why === 'no_minutes');
const late = returnHomeFor([T({ id: 'z', fixedTime: '21:00', durationMinutes: 180 })], '2026-10-22', HOME);
check('a trip that ends at midnight leaves at 23:59, not at 00:00', late?.leaveAt === '23:59', JSON.stringify(late));

// 28.10 (Koral): she cancelled / postponed the trip — no way home after it.
check('a cancelled or postponed trip owes no way home', returnHomeFor([T({ id: 'x', status: 'missed' } as any)], '2026-10-22', HOME) === null);

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
