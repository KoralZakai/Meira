/**
 * run-migration — the cleanup must never eat a real task.
 *
 * This migration runs once, unattended, on a phone nobody can inspect
 * afterwards. The risk is not that it under-cleans — a visible duplicate can
 * be deleted by hand — it is that it merges two genuinely different tasks and
 * one silently disappears. Every check here is aimed at that.
 *
 * Run:  npx tsx tests/run-migration.ts
 */
import { mergeByMeaning } from '../src/utils/taskMerge';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const t = (id: string, text: string, extra: Partial<Task> = {}): Task => ({
  id,
  text,
  status: 'pending',
  isFixed: false,
  durationMinutes: 30,
  date: '2026-08-21',
  createdAt: 0,
  historicalDurations: [],
  ...extra,
} as Task);

function main() {
  console.log('\nStore migration\n');

  console.log('1. Real duplicates collapse');
  let r = mergeByMeaning([t('a', 'יוגה'), t('b', 'יוגה')]);
  check('identical text on the same day → one', r.kept.length === 1, `${r.kept.length}`);

  r = mergeByMeaning([t('a', 'יוגה  '), t('b', 'Yoga'), t('c', 'יוגה!')]);
  check('punctuation and spacing do not create twins', r.kept.length === 2, `${r.kept.length}`);

  console.log('\n2. The richest row survives');
  const plain = t('plain', 'ראיון עבודה');
  const rich = t('rich', 'ראיון עבודה', {
    fixedTime: '10:00',
    location: { address: 'יגאל אלון 94', lat: 1, lng: 1, confirmed: true,
      transitPlan: { totalDurationMinutes: 7 } } as any,
  });
  r = mergeByMeaning([plain, rich]);
  check('the row with the time and route wins',
    r.kept.length === 1 && r.kept[0].id === 'rich', r.kept[0]?.id);

  r = mergeByMeaning([rich, plain]);
  check('...regardless of input order',
    r.kept.length === 1 && r.kept[0].id === 'rich', r.kept[0]?.id);

  console.log('\n3. Two rows that disagree about being done are a QUESTION');
  // Reversed deliberately. The old rule here was "completion always wins", and
  // it is the reason a tick she had just REMOVED came back: the completed twin
  // was still in the list and outvoted her correction on the next merge. A
  // merge is not entitled to decide whether work happened.
  const done = t('done', 'חדר כושר', { status: 'complete', completedAt: 1, fixedTime: undefined });
  const pendingRich = t('pend', 'חדר כושר', { fixedTime: '18:00' });
  r = mergeByMeaning([pendingRich, done]);
  check('both survive — neither status is allowed to erase the other',
    r.kept.length === 2, `kept ${r.kept.length}`);
  check('the completed one is still there',
    r.kept.some((k) => k.id === 'done' && k.status === 'complete'));
  check('and so is the open one',
    r.kept.some((k) => k.id === 'pend' && k.status !== 'complete'));

  // The correction she just made must not be undone by a stale finished copy.
  const corrected = t('fixed', 'חדר כושר', { status: 'pending', uncompletedAt: 999 } as any);
  r = mergeByMeaning([done, corrected]);
  check('an unticked row is never re-ticked by a completed twin',
    r.kept.some((k) => k.id === 'fixed' && k.status === 'pending'),
    r.kept.map((k) => `${k.id}:${k.status}`).join(','));

  // Same status still collapses — the actual duplicates are still cleaned up.
  const done2 = t('done2', 'חדר כושר', { status: 'complete', completedAt: 2, fixedTime: '18:00' });
  r = mergeByMeaning([done, done2]);
  check('two finished copies of one thing still merge',
    r.kept.length === 1 && r.kept[0].id === 'done2', `kept ${r.kept.length}`);

  console.log('\n4. Different tasks are left alone');
  // The dangerous direction. Each of these pairs must stay two rows.
  const pairs: Array<[string, string]> = [
    ['יוגה', 'ריצה'],
    ['לקנות חלב', 'לקנות לחם'],
    ['ראיון בגוגל', 'ראיון במטא'],
    ['פגישה עם דני', 'פגישה עם רותי'],
    ['שיעור אנגלית', 'שיעור נהיגה'],
  ];
  for (const [a, b] of pairs) {
    const out = mergeByMeaning([t('1', a), t('2', b)]);
    check(`"${a}" vs "${b}" stay separate`, out.kept.length === 2, `${out.kept.length}`);
  }

  console.log('\n5. The same task on different days is two appointments');
  r = mergeByMeaning([
    t('mon', 'יוגה', { date: '2026-08-21' }),
    t('tue', 'יוגה', { date: '2026-08-22' }),
    t('wed', 'יוגה', { date: '2026-08-23' }),
  ]);
  check('a weekly class is not collapsed into one', r.kept.length === 3, `${r.kept.length}`);

  console.log('\n6. Nothing is invented or lost');
  const input = [t('a', 'יוגה'), t('b', 'יוגה'), t('c', 'ריצה'), t('d', 'רופא')];
  r = mergeByMeaning(input);
  check('kept + merged accounts for every input row',
    r.kept.length + r.mergedIds.length === input.length,
    `${r.kept.length} + ${r.mergedIds.length} = ${input.length}`);
  check('no id appears in both kept and merged',
    !r.kept.some((k) => r.mergedIds.includes(k.id)));
  check('empty input is handled', mergeByMeaning([]).kept.length === 0);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
