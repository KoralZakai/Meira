/** Run: TZ=Asia/Jerusalem npx tsx tests/run-overlap-note.ts */
import { newOverlaps, overlapNotification } from '../src/utils/overlapNote';
let fails = 0;
const check = (l: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ' — ' + d : ''}`); };
const T = (id: string, text: string, cat: string, date: string, at: string, loc: [number, number]): any =>
  ({ id, text, category: cat, date, fixedTime: at, durationMinutes: 90, status: 'pending', location: { address: text, lat: loc[0], lng: loc[1] } });
const a = T('a', 'Lecture', 'class', '2026-10-28', '18:00', [32.0853, 34.7818]);
const b = T('b', 'Meetup', 'meeting', '2026-10-28', '18:00', [32.794, 34.9896]);
const g = T('g', 'Gym', 'gym', '2026-10-28', '20:00', [32.087, 34.783]);
const base = { today: '2026-10-26', now: '09:00', answered: {}, told: {} };
const f = newOverlaps([a, b, g], base);
check('finds the overlapping pair once', f.length === 1 && f[0].date === '2026-10-28');
check('already told → silent', newOverlaps([a, b, g], { ...base, told: { [f[0].key]: 1 } }).length === 0);
check('answered on Today → silent', newOverlaps([a, b, g], { ...base, answered: { '2026-10-28': { [f[0].key]: 'chose:a' } } }).length === 0);
check('beyond the 7-day horizon → silent', newOverlaps([{ ...a, date: '2026-11-20' }, { ...b, date: '2026-11-20' }], base).length === 0);
check('today and already begun → silent', newOverlaps([{ ...a, date: '2026-10-26', fixedTime: '08:00' }, { ...b, date: '2026-10-26', fixedTime: '08:00' }], base).length === 0);
check('completed task → no overlap', newOverlaps([{ ...a, status: 'complete' }, b], base).length === 0);
const n = overlapNotification(f, false);
check('note shows date, pick, reason, alternative', /Wed 28\.10/.test(n.title) && n.body.includes('"Lecture"') && n.body.includes('Gym') && n.body.includes('"Meetup"'), n.title + ' | ' + n.body);
const h = overlapNotification(f, true);
check('Hebrew filled', h.title.includes('28.10') && h.body.includes('מאירה ממליצה'));
process.exit(fails ? 1 : 0);
