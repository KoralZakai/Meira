/**
 * run-late-alternative — late on the planned way: the faster way from NOW, said clearly (21.10, Koral).
 * Run:  npx tsx tests/run-late-alternative.ts
 */
import { bestAlternative, alternativeLine } from '../src/utils/liveRoutePlan';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };
const P = (leave: string, arrive: string, mins: number) => ({ leaveHomeAt: leave, arriveAt: arrive, totalDurationMinutes: mins });

const alt = bestAlternative({ arriveAt: '10:30' }, [
  { mode: 'train', plan: P('09:50', '10:40', 50) },
  { mode: 'car', plan: P('09:40', '10:16', 36) },
  { mode: 'bike', plan: P('09:40', '11:01', 81) },
]);
check('the way that ARRIVES first wins', alt?.mode === 'car' && alt.gain === 14, JSON.stringify(alt));
check('a way that is not faster is not offered', bestAlternative({ arriveAt: '10:30' }, [{ mode: 'train', plan: P('09:50', '10:40', 50) }]) === null);
check('a two-minute gain is not worth a new decision', bestAlternative({ arriveAt: '10:30' }, [{ mode: 'car', plan: P('09:40', '10:28', 48) }]) === null);
check('no options: null, not an invented answer', bestAlternative({ arriveAt: '10:30' }, []) === null);
check('an unreadable arrival: null', bestAlternative({ arriveAt: '??' }, [{ mode: 'car', plan: P('09:40', '10:16', 36) }]) === null);
const he = alternativeLine(alt!, true); const en = alternativeLine(alt!, false);
check('Hebrew names the vehicle, the arrival, how much sooner and the source', /רכב/.test(he) && /10:16/.test(he) && /14/.test(he) && /גוגל/.test(he), he);
check('English says the same', /car/.test(en) && /10:16/.test(en) && /14 min sooner/.test(en) && /Google/.test(en), en);
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
