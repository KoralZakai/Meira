/**
 * run-local-extract — "Meira answered correctly, and nothing was saved."
 *
 * Koral, 2026-09-17: "i added again יוגה ב 11 בבוקר ביגאל אלון 94 and Meira
 * answers correctly! but now i see that nothing have been saved?! why? where
 * is the clock alarm the route the task?..."
 *
 * Verified on her phone before writing a line of this: the task was not on
 * Today, not on Tomorrow, not under Upcoming. The server logs showed no
 * /agent/chat request at all. So the app answered her entirely on its own —
 * and threw the task away.
 *
 * THE PATH, and every step of it looks like success:
 *
 *   brainTurn()           → null, at a SILENT `return null`
 *   coachTurn()           ← "the local fallback"
 *   extractTasks()        → extractServerTasks()  ← THE SERVER AGAIN
 *                         → null → []
 *   chit(language)        → warm conversational reply, savedCount 0
 *
 * The fallback was not local. LumiCoachEngine.extractTasks had exactly one
 * source — the backend — so an unreachable server (asleep on the free tier, a
 * stale token, a tunnel) turned a commitment into small talk. Neither door out
 * of the chat logged anything.
 *
 * What makes it fixable is that the parser was already there. Her sentence
 * goes through the same three parsers addManualTask has always used. The chat
 * used none of them.
 *
 * Run:  npx tsx tests/run-local-extract.ts
 */
import { extractLocally, looksLikeAQuestion, describeLocalSave } from '../src/utils/localTaskExtract';
import { parseTimeExpression } from '../src/utils/timeParser';
import { extractHebrewPlaceParts } from '../src/utils/hebrewPlace';
// NOT the real inferTaskDetails: services/TaskParser imports react-native, so
// it cannot load outside the app. That is exactly why extractLocally takes its
// parsers INJECTED — the decision logic is testable here and the real wiring is
// type-checked by tsc. The two parsers that do the load-bearing work, the time
// and the place, ARE the real ones.
const inferTaskDetails = (text: string) => ({
  category: /יוגה|אימון|כושר|gym|yoga/i.test(text) ? 'gym' as const
    : /ראיון|interview/i.test(text) ? 'interview' as const
      : 'general' as const,
  priority: 'need_to' as const,
  durationMinutes: 60,
});

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const TODAY = '2026-09-17';
// The real parsers, exactly as LumiCoachEngine injects them.
const PARSERS = {
  time: (t: string, ref: string) => parseTimeExpression(t, ref) as any,
  place: extractHebrewPlaceParts,
  details: inferTaskDetails,
};
const parse = (text: string) => extractLocally(text, TODAY, PARSERS);

function main() {
  console.log('\nUnderstanding a message with no server\n');

  console.log('1. Her sentence — the one that was lost');
  const yoga = parse('יוגה ב 11 בבוקר ביגאל אלון 94');
  check('it is understood without the server at all', Boolean(yoga));
  check('...the hour', yoga?.fixedTime === '11:00', String(yoga?.fixedTime));
  check('...the place', yoga?.location === 'יגאל אלון 94', String(yoga?.location));
  check('...and it is confident enough to save', yoga?.confident === true);
  check('the text is kept as SHE wrote it', yoga?.text === 'יוגה ב 11 בבוקר ביגאל אלון 94');

  console.log('\n2. A place with no hour, and an hour with no place');
  check('a place alone is a commitment', Boolean(parse('אימון ביגאל אלון 94')));
  check('an hour alone is a commitment', Boolean(parse('פגישה ב-15:00')));

  console.log('\n3. What it must REFUSE to save');
  check('a question is not a task', parse('מה יש לי מחר?') === null);
  check('...in English too', parse('what do I have tomorrow?') === null);
  check('a thank-you is not a task', parse('תודה') === null);
  check('"ok" is not a task', parse('ok') === null);
  check('a vague remark with no hour and no place is not saved behind her back',
    parse('אולי אלך להתאמן') === null,
    'the server would have had history and context; this does not');
  check('an empty message is nothing', parse('') === null && parse('  ') === null);

  console.log('\n4. Telling a question from a commitment');
  check('a leading question word', looksLikeAQuestion('מתי היוגה?'));
  check('a trailing question mark', looksLikeAQuestion('היוגה מחר?'));
  check('her sentence is NOT a question',
    !looksLikeAQuestion('יוגה ב 11 בבוקר ביגאל אלון 94'));
  check('a place called "מה" does not make it one',
    !looksLikeAQuestion('פגישה במה שמו 14:00'));

  console.log('\n5. It never claims more than one task');
  const many = parse('מחר חדר כושר ב-8, רופא שיניים ב-10, ולהתקשר לאמא');
  check('a multi-task message yields ONE task, not three guesses',
    many !== null && typeof many.text === 'string',
    'the server splits these; guessing locally turns one honest failure into three wrong tasks');

  console.log('\n6. It says what happened, and does not pretend');
  const savedMsg = describeLocalSave(yoga, true);
  check('a local save admits it was local', savedMsg.includes('לא הצלחתי להגיע לשרת'));
  check('...and promises the route later', savedMsg.includes('המסלול'));
  check('...and names the hour', savedMsg.includes('11:00'));
  const lostMsg = describeLocalSave(null, true);
  check('a failure says NOTHING WAS SAVED, in as many words',
    lostMsg.includes('לא שמרתי כלום'),
    'this is the sentence that was missing — small talk stood here');
  check('...and offers her something to do about it', lostMsg.includes('ידנית'));
  check('...and it works in English', describeLocalSave(null, false).includes('nothing was saved'));

  console.log('\n7. The category comes from the words, not from a default');
  check('yoga is recognised as a workout', yoga?.category === 'gym', String(yoga?.category));
  check('an interview is not', parse('ראיון ב-10:00')?.category === 'interview');

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
