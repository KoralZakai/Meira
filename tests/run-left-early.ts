/**
 * leftEarly — 8.10, Koral: מילואים in Ramla 09:00–18:00, home in Tel Aviv at
 * 17:30, and Today still drew the whole day at the base.
 */
import { freedTimeLine, leftEarly, leftEarlyLine } from '../src/utils/leftEarly';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const HOME = { lat: 32.0853, lng: 34.7818 };          // Tel Aviv
const RAMLA = { lat: 31.9293, lng: 34.8656 };          // ~19 km away
const TLV_ELSEWHERE = { lat: 32.0700, lng: 34.7900 };  // Tel Aviv, not home
const MILUIM = {
  id: 'm', status: 'pending', fixedTime: '09:00', durationMinutes: 540, verifiedArrival: true,
  location: { ...RAMLA, travelMinutes: 43, displayName: 'פיקוד העורף ברמלה' },
};

{
  const [v] = leftEarly([MILUIM], HOME, HOME, '17:30');
  ok(Boolean(v), 'home at 17:30 during 09:00–18:00 in Ramla: she left');
  ok(v?.endAt === '16:47' && v?.durationMinutes === 467, 'ended ≈ now − the 43-min trip back (16:47)');
  ok(v?.atHome === true && v?.wasThere === true, 'at home, and she had been there');
  ok(leftEarlyLine(v!, 'מילואים', true) === '🏠 חזרת הביתה מוקדם — מילואים הסתיים בערך ב-16:47, קיצרתי אותו',
    'says so, in Hebrew');
}
{
  const [v] = leftEarly([MILUIM], TLV_ELSEWHERE, HOME, '16:30');
  ok(Boolean(v) && v.atHome === false, 'reaching Tel Aviv is enough — not only home (her words)');
}
{
  ok(leftEarly([MILUIM], { lat: 31.9300, lng: 34.8700 }, HOME, '12:00').length === 0, 'still at the base (≈400 m): nothing');
  ok(leftEarly([MILUIM], { lat: 31.9500, lng: 34.8656 }, HOME, '12:00').length === 0, '2.3 km out (lunch, a big base): nothing');
  ok(leftEarly([MILUIM], HOME, HOME, '08:30').length === 0, 'before the start: not "left"');
  ok(leftEarly([MILUIM], HOME, HOME, '18:30').length === 0, 'after the end: it simply ended');
  ok(leftEarly([{ ...MILUIM, leftEarlyHandled: true }], HOME, HOME, '17:30').length === 0, 'handled once, never again');
  ok(leftEarly([{ ...MILUIM, status: 'complete' }], HOME, HOME, '17:30').length === 0, 'a done task is left alone');
  ok(leftEarly([MILUIM], null, HOME, '17:30').length === 0, 'no fix: say nothing');
}
{
  const [v] = leftEarly([{ ...MILUIM, verifiedArrival: false }], HOME, HOME, '17:30');
  ok(v?.wasThere === false, 'never seen there: ASK, do not shorten');
  // 13.10, Koral: never seen there means she did not GO — 'ended early?' was the
  // wrong question, asked again and again about an interview she never reached.
  ok(leftEarlyLine(v!, 'מילואים', true) === '❓ לא הגעת למילואים — בוטל? צריך לקבוע מועד חדש?', 'the question: cancelled, or a new time');
}
{
  const noTrip = { ...MILUIM, location: { ...RAMLA } };
  const [v] = leftEarly([noTrip], HOME, HOME, '17:30');
  ok(Boolean(v) && v.endAt > '16:00' && v.endAt < '17:30', 'no stored trip time: estimated from the distance');
  const [w] = leftEarly([MILUIM], HOME, HOME, '09:20');
  ok(w?.endAt === '09:00' && w?.durationMinutes === 0, 'never before the start');
}

{
  ok(freedTimeLine('18:00', 'למידה', true, true) === 'וואו, חזרת מוקדם! יש לך עד 18:00 — זמן טוב ללמידה.', 'the conclusion, spoken');
  ok(freedTimeLine('18:00', undefined, false, false) === "You finished early! You're free until 18:00.", 'no idea: still says the time is free');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
