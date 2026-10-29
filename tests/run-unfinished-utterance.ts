/**
 * run-unfinished-utterance — a sentence cut at a thinking pause keeps listening.
 *   npx tsx tests/run-unfinished-utterance.ts
 */
import { looksUnfinished, joinParts } from '../src/utils/unfinishedUtterance';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

// Her real cut sentence, 29.10 11:33.
ok(looksUnfinished('זה לא הגיוני, אני ביום שני בזומבה, ב...'), 'her 29.10 sentence is unfinished');
ok(looksUnfinished('I want to schedule... hmm'), '"…hmm" is a pause, not the end');
ok(looksUnfinished('I want to schedule Zumba and'), 'ends on "and"');
ok(looksUnfinished('תקבעי לי אימון ביום'), 'ends on "ביום"');
ok(looksUnfinished('תקבעי לי אימון אממ'), 'ends on a filler');
ok(!looksUnfinished('תקבעי זומבה ביום שני'), 'a whole request is finished');
ok(!looksUnfinished('How many times did I work out this week?'), 'a question is finished');
ok(!looksUnfinished('Schedule Zumba next Monday.'), 'a full stop is finished');
ok(!looksUnfinished(''), 'nothing is not unfinished');
ok(joinParts('I want to schedule...', 'Zumba next Monday') === 'I want to schedule Zumba next Monday', 'the parts join');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
