/**
 * run-twin-prep — one interview slot, one set of prep blocks.
 *
 * 5.10, "why are there 2 duplicated tasks tomorrow?": the calendar's
 * "ראיון ראשון - קורל זכאי - חיפה" and her typed "ראיון עבודה רפאל ב 10
 * בפארק מדעי" sit on the same 10:00, and each row got its own "Prep for…"
 * block at 19:00 two evenings before.
 *
 *   npx tsx tests/run-twin-prep.ts
 */
import { missingPrepTasks, twinPrepIds } from '../src/utils/interviewPrep';
import type { Task } from '../src/types/index';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const DATE = '2030-10-08';
const row = (id: string, text: string, extra: Partial<Task> = {}): Task => ({
  id, text, category: 'interview', priority: 'must', isFixed: true, fixedTime: '10:00',
  durationMinutes: 120, date: DATE, status: 'pending', createdAt: 1, historicalDurations: [],
  ...extra,
} as Task);

const calendar = row('gcal-abc', 'ראיון ראשון - קורל זכאי - חיפה', { createdAt: 5 });
const typed = row('u-1', 'ראיון עבודה רפאל ב 10 בפארק מדעי', { createdAt: 2 });
const opts = { lang: 'he' as const, today: '2030-10-01', now: '09:00' };

console.log('\nTwin prep — one slot, one set of blocks\n');

const fresh = missingPrepTasks([calendar, typed], [], opts);
const parents = new Set(fresh.map((p) => (p as { prepForTaskId?: string }).prepForTaskId));
check('two interviews on one slot get prep once', parents.size === 1, [...parents].join(', '));
check('...and it is the calendar row that owns it (place + route)', parents.has('gcal-abc'), [...parents].join(', '));

const stale = missingPrepTasks([typed], [], opts);
check('the typed row alone still gets its prep', stale.length > 0, String(stale.length));
const store = [calendar, typed, ...fresh, ...stale];
const gone = twinPrepIds(store);
check('the second set already in the store is named for removal',
  gone.length === stale.length && stale.every((p) => gone.includes(p.id)), gone.join(', '));
check('the owner\'s blocks are kept', fresh.every((p) => !gone.includes(p.id)));

// The Rafael row on 8.10 had been overwritten with a prep title (an absorbed
// merge) — no longer an interview, so its blocks are orphans.
const rafael = row('gcal-coq', 'ראיון עבודה ברפאל ב 10 בפארק מדעי החיים', { fixedTime: '12:00' });
const itsPrep = missingPrepTasks([rafael], [], opts);
const corrupted = { ...rafael, text: 'Morning study for ראיון עבודה ברפאל ב 10 בפארק מדעי החיים — up early, then out the door' } as Task;
const orphans = twinPrepIds([corrupted, ...itsPrep]);
check('blocks whose interview turned into a prep title are named', itsPrep.length > 0
  && itsPrep.every((p) => orphans.includes(p.id)), `${orphans.length}/${itsPrep.length}`);
check('blocks whose interview is gone are named', twinPrepIds(itsPrep).length === itsPrep.length);
check('a block dated before today is left alone', twinPrepIds(itsPrep, '2031-01-01').length === 0);
check('the calendar row itself is never named', !orphans.includes('gcal-coq'));
// 6.10: she picked "Prep for the Ceva interview" from a suggestion after the
// interview was done — hers now, not a stale block.
const picked = itsPrep.map((p) => ({ ...p, pickedAt: 1 } as Task));
check('a block she placed herself is never named', twinPrepIds(picked).length === 0, twinPrepIds(picked).join(', '));

const other = row('u-2', 'ראיון עם חברה אחרת', { fixedTime: '14:00' });
check('an interview at another hour keeps its own prep',
  missingPrepTasks([calendar, other], [], opts).some((p) => (p as { prepForTaskId?: string }).prepForTaskId === 'u-2'));

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
