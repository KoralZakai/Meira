/**
 * run-categorize-parity — the phone and the server must label a task the same.
 *
 * `src/utils/categorize.ts` is a hand port of `server/categorize.py`. Two
 * copies of a keyword table drift the moment someone adds a word to one of
 * them, and the failure is invisible: the same interview is a `must` in
 * WhatsApp and a `have_to` in the app, and nothing crashes.
 *
 * So this reads the PYTHON file directly and asserts the tables agree —
 * categories, order, keywords, priorities and durations. Same approach as
 * run-clash-parity and run-language-parity.
 *
 * Run:  npx tsx tests/run-categorize-parity.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { inferFromText, hasKeyword, DEFAULT_DURATIONS } from '../src/utils/categorize';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const py = readFileSync(join(__dirname, '..', 'server', 'categorize.py'), 'utf8');

/**
 * The oracle for "which rule owns this text": the Python rule, written HERE as a
 * regex so it shares no code with the loop in src/utils/categorize.ts. A keyword
 * must start a word - preceded by nothing, by a non-letter, or by up to two Hebrew
 * prefix letters (בלמהושכ) that themselves start the word - and a keyword ending in
 * a digit must not run on into more digits. The END of a keyword is open.
 */
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function oracleHas(text: string, kw: string): boolean {
  const re = new RegExp(
    `(?:^|[^a-z0-9\\u05d0-\\u05ea])[בלמהושכ]{0,2}${escapeRe(kw.toLowerCase())}${/[0-9]$/.test(kw) ? '(?![0-9])' : ''}`);
  return re.test(text.toLowerCase());
}

// ── the Python rule table, parsed out of the source ────────────────────────
const rulesBlock = py.slice(py.indexOf('_RULES'), py.indexOf(']\n\n', py.indexOf('_RULES')));
type PyRule = { cat: string; keywords: string[]; priority: string; duration: number };
const pyRules: PyRule[] = [];
for (const m of rulesBlock.matchAll(/\("([a-z_]+)",\s*\[([\s\S]*?)\],\s*"([a-z_]+)",\s*(\d+)\)/g)) {
  pyRules.push({
    cat: m[1],
    keywords: [...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]),
    priority: m[3],
    duration: Number(m[4]),
  });
}

console.log('\nThe Python table\n');
check('the rule table was parsed at all', pyRules.length > 0, `${pyRules.length} rules`);
check('every category in the spec is present', pyRules.length === 13, `${pyRules.length}`);

// ── durations ──────────────────────────────────────────────────────────────
console.log('\nDefault durations agree\n');
const pyDurations = py.slice(py.indexOf('DEFAULT_DURATIONS'), py.indexOf('}', py.indexOf('DEFAULT_DURATIONS')));
let durationMismatch: string[] = [];
for (const m of pyDurations.matchAll(/"([a-z_]+)":\s*(\d+)/g)) {
  const [, cat, mins] = m;
  const ours = (DEFAULT_DURATIONS as Record<string, number>)[cat];
  if (ours !== Number(mins)) durationMismatch.push(`${cat}: py=${mins} ts=${ours}`);
}
check('every default duration matches', durationMismatch.length === 0,
  durationMismatch.join(', ') || 'all 14');

// ── every keyword lands on the same category, in the same order ────────────
console.log('\nEvery keyword lands the same way\n');
const wrong: string[] = [];
let tested = 0;
for (const rule of pyRules) {
  for (const kw of rule.keywords) {
    tested += 1;
    const got = inferFromText(kw);
    // The FIRST rule that matches wins in both. A keyword belonging to a later
    // rule may legitimately be claimed by an earlier one ("training" is in gym,
    // but a title containing "interview" would win) — so the expectation is
    // what the Python table itself would produce for that bare keyword.
    const expected = pyRules.find((r) => r.keywords.some((k) => oracleHas(kw, k)))!;
    if (got.category !== expected.cat) {
      wrong.push(`"${kw}" → ts=${got.category} py=${expected.cat}`);
    }
  }
}
check('every keyword in the Python table maps identically',
  wrong.length === 0, wrong.slice(0, 6).join(' | ') || `${tested} keywords`);

// ── priorities ─────────────────────────────────────────────────────────────
console.log('\nPriorities and durations agree per rule\n');
const priWrong: string[] = [];
for (const rule of pyRules) {
  // Use the rule's own first keyword, which by construction cannot be claimed
  // by an earlier rule unless the tables genuinely disagree.
  const probe = rule.keywords[0];
  const got = inferFromText(probe);
  const owner = pyRules.find((r) => r.keywords.some((k) => oracleHas(probe, k)))!;
  if (owner.cat !== rule.cat) continue; // claimed earlier in BOTH — fine
  if (got.priority !== rule.priority) priWrong.push(`${rule.cat}: ts=${got.priority} py=${rule.priority}`);
  if (got.durationMinutes !== rule.duration) priWrong.push(`${rule.cat}: ts=${got.durationMinutes}m py=${rule.duration}m`);
}
check('priority and duration match for every rule', priWrong.length === 0,
  priWrong.join(' | ') || `${pyRules.length} rules`);

// ── the override words ─────────────────────────────────────────────────────
console.log('\nUrgency overrides agree\n');
const pyMust = py.slice(py.indexOf('_MUST = re.compile'), py.indexOf('_NICE'));
const mustWords = [...pyMust.matchAll(/[|(]r?"?([a-zA-Z֐-׿ ]{3,})/g)]
  .map((m) => m[1].trim())
  .filter((w) => w && !w.startsWith('re.'));
const missMust = mustWords.filter((w) => inferFromText(`${w} something`).priority !== 'must');
check('every _MUST word raises priority to must on our side too',
  missMust.length === 0, missMust.join(', ') || `${mustWords.length} words`);

check('a plain task is untouched by either override',
  inferFromText('buy milk').priority === 'need_to',
  inferFromText('buy milk').priority);

// ── a workout is never work (15.10) ────────────────────────────────────────
console.log('\nA workout is a workout in every spelling\n');
const workouts = ['אימון', 'אימונים', 'work out', 'Work out at the gym', 'working out',
  'אימון · יגאל אלון 76', 'להתאמן', 'אני מתאמנת'];
const notGym = workouts.filter((w) => inferFromText(w).category !== 'gym');
check('every spelling of a workout is gym on the phone', notGym.length === 0,
  notGym.join(', ') || `${workouts.length} spellings`);
const pyGym = pyRules.find((r) => r.cat === 'gym')!;
const missingOnServer = ['work out', 'working out', 'אימונ', 'להתאמן', 'מתאמנ']
  .filter((k) => !pyGym.keywords.includes(k));
check('and the Python gym rule carries the same words', missingOnServer.length === 0,
  missingOnServer.join(', ') || 'same');
check('gym sits above work in the Python table',
  pyRules.findIndex((r) => r.cat === 'gym') < pyRules.findIndex((r) => r.cat === 'work'));


// ── the same hand-labelled answers the Python test checks ──────────────────
console.log('\nBoth sides give the hand-labelled answer (tests/fixtures/categorize-golden.json)\n');
const golden: { cases: Array<{ text: string; category: string; priority: string }> } =
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'categorize-golden.json'), 'utf8'));
const goldenWrong: string[] = [];
for (const c of golden.cases) {
  const got = inferFromText(c.text);
  if (got.category !== c.category || got.priority !== c.priority) {
    goldenWrong.push(`"${c.text}" → ${got.category}/${got.priority} expected ${c.category}/${c.priority}`);
  }
}
check('every golden case is labelled as written', goldenWrong.length === 0,
  goldenWrong.slice(0, 5).join(' | ') || `${golden.cases.length} cases`);

// ── a keyword starts a word (the substring bug, 15.10) ──────────────────────
console.log('\nA keyword has to start a word\n');
const inside: Array<[string, string]> = [
  ['דחוף לשלוח', 'חוף'], ['brunch', 'run'], ['bring', 'ring'], ['recall', 'call'],
  ['headphones', 'phone'], ['async', 'sync'], ['11:15', '1:1'], ['1:15', '1:1'],
];
const wronglyFound = inside.filter(([t, k]) => hasKeyword(t, k));
check('a keyword inside a longer word is not found', wronglyFound.length === 0,
  wronglyFound.map(([t, k]) => `${k} in ${t}`).join(', ') || `${inside.length} cases`);
const starts: Array<[string, string]> = [
  ['run', 'run'], ['running late', 'run'], ['בחוף', 'חוף'], ['מהחוף', 'חוף'], ['ולחוף', 'חוף'],
  ['אימונים', 'אימונ'], ['meeting 1:1', '1:1'], ['brunch then run', 'run'],
];
const wronglyMissed = starts.filter(([t, k]) => !hasKeyword(t, k));
check('a keyword that starts a word, with up to two Hebrew prefixes, is found', wronglyMissed.length === 0,
  wronglyMissed.map(([t, k]) => `${k} in ${t}`).join(', ') || `${starts.length} cases`);
check('three prefix letters are not a word we know', !hasKeyword('ושבחוף', 'חוף'));

console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
