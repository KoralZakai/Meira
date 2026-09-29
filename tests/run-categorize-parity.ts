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
import { inferFromText, DEFAULT_DURATIONS } from '../src/utils/categorize';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const py = readFileSync(join(__dirname, '..', 'server', 'categorize.py'), 'utf8');

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
    const expected = pyRules.find((r) =>
      r.keywords.some((k) => kw.toLowerCase().includes(k.toLowerCase())))!;
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
  const owner = pyRules.find((r) =>
    r.keywords.some((k) => probe.toLowerCase().includes(k.toLowerCase())))!;
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

console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
