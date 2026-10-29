/**
 * run-geofence-pick — which open errands get a fence, and when walking into one may knock.
 *
 * Run:  npx tsx tests/run-geofence-pick.ts
 */
import {
  MAX_FENCES, NUDGE_COOLDOWN_MS, allFences, asPlaceReminder, nudgeText, nudgeVerdict, pickFences, reminderText,
} from '../src/utils/geofencePick';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const TODAY = '2026-10-28';
const at = { lat: 32.07, lng: 34.78, address: 'דואר דיזנגוף', displayName: 'הדואר', confirmed: true };
const task = (o: Partial<Task>): Task => ({
  id: 'e1', text: 'לשלוח חבילה', category: 'general', priority: 'need_to', isFixed: false, durationMinutes: 15,
  date: TODAY, status: 'pending', createdAt: 0, historicalDurations: [], location: at, ...o,
} as Task);

const errand = task({});
check('an open errand with a place gets a fence', pickFences([errand], TODAY).length === 1);
const f = pickFences([errand], TODAY)[0];
check('…at its place, entry only', f.latitude === 32.07 && f.longitude === 34.78 && f.notifyOnEnter && !f.notifyOnExit);
check('a fixed-hour appointment does not', pickFences([task({ fixedTime: '16:00' })], TODAY).length === 0);
check('isFixed does not', pickFences([task({ isFixed: true })], TODAY).length === 0);
check('done does not', pickFences([task({ status: 'complete' })], TODAY).length === 0);
check('Null Island is not a place', pickFences([task({ location: { ...at, lat: 0, lng: 0 } })], TODAY).length === 0);
check('no place, no fence', pickFences([task({ location: undefined })], TODAY).length === 0);
check('an online call does not', pickFences([task({ category: 'zoom', location: 'Zoom' })], TODAY).length === 0);
check('legacy locationLat/Lng counts', pickFences([task({ location: 'בית מרקחת', locationLat: 32.1, locationLng: 34.8 } as any)], TODAY).length === 1);
check('overdue errand still counts', pickFences([task({ date: '2026-10-20' })], TODAY).length === 1);
check('a month away does not take a fence', pickFences([task({ date: '2026-11-28' })], TODAY).length === 0);

const many = Array.from({ length: 150 }, (_, i) => task({ id: `t${String(i).padStart(3, '0')}`, date: i < 10 ? '2026-10-29' : TODAY }));
const picked = pickFences(many, TODAY);
check(`never more than ${MAX_FENCES} (Android caps at 100)`, picked.length === MAX_FENCES, String(picked.length));
check('…the soonest kept', !picked.some((p) => Number(p.identifier.slice(1)) < 10));

const noon = new Date(2026, 9, 28, 12, 0);
check('daytime, first time → knock', nudgeVerdict(errand, undefined, noon, TODAY) === 'ok');
check('night → quiet', nudgeVerdict(errand, undefined, new Date(2026, 9, 28, 23, 10), TODAY) === 'night');
check('early morning → quiet', nudgeVerdict(errand, undefined, new Date(2026, 9, 28, 6, 30), TODAY) === 'night');
check('knocked an hour ago → cooldown', nudgeVerdict(errand, noon.getTime() - 3600_000, noon, TODAY) === 'cooldown');
check('…after the cooldown → knock', nudgeVerdict(errand, noon.getTime() - NUDGE_COOLDOWN_MS - 1, noon, TODAY) === 'ok');
check('deleted since the fence was set → gone', nudgeVerdict(undefined, undefined, noon, TODAY) === 'gone');
check('done since → not an errand any more', nudgeVerdict(task({ status: 'complete' }), undefined, noon, TODAY) === 'not_errand');

const he = nudgeText(errand, true);
check('Hebrew names the place and the task', he.title.includes('הדואר') && he.body.includes('לשלוח חבילה'), `${he.title} / ${he.body}`);
const en = nudgeText(task({ location: undefined, locationLat: 32.1, locationLng: 34.8 } as any), false);
check('no place name → still a sentence', en.title.includes("task's place"), en.title);

// Place reminders (28.10): "when I get to work…" (enter) / "when I leave home…" (exit).
const arrive = asPlaceReminder({ id: 'a1', text: 'להתקשר לדני', trigger: 'arrive', label: 'העבודה', lat: 32.1, lng: 34.8 })!;
const leave = asPlaceReminder({ id: 'l1', text: 'לקחת מטען', trigger: 'leave', label: 'הבית', lat: 32.07, lng: 34.78 })!;
check('a server reminder is accepted', !!arrive && !!leave);
check('junk is refused', !asPlaceReminder({ id: 'x', text: 'y', trigger: 'soon', lat: 1, lng: 1 })
  && !asPlaceReminder({ id: 'x', text: 'y', trigger: 'arrive', lat: 0, lng: 0 }));
const set = allFences([arrive, leave], many, TODAY);
check('reminders come first, the cap still holds', set[0].identifier === 'pr:a1' && set.length === MAX_FENCES, String(set.length));
check('arrive → entry, leave → exit', set[0].notifyOnEnter && !set[0].notifyOnExit && set[1].notifyOnExit && !set[1].notifyOnEnter);
check('leave reminder says she left, in Hebrew', reminderText(leave, true).title.includes('יצאת מהבית') && reminderText(leave, true).body.includes('לקחת מטען'));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
