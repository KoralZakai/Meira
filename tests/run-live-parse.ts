/**
 * run-live-parse — what the Add screen shows under the input, on every keystroke.
 *
 * Koral, 17.10: "parsing happens while typing". The chips are only worth
 * having if they name what the SAVE will do, so this drives the real parsers
 * with the sentences she actually writes — in both languages, because "the
 * language doesn't matter, the behavior" (16.9).
 *
 * Also pins src/utils/dateExpression.ts to the server's own resolver through
 * tests/fixtures/date-expression-golden.json (server/tests/
 * test_date_expression_parity.py reads the same file).
 *
 * Run:  npx tsx tests/run-live-parse.ts
 */
import { readFileSync } from 'node:fs';
import { liveParse, removeSpan, parseSignature, type LiveContact } from '../src/utils/liveParse';
import { findDateExpression, resolveDateExpression, describeDate } from '../src/utils/dateExpression';

// timeParser narrates every call with console.log; this suite reads results.
const realLog = console.log;
console.log = () => {};
let failures = 0; let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1; if (!ok) failures += 1;
  realLog(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : `, wanted ${JSON.stringify(want)}`}`);

// Saturday 17 October 2026, 14:00 — the day this feature was specified.
const NOW = new Date(2026, 9, 17, 14, 0, 0);

const CONTACTS: LiveContact[] = [
  { id: 'c1', name: 'אבא', phone: '050-111-2222' },
  { id: 'c2', name: 'Mom', phone: '052-333-4444' },
  { id: 'c3', name: 'Dana Levi', phone: '054-555-6666' },
  { id: 'c4', name: 'דני כהן' },
  { id: 'c5', name: 'דני לוי' },
  { id: 'c6', name: 'Itay Barak', phone: '053-777-8888' },
];
const parse = (t: string, extra: Record<string, unknown> = {}) =>
  liveParse(t, { now: NOW, contacts: CONTACTS, ...extra } as any);

realLog('\nThe four sentences from the spec');

{
  const p = parse("dad's birthday party at 20:00");
  eq('EN birthday: time', p.time, '20:00');
  eq('EN birthday: person is the contact called אבא', p.person?.contact?.name, 'אבא');
  eq('EN birthday: relation', p.person?.relation, 'dad');
  eq('EN birthday: occasion', p.occasion, 'birthday');
  check('EN birthday: no date was said, none invented', p.date === undefined);
  check('EN birthday: not filed as an interview', p.category !== 'interview');
}
{
  const p = parse('יום הולדת לאבא ב-20:00');
  eq('HE birthday: time', p.time, '20:00');
  eq('HE birthday: person is the contact called אבא', p.person?.contact?.name, 'אבא');
  eq('HE birthday: relation', p.person?.relation, 'dad');
  eq('HE birthday: occasion', p.occasion, 'birthday');
  eq('HE birthday: the person span covers "לאבא"', 'יום הולדת לאבא ב-20:00'.slice(p.spans.person!.start, p.spans.person!.end), 'לאבא');
}
{
  const p = parse('interview Sunday 13:30 at Rafael David Institute, algorithm engineer');
  eq('EN interview: category', p.category, 'interview');
  eq('EN interview: icon', p.icon, '🎯');
  eq('EN interview: time', p.time, '13:30');
  eq('EN interview: next Sunday (today is Saturday 17.10)', p.date, '2026-10-18');
  eq('EN interview: place stops at the comma', p.place?.text, 'Rafael David Institute');
}
{
  const p = parse('ראיון ביום ראשון ב 13:30 ברפאל מכון דוד');
  eq('HE interview: category', p.category, 'interview');
  eq('HE interview: time', p.time, '13:30');
  eq('HE interview: the same Sunday as the English one', p.date, '2026-10-18');
  eq('HE interview: place, without its ב', p.place?.text, 'רפאל מכון דוד');
  eq('HE interview: place span is the words', 'ראיון ביום ראשון ב 13:30 ברפאל מכון דוד'.slice(p.spans.place!.start, p.spans.place!.end), 'ברפאל מכון דוד');
}

realLog('\nLanguage parity: the same commitment, said both ways, reads the same');
{
  const pairs: Array<[string, string]> = [
    ['interview Sunday 13:30 at Rafael David Institute', 'ראיון ביום ראשון ב 13:30 ברפאל מכון דוד'],
    ['gym tomorrow at 19:00', 'חדר כושר מחר ב-19:00'],
    ['dentist on Thursday at 9', 'רופא שיניים ביום חמישי ב-9'],
  ];
  for (const [en, he] of pairs) {
    const a = parse(en); const b = parse(he);
    eq(`"${en}" ≡ HE: category`, a.category, b.category);
    eq(`"${en}" ≡ HE: date`, a.date, b.date);
    eq(`"${en}" ≡ HE: time`, a.time, b.time);
  }
}

realLog('\nNo time, no date, nothing to say');
{
  const p = parse('buy milk');
  check('no time', p.time === undefined);
  check('no date', p.date === undefined);
  check('no person', p.person === undefined);
  check('no place', p.place === undefined);
  eq('a shrug is a shrug: general, not matched', [p.category, p.categoryMatched], ['general', false]);
  const empty = parse('');
  eq('empty input is safe', [empty.title, empty.category, empty.time], ['', 'general', undefined]);
  const spaces = parse('   ');
  check('whitespace is safe', spaces.time === undefined && spaces.spans.time === undefined);
}

realLog('\nTime');
{
  const r = parse('dinner from 19:00 to 21:30');
  eq('a range gives both ends', [r.time, r.endTime], ['19:00', '21:30']);
  eq('…and its length', r.durationMinutes, 150);
  eq('hour only, Hebrew, evening', parse('אימון ב 8 בערב').time, '20:00');
  eq('hour only, English am', parse('standup at 9am').time, '09:00');
  eq('a bare small hour is the afternoon (the app\'s rule)', parse('call at 3').time, '15:00');
  const sp = parse('meeting with Dana tomorrow at 5');
  eq('the time span is "at 5"', 'meeting with Dana tomorrow at 5'.slice(sp.spans.time!.start, sp.spans.time!.end), 'at 5');
}

realLog('\nDates that are NOT times');
{
  const p = parse('ארוחה ב-20.10 ב-19:00');
  eq('"ב-20.10" is the 20th of October…', p.date, '2026-10-20');
  eq('…not 20:00; the hour is the other one', p.time, '19:00');
  const q = parse('מילואים ב 8 באוקטובר');
  eq('"ב 8 באוקטובר" is a day (next year: 8.10 has passed)', q.date, '2027-10-08');
  check('…and not eight o\'clock', q.time === undefined);
  const w = parse('lunch 3.5 hours');
  check('"3.5 hours" is a quantity, not the 3rd of May', w.date === undefined);
}

realLog('\nPeople');
{
  eq('"dad" → the contact', parse('call dad').person?.contact?.name, 'אבא');
  eq('"לאבא שלי" → the contact', parse('מתנה לאבא שלי').person?.contact?.name, 'אבא');
  eq('"my mom" → the contact called Mom', parse('lunch with my mom').person?.contact?.name, 'Mom');
  eq('"אמא" → Mom (Hebrew word, English contact)', parse('לקחת את אמא לרופא').person?.contact?.name, 'Mom');
  const noContacts = liveParse('call dad', { now: NOW, language: 'en' });
  eq('no contacts: still a Dad chip, with no contact behind it', [noContacts.person?.label, noContacts.person?.contact], ['Dad', undefined]);
  const heNoContacts = liveParse('מתנה לאבא', { now: NOW, language: 'he' });
  eq('no contacts, Hebrew: labelled in Hebrew', heNoContacts.person?.label, 'אבא');
  eq('a first name → the contact', parse('meeting with Dana').person?.contact?.name, 'Dana Levi');
  const two = parse('פגישה עם דני');
  eq('two contacts answer to "דני": ambiguous, no guess', [two.person?.ambiguous, two.person?.contact], [true, undefined]);
  eq('the full name settles it', parse('פגישה עם דני לוי').person?.contact?.name, 'דני לוי');
  eq('a name with no contact still gets a chip (English cue)', liveParse('lunch with Noam', { now: NOW }).person?.label, 'Noam');
  check('"אבי" is a first name, not a father', liveParse('פגישה עם אבי', { now: NOW }).person?.relation === undefined);
  check('a weekday is never a person', liveParse('lunch with Monday crowd', { now: NOW, contacts: [] }).person === undefined);
}

realLog('\nPlaces');
{
  eq('English: capitalised run after "at"', parse('coffee at Cafe Nero').place?.text, 'Cafe Nero');
  eq('English: with a number', parse('yoga at Yigal Alon 94').place?.text, 'Yigal Alon 94');
  check('"at noon" is not a place', parse('lunch at noon').place === undefined);
  check('"in the morning" is not a place', parse('run in the morning').place === undefined);
  eq('Hebrew: address with a house number', parse('יוגה מחר ב 11 בבוקר ביגאל אלון 94').place?.text, 'יגאל אלון 94');
  check('"ביום ראשון" is a day, never a place', parse('ראיון ביום ראשון').place === undefined);
  const known = liveParse('gym', {
    now: NOW,
    knownPlaces: { '@fitness': { address: 'Yigal Alon 94, Tel Aviv', count: 3, words: ['gym'] } },
  });
  eq('her usual gym is offered when she typed no place', [known.place?.text, known.place?.source], ['Yigal Alon 94, Tel Aviv', 'known']);
  const typedWins = liveParse('gym at Space Gym', {
    now: NOW,
    knownPlaces: { '@fitness': { address: 'Yigal Alon 94, Tel Aviv', count: 3, words: ['gym'] } },
  });
  eq('what she typed beats what she typed last month', [typedWins.place?.text, typedWins.place?.source], ['Space Gym', 'typed']);
}

realLog('\nRemoving a chip removes the words');
{
  const t = 'ראיון ביום ראשון ב 13:30 ברפאל מכון דוד';
  const p = parse(t);
  eq('✕ on the time', removeSpan(t, p.spans.time!), 'ראיון ביום ראשון ברפאל מכון דוד');
  eq('✕ on the date', removeSpan(t, p.spans.date!), 'ראיון ב 13:30 ברפאל מכון דוד');
  const after = parse(removeSpan(t, p.spans.date!));
  check('…and the next keystroke agrees: no date any more', after.date === undefined && after.time === '13:30');
  const e = "dad's birthday party at 20:00";
  eq('✕ on the person', removeSpan(e, parse(e).spans.person!), 'birthday party at 20:00');
}

realLog('\nPreparation is not an interview; occasions are found in both languages');
{
  eq('"Prep for the Rafael interview" is studying, not another interview', parse('Prep for the Rafael interview').category, 'course');
  eq('"הכנה לראיון ברפאל" likewise', parse('הכנה לראיון ברפאל').category, 'course');
  eq('a real interview is still one', parse('interview with Rafael').category, 'interview');
  const occ = (t: string) => parse(t).occasion;
  eq('birthday EN / HE', [occ("Noa's birthday dinner"), occ('יום הולדת לנועה')], ['birthday', 'birthday']);
  eq('wedding EN / HE', [occ('wedding on Friday'), occ('חתונה של דנה ביום שישי')], ['wedding', 'wedding']);
  eq('engagement counts as a wedding-kind occasion', [occ('Dan\'s engagement'), occ('אירוסין של דן')], ['wedding', 'wedding']);
  eq('anniversary', occ('אירוע יום נישואין שלנו'), 'anniversary');
  check('an ordinary sentence has no occasion', occ('meeting with Dana tomorrow') === undefined);
}

realLog('\nThe screen is wired to all of this');
{
  const src = readFileSync('src/screens/AddTaskScreen.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  check('the ✨ Parse-with-Lumi button is gone', !/Parse with Lumi|handleLumiParse|parseSpeechToTasksWithExpansion/.test(src));
  check('the chips come from liveParse on every keystroke (no debounce on them)',
    /liveParse\(text,/.test(src) && !/setTimeout\([^)]*liveParse/.test(src));
  check('the question is "What do you want to add?" in both languages', /What do you want to add\?/.test(src) && /מה להוסיף\?/.test(src));
  check('an empty input shows the suggestion list', /!typing \? \(\s*<SuggestionList/.test(src));
  check('the save path still asks before touching an existing task (confirmAction)', /confirmAction\(result\.action\)/.test(src));
  check('a greeting is only ever OPENED in WhatsApp, never sent', /Linking\.openURL\(url\)/.test(src) && !/fetch\(|sendMessage|schedule_message/.test(src));
  check('the contact number goes nowhere but the wa.me link', /hasPhone: a\.personHasPhone/.test(readFileSync('src/hooks/useAddUnderstand.ts', 'utf8'))
    && !/phone:/.test(readFileSync('src/hooks/useAddUnderstand.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
  const chipsSrc = readFileSync('src/components/add/LiveChips.tsx', 'utf8');
  check('chips are at least MIN_TOUCH tall and wrap', /touch: \{ minHeight: MIN_TOUCH \}/.test(chipsSrc) && /flexWrap: 'wrap'/.test(chipsSrc));
  check('chip labels give way instead of overflowing', /numberOfLines=\{1\}/.test(chipsSrc) && /flexShrink: 1/.test(chipsSrc));
}

realLog('\nThe signature moves with the sense, not with the letters');
{
  const a = parseSignature(parse('call dad tomorrow'));
  const b = parseSignature(parse('call dad tomorrow!'));
  const c = parseSignature(parse('call dad tomorrow at 9'));
  check('punctuation does not change it', a === b);
  check('a new fact does', a !== c);
}

realLog('\nDate resolver = the server\'s resolver (golden fixture)');
{
  const fx = JSON.parse(readFileSync('tests/fixtures/date-expression-golden.json', 'utf8'));
  const [y, m, d] = fx.today.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  let bad = 0;
  for (const c of fx.cases as Array<{ text: string; date: string | null }>) {
    const got = resolveDateExpression(c.text, today);
    if (got !== c.date) { bad += 1; realLog(`      ✗ ${JSON.stringify(c.text)} → ${got}, server says ${c.date}`); }
  }
  check(`${fx.cases.length} expressions agree with tz.resolve_date`, bad === 0, bad ? `${bad} differ` : '');
}

realLog('\nDifferences from the server that are on purpose');
{
  const today = new Date(2026, 9, 17);
  check('a bare "שניות" is not Monday', findDateExpression('חכי כמה שניות', today) === null);
  check('a bare "ראשון" (first) is not Sunday', findDateExpression('הדבר הראשון', today) === null);
  eq('"13.30" is not a date; the search goes on', findDateExpression('13.30 ביום שני', today)?.kind, 'weekday');
  eq('today\'s own weekday means NEXT week, like the server', resolveDateExpression('Saturday', today), '2026-10-24');
}

realLog('\nDate chip wording');
{
  const today = new Date(2026, 9, 17);
  eq('today', describeDate('2026-10-17', today, false), 'Today');
  eq('tomorrow, Hebrew', describeDate('2026-10-18', today, true), 'מחר');
  eq('a weekday, English', describeDate('2026-10-23', today, false), 'Fri 23.10');
  eq('a weekday, Hebrew', describeDate('2026-10-23', today, true), 'יום ו׳ 23.10');
}

console.log = realLog;
realLog(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
