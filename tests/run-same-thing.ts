/**
 * run-same-thing — "interview in C++", "interview in Kfar Vitkin", "interview
 * at uVision": one appointment, three rows, three different hours and places.
 *
 * The rule being pinned is WHEN TO ASK. Merging these silently would pick an
 * hour on her behalf, and a wrong hour on an interview is the worst thing this
 * app can do; leaving them alone means three alarms and three routes for one
 * event. So: ask, but only when it is genuinely one thing — same day, a
 * category that happens once, and a shared subject. Three "work" rows are three
 * real errands and must never be questioned.
 *
 * Run: npx tsx tests/run-same-thing.ts
 */
import assert from 'node:assert';
import { findSameThingGroups, looksLikeSameThing, mergedInto } from '../src/utils/likelySameTask';
import { Task } from '../src/types/index';

const DATE = '2026-09-01';

const task = (over: Partial<Task>): Task => ({
  id: Math.random().toString(36).slice(2),
  text: '', category: 'interview', priority: 'must', isFixed: true,
  durationMinutes: 60, date: DATE, status: 'pending', createdAt: 0,
  historicalDurations: [],
  ...over,
} as Task);

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

console.log('\nOne thing, worded three ways\n');

console.log('1. The reported case');
const cpp = task({ text: 'ראיון עבודה ב C++', fixedTime: '13:00' });
const vitkin = task({ text: 'ראיון עבודה בכפר ויתקין', fixedTime: '12:30', location: 'Kfar Vitkin' as any });
const uvision = task({ text: 'ראיון עבודה ב uVision', fixedTime: '13:00' });

check('all three are collected into one question', () => {
  const groups = findSameThingGroups([cpp, vitkin, uvision, task({
    text: 'אימון בחדר כושר', category: 'gym' as any, fixedTime: '18:00',
  })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tasks.length, 3);
});
check('the question names what they disagree about', () => {
  const [group] = findSameThingGroups([cpp, vitkin, uvision]);
  assert.ok(group.differs.includes('time'), 'different hours');
  assert.ok(group.differs.includes('place'), 'different places');
});
check('the best-known row is offered first', () => {
  const [group] = findSameThingGroups([cpp, vitkin, uvision]);
  assert.equal(group.tasks[0].id, vitkin.id, 'the one with a place and a time');
});

console.log('\n2. What must NOT be asked about');
check('three errands are three errands', () => {
  const errands = [
    task({ text: 'לשלוח מייל למרצה', category: 'work' as any }),
    task({ text: 'לשלוח מייל לרואה חשבון', category: 'work' as any }),
    task({ text: 'לשלוח מייל לביטוח', category: 'work' as any }),
  ];
  assert.equal(findSameThingGroups(errands).length, 0);
});
check('the same class on two different days is not a duplicate', () => {
  const a = task({ text: 'חוג יוגה', category: 'hobby_class' as any, fixedTime: '18:00' });
  const b = task({ text: 'חוג יוגה במרכז', category: 'hobby_class' as any, fixedTime: '19:00', date: '2026-09-08' });
  assert.equal(looksLikeSameThing(a, b), null);
});
check('two different categories are never the same thing', () => {
  const a = task({ text: 'ראיון עבודה', fixedTime: '13:00' });
  const b = task({ text: 'ראיון עבודה — להתכונן', category: 'course' as any, fixedTime: '09:00' });
  assert.equal(looksLikeSameThing(a, b), null);
});
check('a completed task is left alone', () => {
  const done = task({ text: 'ראיון עבודה בחיפה', fixedTime: '12:00', status: 'complete' as any });
  assert.equal(looksLikeSameThing(cpp, done), null);
});
check('identical rows that agree on everything are left to the silent merger', () => {
  const a = task({ text: 'ראיון עבודה ב uVision', fixedTime: '13:00' });
  const b = task({ text: 'ראיון עבודה ב uVision', fixedTime: '13:00' });
  assert.equal(looksLikeSameThing(a, b), null, 'nothing to ask — nothing disagrees');
});

console.log('\n3. Keeping one');
check("the chosen row's own facts are never overwritten", () => {
  const patch = mergedInto(vitkin, [cpp, uvision]);
  assert.equal(patch.fixedTime, undefined, 'it already has an hour — keep it');
  assert.equal(patch.location, undefined, 'and a place');
});
check('…but it gains what it did not know', () => {
  const bare = task({ text: 'ראיון עבודה', fixedTime: undefined, isFixed: false });
  const patch = mergedInto(bare, [vitkin]);
  assert.equal(patch.fixedTime, '12:30');
  assert.equal(patch.location, 'Kfar Vitkin');
});
check('both wordings survive — each says something the other does not', () => {
  const patch = mergedInto(cpp, [vitkin]);
  assert.ok(String(patch.text).includes('C++'));
  assert.ok(String(patch.text).includes('ויתקין'));
});

console.log(`\n${checks} checks${process.exitCode ? ' — FAILURES' : ' — all good'}\n`);
