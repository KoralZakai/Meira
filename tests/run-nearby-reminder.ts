/**
 * run-nearby-reminder — a mocked day at the Intel interview (29.10, submission):
 * an errand 200 m from the interview is nudged when she is THERE; the errand
 * across town is not; a nudge is not repeated within 90 min.
 *   npx tsx tests/run-nearby-reminder.ts
 */
import { nearbyDue, nearbyMessage } from '../src/utils/nearbyDue';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

// Intel Haifa, MATAM (approx.) — where the mocked interview is.
const INTEL = { lat: 32.7889, lng: 34.9584 };
const base = { status: 'pending', date: '2026-11-01', createdAt: 0, historicalDurations: [] } as any;
const interview = { ...base, id: 'i', text: 'ראיון — Intel, System Validation (מגייסת: דנה לוי)', fixedTime: '10:00',
  location: 'Intel, MATAM Haifa', locationLat: INTEL.lat, locationLng: INTEL.lng, isFixed: true };
const errand = { ...base, id: 'e', text: 'לאסוף חבילה מהדואר', location: 'דואר מת"ם',
  locationLat: 32.7905, locationLng: 34.9595 };       // ~200 m from Intel
const far = { ...base, id: 'f', text: 'להחזיר ספר לספרייה', location: 'ספרייה, תל אביב',
  locationLat: 32.0853, locationLng: 34.7818 };

const now = Date.parse('2026-11-01T11:05:00+02:00');      // just out of the interview
const due = nearbyDue([interview, errand, far], INTEL, now);
ok(due.some((d) => d.task.id === 'e'), 'the errand 200 m from the interview is nudged');
ok(!due.some((d) => d.task.id === 'f'), 'the errand in Tel Aviv is not');
const msg = nearbyMessage(errand);
ok(msg.body.includes('לאסוף חבילה מהדואר') && msg.title.includes('קרובה'), 'said in Hebrew, naming the task');
ok(nearbyDue([{ ...errand, lastNearbyReminderAt: now - 30 * 60000 }], INTEL, now).length === 0, 'not again within 90 minutes');
ok(nearbyDue([{ ...errand, status: 'complete' }], INTEL, now).length === 0, 'a done errand is never nudged');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
