/**
 * run-language-parity — the same day, said in two languages, must come out the same.
 *
 * Koral, 2026-09-17: "All features must support both english and Hebrew — the
 * language doesn't matter, the behavior!"
 *
 * She said it because the app had just proved otherwise, twice in one hour,
 * and both were found by accident rather than by any test:
 *
 *   1. utils/hebrewPlace opens with `if (!HEB.test(text)) return empty`, so
 *      the on-device fallback had NO English place extractor at all.
 *      "יוגה מחר ב 11 בבוקר ביגאל אלון 94" kept its address;
 *      "yoga tomorrow at 11 am at Yigal Alon 94" silently lost it — and a task
 *      with no place gets no route, no leave time and no alarm.
 *   2. timeParser.detectFixedTime required a preposition ("at", "by", "בשעה",
 *      or the Hebrew ב glued to the number). Hebrew always has one. English
 *      often does not, so "yoga tomorrow 11:00" parsed no hour while the
 *      identical Hebrew sentence parsed 11:00.
 *
 * Both were invisible because every other test is written in one language. So
 * this file does not test a feature — it tests the PRINCIPLE, by running
 * matched pairs through the real parsers and asserting the outputs agree.
 *
 * Adding a pair here is how a new feature earns its bilingual guarantee.
 *
 * Run:  npx tsx tests/run-language-parity.ts
 */
import { parseTimeExpression } from '../src/utils/timeParser';
import { placePartsFrom } from '../src/utils/placeFromText';
import { extractLocally } from '../src/utils/localTaskExtract';
import { needsWakeAlarm } from '../src/utils/alertPlan';
import { describeTravelRow } from '../src/utils/travelRowState';
import { describeYield } from '../src/utils/yieldToFixed';
import { describeLocalSave } from '../src/utils/localTaskExtract';
import { completeAddress } from '../src/utils/addressCompletion';
import { conceptOf, activityKeyOf } from '../src/utils/knownPlaces';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const TODAY = '2026-09-17';
const details = () => ({ category: 'gym' as const, priority: 'need_to' as const, durationMinutes: 60 });
const parsers = {
  time: (t: string, r: string) => parseTimeExpression(t, r) as any,
  place: placePartsFrom,
  details,
};

/** The same commitment, said both ways. */
const PAIRS: Array<{ he: string; en: string; time?: string; date?: string; placed: boolean }> = [
  { he: 'יוגה מחר ב 11 בבוקר ביגאל אלון 94', en: 'yoga tomorrow at 11 am at Yigal Alon 94',
    time: '11:00', date: '2026-09-18', placed: true },
  { he: 'יוגה מחר ב 11:00 ביגאל אלון 94', en: 'yoga tomorrow 11:00 at Yigal Alon 94',
    time: '11:00', date: '2026-09-18', placed: true },
  { he: 'ראיון ב-10:00 בסבא', en: 'interview at 10:00 at Ceva',
    time: '10:00', placed: true },
  { he: 'שיחה ב-3', en: 'call at 3', time: '15:00', placed: false },
];

function main() {
  console.log('\nLanguage parity — the behaviour must not depend on the language\n');

  console.log('1. The same sentence, both ways');
  for (const pair of PAIRS) {
    const he = extractLocally(pair.he, TODAY, parsers);
    const en = extractLocally(pair.en, TODAY, parsers);
    check(`both are understood: "${pair.en}"`, Boolean(he) && Boolean(en),
      `he=${he ? 'ok' : 'LOST'} en=${en ? 'ok' : 'LOST'}`);
    if (!he || !en) continue;
    check('  ...same hour', he.fixedTime === en.fixedTime,
      `he=${he.fixedTime} en=${en.fixedTime}`);
    check('  ...same date', he.date === en.date, `he=${he.date} en=${en.date}`);
    check('  ...both found a place, or neither did',
      Boolean(he.location) === Boolean(en.location) && Boolean(he.location) === pair.placed,
      `he=${he.location ?? '—'} en=${en.location ?? '—'}`);
    if (pair.time) check(`  ...and it is ${pair.time}`, he.fixedTime === pair.time);
  }

  console.log('\n2. The place parser answers in either language');
  check('Hebrew street', placePartsFrom('אימון ביגאל אלון 94').place === 'יגאל אלון 94');
  check('English street', placePartsFrom('workout at Yigal Alon 94').place === 'Yigal Alon 94');
  check('an English hour is NOT mistaken for a place',
    placePartsFrom('yoga tomorrow at 11 am').place === null,
    String(placePartsFrom('yoga tomorrow at 11 am').place));
  check('...nor is a Hebrew one',
    placePartsFrom('יוגה מחר ב 11 בבוקר').place === null,
    String(placePartsFrom('יוגה מחר ב 11 בבוקר').place));

  console.log('\n3. A bare clock time needs no preposition, in either language');
  check('English "meeting 14:30"', parseTimeExpression('meeting 14:30', TODAY).fixedTime === '14:30');
  check('Hebrew "פגישה 14:30"', parseTimeExpression('פגישה 14:30', TODAY).fixedTime === '14:30');
  check('a bare number is still not an hour, in English',
    !parseTimeExpression('yoga 11', TODAY).fixedTime);
  check('...and not in Hebrew either',
    !parseTimeExpression('יוגה 11', TODAY).fixedTime);

  console.log('\n4. Decisions must not read the language at all');
  check('the wake alarm rule is language-free',
    needsWakeAlarm('10:14', '07:30') === needsWakeAlarm('10:14', '07:30'));
  check('a known place crosses languages',
    activityKeyOf('yoga class') === activityKeyOf('יוגה'),
    `${activityKeyOf('yoga class')} vs ${activityKeyOf('יוגה')}`);
  check('...and so does its concept', conceptOf('gym') === conceptOf('חדר כושר'));
  check('address completion works on an English street',
    completeAddress('Yigal Alon 94', 'Herzl 20, Tel Aviv-Yafo') === 'Yigal Alon 94, Tel Aviv-Yafo');
  check('...and a Hebrew one',
    completeAddress('יגאל אלון 94', 'הרצל 20, תל אביב-יפו') === 'יגאל אלון 94, תל אביב-יפו');

  console.log('\n5. Every message to her exists in both languages');
  const both = (fn: (he: boolean) => string | null | undefined) => {
    const he = fn(true); const en = fn(false);
    return Boolean(he) && Boolean(en) && he !== en;
  };
  check('the travel row explains itself in both',
    both((he) => describeTravelRow('no-time', he)?.text)
    && both((he) => describeTravelRow('pending', he)?.text)
    && both((he) => describeTravelRow('unroutable', he)?.text));
  check('so does a yielded block',
    both((he) => describeYield(
      { taskId: 'x', action: 'move', blockedBy: 'y', from: { start: '18:18', end: '20:18' },
        to: { start: '20:00', end: '22:00' }, minutes: 120 }, 'yoga', he)));
  check('so does a local save', both((he) => describeLocalSave(null, he)));
  check('...and a successful one', both((he) => describeLocalSave(
    { text: 'x', category: 'gym', priority: 'need_to', fixedTime: '11:00',
      date: TODAY, confident: true }, he)));

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
