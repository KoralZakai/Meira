/**
 * run-schedule-question — asking Lumi ABOUT the diary instead of telling her
 * to change it.
 *
 * Guards two failure shapes:
 *  - a question silently becoming a task ("what do I have to do on Tuesday"
 *    saved as a to-do), and
 *  - Hebrew dates falling through, which they did for a long time for a dull
 *    reason: JavaScript word boundaries are ASCII, so /\bמחר\b/ never matches
 *    and "מה יש לי מחר" answered about today.
 *
 * Pure parser only — no storage, no network.
 *
 * Run: npx tsx tests/run-schedule-question.ts
 */
import assert from 'node:assert';
import {
  parseScheduleQuestion, resolveQuestionDate, parseDurationMinutes,
} from '../src/utils/scheduleQuestion';

const TODAY = '2026-08-31';   // a Monday

let checks = 0;
const check = (label: string, fn: () => void) => {
  checks += 1;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nDiary questions\n');

console.log('1. Dates');
check('1/9 is the 1st of September, not September 1st US-style', () => {
  assert.equal(resolveQuestionDate('on 1/9', TODAY), '2026-09-01');
});
check('a dotted date works the same', () => {
  assert.equal(resolveQuestionDate('ב-1.9', TODAY), '2026-09-01');
});
check('a day/month already gone means NEXT year', () => {
  assert.equal(resolveQuestionDate('on 2/1', TODAY), '2027-01-02');
});
check('English weekday → the next one', () => {
  assert.equal(resolveQuestionDate('on Thursday', TODAY), '2026-09-03');
});
check('Hebrew weekday → the next one', () => {
  assert.equal(resolveQuestionDate('ביום שלישי', TODAY), '2026-09-01');
});
check('Hebrew "מחר" resolves (ASCII \\b never matches Hebrew)', () => {
  assert.equal(resolveQuestionDate('מה יש לי מחר', TODAY), '2026-09-01');
});
check('מחרתיים is two days, not one', () => {
  assert.equal(resolveQuestionDate('מחרתיים', TODAY), '2026-09-02');
});

console.log('\n2. Durations');
check('"2 hour" → 120', () => assert.equal(parseDurationMinutes('a 2 hour meeting'), 120));
check('"90 min" → 90', () => assert.equal(parseDurationMinutes('90 min workout'), 90));
check('שעתיים → 120', () => assert.equal(parseDurationMinutes('פגישה של שעתיים'), 120));
check('שעה וחצי → 90', () => assert.equal(parseDurationMinutes('שעה וחצי'), 90));
check('bare שעה → 60', () => assert.equal(parseDurationMinutes('פגישה של שעה'), 60));

console.log('\n3. "What do I have on …?"');
check('English, with an explicit date', () => {
  const q = parseScheduleQuestion('What do I have to do on Tuesday 1/9 ?', TODAY);
  assert.equal(q?.kind, 'day_agenda');
  assert.equal((q as any).date, '2026-09-01');
});
check('Hebrew', () => {
  const q = parseScheduleQuestion('מה אני צריכה לעשות ביום שלישי 1/9?', TODAY);
  assert.equal(q?.kind, 'day_agenda');
  assert.equal((q as any).date, '2026-09-01');
});
check('no date at all means today', () => {
  const q = parseScheduleQuestion("What's on?", TODAY);
  assert.equal((q as any)?.date, TODAY);
});

console.log('\n4. "Can I fit …?"');
check('English: duration + place + date + hour', () => {
  const q: any = parseScheduleQuestion('Can I have a 2 hour meeting in Haifa on 2/9 at 14:00?', TODAY);
  assert.equal(q.kind, 'feasibility');
  assert.equal(q.date, '2026-09-02');
  assert.equal(q.minutes, 120);
  assert.equal(q.place, 'Haifa');
  assert.equal(q.startTime, '14:00');
});
check('Hebrew: שעתיים בחיפה ב-2.9 בשעה 14:00', () => {
  const q: any = parseScheduleQuestion('אפשר פגישה של שעתיים בחיפה ב-2.9 בשעה 14:00?', TODAY);
  assert.equal(q.kind, 'feasibility');
  assert.equal(q.date, '2026-09-02');
  assert.equal(q.minutes, 120);
  assert.equal(q.place, 'חיפה');
  assert.equal(q.startTime, '14:00');
});
check('Hebrew multi-word place survives ("תל אביב")', () => {
  const q: any = parseScheduleQuestion('אפשר לקבוע פגישה של שעה בתל אביב ביום רביעי ב-16:00?', TODAY);
  assert.equal(q.place, 'תל אביב');
  assert.equal(q.date, '2026-09-02');
});
check('a window ("between 10:00 and 14:00") keeps both ends', () => {
  const q: any = parseScheduleQuestion('יש לי זמן לשעתיים בחיפה מחר בין 10:00 ל-14:00?', TODAY);
  assert.equal(q.startTime, '10:00');
  assert.equal(q.endTime, '14:00');
});

console.log('\n5. Not questions');
check('an English command stays a command', () => {
  assert.equal(parseScheduleQuestion('add gym tomorrow at 18:00', TODAY), null);
});
check('a Hebrew command stays a command', () => {
  assert.equal(parseScheduleQuestion('קניות בסופר מחר', TODAY), null);
});
check('small talk is not a feasibility audit', () => {
  assert.equal(parseScheduleQuestion('can I have a coffee?', TODAY), null);
});

console.log(`\n${checks} checks${process.exitCode ? ' — FAILURES' : ' — all good'}\n`);
