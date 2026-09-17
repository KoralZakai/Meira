/**
 * run-brief-digest — the research has to ARRIVE, not merely exist.
 *
 * Koral, 2026-09-17, about a phone interview she had had that morning:
 *
 *   "today i had a phone interview with some Team leader in Ceva about a DSP
 *    C++ role, i expected a preparation about the team leader, about ceva
 *    about the role — inside the task, edit the task and insert a summery and
 *    reminders ... prepare the user with that data a day before the meeting
 *    and 1-2 hours before the meeting."
 *
 * The research already worked. server/meeting_brief.py had been producing
 * sourced, cited briefs since the day before. It was drawn on ONE card, on ONE
 * screen, for the single next meeting — so unless that screen happened to be
 * open, the briefing did not exist as far as she was concerned.
 *
 * These tests are about the last step only: what survives into a notification,
 * what gets written onto the task, and what must never be said at all.
 *
 * Run:  npx tsx tests/run-brief-digest.ts
 */
import {
  digestFromBrief, briefAlertBody, briefNote, briefHeadline, stripCitations, BriefLike,
} from '../src/utils/briefDigest';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

// Her actual meeting, in the shape the server returns it.
const CEVA: BriefLike = {
  ok: true,
  headline_he: 'ראיון טלפוני עם ראש צוות ב-CEVA על תפקיד DSP C++',
  headline_en: 'Phone interview with a CEVA team leader about a DSP C++ role',
  company_he: ['CEVA מפתחת ליבות DSP ו-IP לשבבים [1]', 'מטה בהרצליה, נסחרת בנאסד"ק [2]'],
  company_en: ['CEVA licenses DSP cores and chip IP [1]', 'Herzliya HQ, listed on Nasdaq [2]'],
  person_he: ['ראש צוות בקבוצת ה-DSP, 6 שנים בחברה [3]'],
  person_en: ['Team leader in the DSP group, six years there [3]'],
  history_he: ['סוכם שתשלחי קורות חיים לפני השיחה [7]'],
  history_en: ['You agreed to send your CV before the call [7]'],
  questions_he: ['על איזה ליבה הצוות עובד עכשיו?', 'כמה מהקוד הוא C++ מודרני?', 'איך נראה תהליך הקליטה?'],
  questions_en: ['Which core is the team on now?', 'How much of the code is modern C++?', 'What does onboarding look like?'],
  confidence: 'high',
};

function main() {
  console.log('\nDelivering the research — the night before, and an hour before\n');

  console.log('1. Citations belong with the source list');
  check('a marker is stripped', stripCitations('CEVA licenses DSP cores [1]') === 'CEVA licenses DSP cores');
  check('...including a multi-source one',
    stripCitations('Herzliya HQ [1,3]') === 'Herzliya HQ');
  check('a line with no marker is untouched', stripCitations('plain line') === 'plain line');
  check('a number that is not a citation survives',
    stripCitations('6 years there') === '6 years there');

  console.log('\n2. What gets stored on the task');
  const digest = digestFromBrief(CEVA, 1_000)!;
  check('the brief becomes storable', Boolean(digest));
  check('both languages are kept — switching language must not cost a search',
    Boolean(digest.headlineHe && digest.headlineEn));
  check('what they already agreed comes FIRST, before the company blurb',
    digest.linesEn[0].includes('send your CV'), digest.linesEn[0]);
  check('the questions survive', digest.questionsEn.length === 3);
  check('and it is stamped', digest.fetchedAt === 1_000);

  console.log('\n3. Nothing worth saying is never said');
  check('a refusal stores nothing', digestFromBrief({ ok: false }) === null);
  check('null stores nothing', digestFromBrief(null) === null);
  check('a headline with no facts behind it is NOT a brief',
    digestFromBrief({ ok: true, headline_en: 'A meeting' }) === null,
    'a confident empty summary is worse than no summary');

  console.log('\n4. The night before — there is still time to read it');
  const night = briefAlertBody(digest, 'he', 'day-before')!;
  check('it carries the headline', night.includes('CEVA'));
  check('it reminds her what they already said',
    night.includes('קורות חיים'), night);
  check('it offers a question to ask', night.includes('לשאול:'));
  check('...and it carries no source markers into a notification',
    !/\[\d/.test(night), night);

  console.log('\n5. An hour before — she is about to pick up the phone');
  const hour = briefAlertBody(digest, 'he', 'hour-before')!;
  check('it is SHORTER than the night-before body',
    hour.length < night.length, `${hour.length} vs ${night.length} chars`);
  check('it still names the thing', hour.includes('CEVA'));
  check('it still gives her one question', hour.includes('לשאול:'));
  check('and only one', (hour.match(/·/g) || []).length <= 1, hour);

  console.log('\n6. English works the same way');
  const en = briefAlertBody(digest, 'en', 'day-before')!;
  check('it is in English', en.includes('DSP core') || en.includes('DSP cores'), en);
  check('and it asks in English', en.includes('Ask:'));

  console.log('\n7. Falling back rather than going blank');
  const heOnly = digestFromBrief({ ok: true, headline_he: 'רק עברית', company_he: ['עובדה [1]'] })!;
  check('an English request falls back to the Hebrew it has',
    briefHeadline(heOnly, 'en') === 'רק עברית',
    'a brief she can read beats no brief');
  check('...and the body follows', Boolean(briefAlertBody(heOnly, 'en', 'day-before')));

  console.log('\n8. Written into the task, where the sources ARE');
  const note = briefNote(digest, 'he')!;
  check('the note keeps its citations — this copy is checkable',
    /\[\d/.test(note), 'an invented address is why every bullet cites a source');
  check('it is laid out to be read, not parsed', note.includes('\n• '));
  check('the questions are a section of their own', note.includes('שאלות לשאול:'));
  check('nothing to write means nothing written', briefNote(null, 'he') === undefined);

  console.log('\n9. Low confidence is shown, never quietly dropped');
  const shaky = digestFromBrief({ ...CEVA, confidence: 'low' })!;
  check('the note warns her to verify', briefNote(shaky, 'he')!.includes('⚠️'));
  check('...and in English', briefNote(shaky, 'en')!.includes('⚠️'));
  check('a high-confidence brief carries no warning', !briefNote(digest, 'he')!.includes('⚠️'));

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
