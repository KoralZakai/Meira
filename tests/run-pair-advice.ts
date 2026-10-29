/** Run: npx tsx tests/run-pair-advice.ts */
import { adviseOverlap } from '../src/utils/pairAdvice';
let fails = 0;
const check = (l: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ' — ' + d : ''}`); };
const T = (id: string, text: string, cat: string, at: string, mins: number, loc?: [number, number], extra: any = {}): any =>
  ({ id, text, category: cat, fixedTime: at, durationMinutes: mins, status: 'pending', location: loc ? { address: text, lat: loc[0], lng: loc[1] } : undefined, ...extra });

// Tel Aviv lecture + Haifa meetup at 18:00; the gym (20:00) is next to the lecture.
const lecture = T('a', 'Lecture', 'class', '18:00', 90, [32.0853, 34.7818]);
const meetup = T('b', 'Founders meetup', 'meeting', '18:00', 90, [32.794, 34.9896], { attendees: ['x@y.z'] });
const gym = T('g', 'Gym', 'gym', '20:00', 60, [32.0870, 34.7830]);
const adv = adviseOverlap(lecture, meetup, [lecture, meetup, gym], { lat: 32.0853, lng: 34.7818 });
check('names the gym as next', adv.next?.title === 'Gym');
check('lecture leaves her next to the gym', adv.a.pros.some((r) => r.en.includes('Gym') && r.en.includes('nearby')));
check('meetup leaves her far from the gym', adv.b.cons.some((r) => r.en.includes('from Gym')));
check('lecture wins on proximity + distance', adv.pick === 'a', JSON.stringify([adv.a.score, adv.b.score]));

// An interview beats a coffee even when the coffee is closer.
const iv = T('i', 'Interview', 'interview', '10:00', 60, [32.79, 34.99], { priority: 'must' });
const cf = T('c', 'Coffee', 'general', '10:00', 30, [32.0853, 34.7818]);
const adv2 = adviseOverlap(iv, cf, [iv, cf], { lat: 32.0853, lng: 34.7818 });
check('interview beats nearby coffee', adv2.pick === 'a');
check('coffee side says it is hers to move', adv2.b.cons.length > 0);

// No locations anywhere: no crash, no invented distances, still answers.
const x = T('x', 'One', 'general', '09:00', 30), y = T('y', 'Two', 'general', '09:00', 30);
const adv3 = adviseOverlap(x, y, [x, y]);
check('no data → close call, no distance claims', adv3.closeCall && ![...adv3.a.pros, ...adv3.a.cons].some((r) => /km/.test(r.en)));
// (0,0) is unknown, not a place.
const z = T('z', 'Zero', 'general', '09:00', 30, [0, 0]);
check('0,0 is not a location', !adviseOverlap(z, y, [z, y]).a.pros.some((r) => /km/.test(r.en)));
check('both languages on every reason', [adv, adv2].every((v) => [...v.a.pros, ...v.a.cons, ...v.b.pros, ...v.b.cons].every((r) => r.en && r.he)));
process.exit(fails ? 1 : 0);
