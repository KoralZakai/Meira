/**
 * run-prep-merge — a creation that is reported and not stored.
 *
 * Koral's phone, 2026-09-22, every fifteen minutes, forever:
 *
 *     [GoogleSync] created 4 interview prep block(s)
 *
 * and the store never grew. mergeExternalTasks has a fuzzy branch: an incoming
 * task 0.7-similar to an existing row on the same date is ABSORBED into it
 * rather than added. "Final review for Ceva — questions to ask, what to wear,
 * the route" is that similar to "Prepare for: Your in-person interview with
 * Ceva", so the block was folded in, its id was never stored, and the next sync
 * found it missing and made it again. `changed` counted it, so the log said
 * "created". Each pass also took whichever text was longer, which is how the
 * row ended up called "Final review for להתכונן לראיון…".
 *
 * Prep blocks are keyed `prep-<n>d-<interview id>` precisely so that running
 * the rule forever produces the same blocks and never a third. A store that can
 * silently decline that id defeats the whole design.
 *
 *   npx tsx tests/run-prep-merge.ts
 */
import {
  prepTasksFor, isPrepBlock, isCorruptedPrep, runawayPrepIds,
} from '../src/utils/interviewPrep';
import { textSimilarity } from '../src/utils/fuzzyMatch';
import type { Task } from '../src/types/index';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
};

const DATE = '2026-09-23';
const interview = {
  id: 'gcal-ceva', text: 'Your in-person interview with Ceva', date: DATE,
  category: 'interview', priority: 'must', status: 'pending', fixedTime: '14:30',
  durationMinutes: 90, isFixed: true, createdAt: 0, historicalDurations: [],
} as unknown as Task;

console.log('\n1. The row the absorption left behind\n');

const blocks = prepTasksFor(interview, { lang: 'en', today: '2026-09-10' });
const review = blocks.find((b) => b.id.startsWith('prep-1d-'))!;
ok(blocks.length === 3, 'three prep blocks', `${blocks.length}`);

/*
 * Her log, verbatim, after the id guards shipped:
 *
 *     no morning prep for "Final review for להתכונן לראיו…"
 *
 * That row is the artifact. mergeExternalTasks absorbed our block into the
 * GapFill row and kept whichever text was longer, so the row has OUR words and
 * ITS OWN random id — no `prep-` id, no prepForTaskId, no "להתכונן ל:" prefix.
 * Every marker we guard on was gone, "ראיון" was still in the text, and the
 * rule prepared for it four times a sync, forever.
 */
const mutant = {
  ...interview,
  id: 'r4nd0m',
  text: 'Final review for להתכונן ל: ראיון בCeva — שאלות לשאול, מה ללבוש, הדרך',
  category: 'course',
} as unknown as Task;

ok(/ראיון/.test(mutant.text), 'it still contains the word that triggers the rule');
ok(!/^prep-/.test(mutant.id) && !(mutant as { prepForTaskId?: string }).prepForTaskId,
  'and carries none of the markers we guard on', mutant.id);
ok(isPrepBlock(mutant), 'so it is recognised by our own TITLE, which is all that is left');
ok(prepTasksFor(mutant, { lang: 'he', today: '2026-09-22' }).length === 0,
  'and it generates nothing');

// Both languages of every title we mint have to be recognised, or the next
// absorbed row is invisible again.
for (const lang of ['he', 'en'] as const) {
  for (const b of prepTasksFor(interview, { lang, today: '2026-09-10' })) {
    ok(isPrepBlock({ ...b, id: 'random', prepForTaskId: undefined } as unknown as Task),
      `[${lang}] "${b.text.slice(0, 32)}" is ours by its words alone`);
  }
}

// And the guard must not swallow her own writing.
for (const text of ['review the deck', 'לימודים למבחן', 'study group at 8', 'הכנה לארוחה']) {
  ok(!isPrepBlock({ ...mutant, text } as Task), `"${text}" is hers, not ours`);
}
void textSimilarity;

console.log('\n1b. And the rows it already wrote have to go\n');

/*
 * Still on her phone after the id guards shipped, because these were never
 * inserted as rows at all — the absorb path wrote OUR text into an EXISTING
 * row, so the id is that row's and nothing about it says "prep" but the words.
 * The recursion then added another layer to the same row every sync:
 *
 *   NEXT UP  "Morning study for Morning study for Morning study for …ל"
 *            4/10 tasks today · 🎯 "Final review for Final revie…"
 *
 * Two of our own prefixes in one title is not something she can type by
 * accident and not something any correct pass produces.
 */
const corrupted = [
  'Morning study for Morning study for Morning study for Ceva — up early',
  'Final review for Final review for Ceva — questions to ask',
  'לימוד בוקר ללימוד בוקר לCeva — לקום מוקדם',
  'חזרה אחרונה לחזרה אחרונה לCeva',
];
for (const text of corrupted) {
  ok(isCorruptedPrep({ ...interview, id: 'orig', text } as Task),
    `swept: "${text.slice(0, 44)}"`);
}

const kept = [
  ...prepTasksFor(interview, { lang: 'en', today: '2026-09-10' }).map((b) => b.text),
  ...prepTasksFor(interview, { lang: 'he', today: '2026-09-10' }).map((b) => b.text),
  'Prepare for: Your in-person interview with Ceva',
  'study group for study group',
  'לחפש משרות ולהעביר קורות חיים',
  'ללמוד למבחן של רפאל',
];
for (const text of kept) {
  ok(!isCorruptedPrep({ ...interview, id: 'orig', text } as Task),
    `kept: "${text.slice(0, 44)}"`);
}

ok(runawayPrepIds([{ ...interview, id: 'mangled', text: corrupted[0] } as Task])
  .includes('mangled'), 'and the sweep picks them up by id');
ok(runawayPrepIds([interview]).length === 0, 'while the interview itself is untouched');

console.log('\n2. Which is exactly why their ids must be honoured\n');

ok(isPrepBlock(review), 'the block is identified as prep', review.id);
ok(/^prep-\d+d-gcal-ceva$/.test(review.id),
  'and its id is DERIVED from the interview, not minted', review.id);
ok(
  blocks.every((b) => prepTasksFor(interview, { lang: 'en', today: '2026-09-10' })
    .some((again) => again.id === b.id)),
  'so two runs produce identical ids — the whole idempotence design',
);

console.log('\n3. The call site says so\n');

import * as fs from 'fs';
import * as path from 'path';
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');

const sync = read('src/services/GoogleSync.ts');
ok(/mergeExternalTasks\(prep, \{ fuzzyMerge: false \}\)/.test(sync),
  'ensureInterviewPrep opts out of the fuzzy branch');

const storage = read('src/services/TaskStorage.ts');
ok(/opts\.fuzzyMerge === false \? undefined :/.test(storage),
  'and the store honours it');
// Rule 1: absorbing is not adding, and something has to say so.
ok(/was absorbed into/.test(storage),
  'an absorbed task names both ids in the log, so the two can be told apart');
ok(/A caller that keys on id will ask for them again next time/.test(storage),
  'and the summary line says what the consequence is');

const gap = read('src/services/GapFillService.ts');
ok(/ALREADY_PREP_RE\.test\(t\.text\) \|\| isPrepBlock\(t\)/.test(gap),
  'GapFill stops offering prep for an interview that already has blocks');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
