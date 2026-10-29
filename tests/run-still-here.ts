/**
 * run-still-here — the closed-app "you haven't left" question is decided on the phone, from clock + distance.
 *
 * Run:  npx tsx tests/run-still-here.ts
 */
import { stillHereAlert } from '../src/utils/stillHere';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const HOME = { lat: 32.0700, lng: 34.7800 };
const VENUE = { lat: 32.1850, lng: 34.8700 };   // Ra'anana, ~15 km
const trip = {
  id: 't', text: 'ראיון', category: 'interview', priority: 'must', isFixed: true, fixedTime: '14:00',
  durationMinutes: 60, date: '2026-10-28', status: 'pending', createdAt: 0, historicalDurations: [],
  location: { address: 'רעננה', lat: VENUE.lat, lng: VENUE.lng, confirmed: true, leaveHomeBy: '13:10' },
} as unknown as Task;
const at = (h: number, m: number) => new Date(2026, 9, 28, h, m);

const late = stillHereAlert(trip, HOME, HOME, at(13, 20), true);
check('leave time passed, still home → asked', !!late && late.title.includes('עוד לא יצאת') && late.body.includes('13:10'), JSON.stringify(late));
check('before the leave time → nothing', stillHereAlert(trip, HOME, HOME, at(12, 50), true) === null);
check('already there → nothing', stillHereAlert(trip, VENUE, HOME, at(13, 50), true) === null);
check('left home (moved off the origin) → nothing; that needs a route, app open', stillHereAlert(trip, { lat: 32.12, lng: 34.82 }, HOME, at(13, 20), true) === null);
check('no fix → nothing', stillHereAlert(trip, null, HOME, at(13, 20), true) === null);
check('never at night', stillHereAlert({ ...trip, fixedTime: '23:30', location: { ...(trip as any).location, leaveHomeBy: '22:40' } } as any, HOME, HOME, at(22, 50), true) === null);
check('English', (stillHereAlert(trip, HOME, HOME, at(13, 20), false)?.title ?? '').includes("haven't left"));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
