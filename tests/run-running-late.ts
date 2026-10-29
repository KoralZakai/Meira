/**
 * 13.10, Koral: "if you see I haven't left — ask me: you're late, are you
 * still going? reschedule? cancel? keep options!" The missed-departure re-plan
 * said "Times updated · arrive 13:42" for a 13:00 interview, and nothing else.
 */
import { followUpTitle, isFromCalendar, lateBy, runningLateText } from '../src/utils/liveRoutePlan';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}  ${detail}`); }
};

ok(lateBy('13:00', '13:42') === 42, '13:42 for 13:00 is 42 minutes late');
ok(lateBy('13:00', '12:37') === 0, 'early is not late');
ok(lateBy(undefined, '13:42') === 0 && lateBy('13:00', undefined) === 0, 'unknown is not late');
const q = runningLateText('ראיון ברפאל', '13:42', 42, true);
ok(q.title === '⏰ את מאחרת לראיון ברפאל', 'says she is late, by name', q.title);
ok(/13:42/.test(q.body) && /42 דק׳ איחור/.test(q.body) && /עדיין הולכת\? לדחות\? לבטל\?/.test(q.body), 'and asks the three questions', q.body);
ok(isFromCalendar('gcal-abc') && isFromCalendar('ocal-1') && !isFromCalendar('1791870349713-ebuwson3'),
  "a calendar meeting is not hers to move — Meira says where it is moved");

// An interview cannot be late: the question is what happened (13.10).
const must = runningLateText('ראיון ראשון - חיפה', '13:42', 42, true, true);
ok(must.title === '⏰ לא תגיעי בזמן לראיון ראשון - חיפה', 'an interview: "you won\'t make it on time"', must.title);
ok(/אי אפשר לאחר/.test(must.body) && /מה קרה\? בוטל\? הוזז — למתי\?/.test(must.body), 'and asks what happened — cancelled? moved, to when?', must.body);
ok(!/עדיין הולכת/.test(must.body), 'not "still going?" — late is not an option');
ok(followUpTitle('ראיון ראשון - חיפה', true) === 'לקבוע מועד חדש: ראיון ראשון - חיפה', 'no new time yet → an open task that says what to do');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
