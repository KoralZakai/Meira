/**
 * run-route-failure — "why no route for the chosen way of getting there?"
 *
 * The answer was that the app did not know. One sentence was printed for six
 * unrelated causes, and Google's own `status` field — which has always said
 * which one — was never read by any line of this codebase.
 *
 * Her Google Cloud console, one day, her project:
 *
 *     Directions API      107 requests    99% errors    9 ms median
 *     Maps SDK for Android  3 requests     0% errors
 *     Google Calendar API 2,021 requests   0% errors
 *
 * Every Directions call rejected, instantly, while the card said there was no
 * train. This file is the test that would have caught that: it asserts that a
 * REQUEST_DENIED can never be rendered as a statement about transport.
 *
 * Pure — no network, no device, no Expo runtime.
 *   npx tsx tests/run-route-failure.ts
 */
import {
  RouteFailure, RouteFailureKind, classifyDirectionsStatus, networkFailure,
  worstFailure, isAboutTransport, describeRouteFailure, failureLogLine,
} from '../src/utils/routeFailure';
import { describeTravelRow, travelRowState } from '../src/utils/travelRowState';
import { Task } from '../src/types/index';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const section = (s: string) => console.log(`\n${s}`);

const ALL_KINDS: RouteFailureKind[] = [
  'no_key', 'no_origin', 'bad_time', 'denied', 'over_limit',
  'not_found', 'invalid', 'network', 'no_service', 'unknown',
];

// ── 1. Every Google status maps to the right kind ──────────────────────────
section('1. Google status → cause');

const CASES: Array<[string, RouteFailureKind]> = [
  ['ZERO_RESULTS', 'no_service'],
  ['REQUEST_DENIED', 'denied'],
  ['OVER_QUERY_LIMIT', 'over_limit'],
  ['OVER_DAILY_LIMIT', 'over_limit'],
  ['NOT_FOUND', 'not_found'],
  ['INVALID_REQUEST', 'invalid'],
  ['MAX_ROUTE_LENGTH_EXCEEDED', 'invalid'],
  ['MAX_WAYPOINTS_EXCEEDED', 'invalid'],
  ['SOMETHING_NEW', 'unknown'],
];
for (const [status, kind] of CASES) {
  const f = classifyDirectionsStatus(status, undefined, 'rail');
  ok(f?.kind === kind, `${status} → ${kind} (got ${f?.kind})`);
  ok(f?.status === status, `${status} is carried through verbatim`);
}

ok(classifyDirectionsStatus('OK') === null, 'OK is not a failure');
ok(classifyDirectionsStatus('ok') === null, 'a lowercase ok is still not a failure');

// The real rejection, word for word from her console's Directions responses.
const denied = classifyDirectionsStatus(
  'REQUEST_DENIED',
  'This IP, site or mobile application is not authorized to use this API key.',
  'rail',
);
ok(denied?.kind === 'denied', 'the REAL rejection classifies as denied');
ok(
  (denied?.detail ?? '').includes('not authorized'),
  'Google\'s own error_message survives — it names the fix',
);

// ── 2. THE BUG: a rejection must never read as a fact about transport ──────
section('2. a refused key is not a missing train');

for (const kind of ALL_KINDS) {
  const f: RouteFailure = { kind };
  ok(
    isAboutTransport(f) === (kind === 'no_service'),
    `only no_service is a claim about transport (${kind})`,
  );
}

for (const lang of ['he', 'en'] as const) {
  const deniedText = describeRouteFailure({ kind: 'denied' }, lang).text;
  const noneText = describeRouteFailure({ kind: 'no_service' }, lang).text;
  ok(deniedText !== noneText, `[${lang}] denied and no_service do not share a sentence`);
  // The exact regression: the old string claimed there was no route by the
  // chosen mode. A denial must not say anything of the kind.
  ok(
    !/תחבורה|transport|רכבת|train|אוטובוס|bus/i.test(deniedText),
    `[${lang}] a denial says nothing about buses or trains`,
  );
  ok(
    /REQUEST_DENIED/.test(deniedText),
    `[${lang}] a denial names the status, so it can be searched for`,
  );
}

// ── 3. Every kind is distinguishable, in BOTH languages ────────────────────
section('3. ten causes, ten sentences, two languages');

for (const lang of ['he', 'en'] as const) {
  const seen = new Map<string, RouteFailureKind>();
  for (const kind of ALL_KINDS) {
    const d = describeRouteFailure({ kind }, lang);
    ok(d.text.trim().length > 0, `[${lang}] ${kind} has a sentence`);
    const clash = seen.get(d.text);
    ok(clash === undefined, `[${lang}] ${kind} does not reuse ${clash}'s sentence`);
    seen.set(d.text, kind);
  }
  ok(seen.size === ALL_KINDS.length, `[${lang}] all ${ALL_KINDS.length} sentences are distinct`);
}

// Language parity: the same kinds are actionable in both languages, or the
// Hebrew user gets a button the English one does not. See lumi-language-parity.
for (const kind of ALL_KINDS) {
  const he = describeRouteFailure({ kind }, 'he');
  const en = describeRouteFailure({ kind }, 'en');
  ok(he.fixable === en.fixable, `${kind}: same fixability in both languages`);
  ok(
    Boolean(he.action) === Boolean(en.action),
    `${kind}: an action in one language means an action in the other`,
  );
  ok(he.fixable === Boolean(he.action), `${kind}: fixable ⇔ there is an action to offer`);
}

// Nothing she can do from the phone must not pretend otherwise.
for (const kind of ['no_key', 'denied', 'over_limit'] as RouteFailureKind[]) {
  ok(!describeRouteFailure({ kind }, 'he').action, `${kind} offers no useless button (he)`);
  ok(!describeRouteFailure({ kind }, 'en').action, `${kind} offers no useless button (en)`);
}

// ── 4. The worst of several parallel answers wins ──────────────────────────
section('4. three queries, one honest verdict');

ok(
  worstFailure([
    { kind: 'no_service' }, { kind: 'no_service' }, { kind: 'denied' },
  ])?.kind === 'denied',
  'two ZERO_RESULTS and one REQUEST_DENIED is NOT "there is no train"',
);
ok(
  worstFailure([{ kind: 'no_service' }, { kind: 'no_service' }])?.kind === 'no_service',
  'all three genuinely empty IS "there is no transport"',
);
ok(
  worstFailure([undefined, null, { kind: 'network' }])?.kind === 'network',
  'blanks are skipped, not ranked',
);
ok(worstFailure([]) === undefined, 'nothing in, nothing out');
ok(
  worstFailure([{ kind: 'over_limit' }, { kind: 'denied' }])?.kind === 'denied',
  'a refused key outranks an exhausted quota',
);

// ── 5. networkFailure keeps the message ────────────────────────────────────
section('5. a thrown error keeps its words');

const thrown = networkFailure(new Error('Network request failed'), 'bus');
ok(thrown.kind === 'network', 'a throw is a network failure');
ok(thrown.detail === 'Network request failed', 'the message survives');
ok(thrown.mode === 'bus', 'the mode asked for survives');
ok(networkFailure('plain string').detail === 'plain string', 'a non-Error is stringified');

// ── 6. The log line is greppable while standing at her phone ───────────────
section('6. the log line names everything');

const line = failureLogLine(
  { kind: 'denied', status: 'REQUEST_DENIED', detail: 'not authorized', mode: 'rail' },
  'Ceva, Ra\'anana',
);
for (const needle of ['denied', 'REQUEST_DENIED', 'rail', 'not authorized']) {
  ok(line.includes(needle), `the log line contains "${needle}"`);
}
ok(!line.includes('Ceva'), 'the log line does not name where she is going (7.10)');

// ── 7. End to end: the row renders the REASON, not the guess ───────────────
section('7. the row on her screen');

const located = (routeFailure?: RouteFailure): Task => ({
  id: 't1',
  text: 'Your in-person interview with Ceva',
  category: 'interview',
  priority: 'must',
  isFixed: true,
  fixedTime: '14:30',
  durationMinutes: 90,
  date: '2026-09-23',
  status: 'pending',
  createdAt: Date.now(),
  historicalDurations: [],
  location: {
    address: 'Ra\'anana', lat: 32.18, lng: 34.87, confirmed: true,
    noRouteForMode: 'train', routeFailure,
  },
} as unknown as Task);

ok(travelRowState(located()) === 'unroutable', 'a flagged task is unroutable');
ok(
  travelRowState(located({ kind: 'denied' })) === 'unroutable',
  'a recorded failure alone is enough to leave "pending"',
);

for (const he of [true, false]) {
  const generic = describeTravelRow('unroutable', he);
  const real = describeTravelRow('unroutable', he, { kind: 'denied', status: 'REQUEST_DENIED' });
  ok(!!generic && !!real, `[${he ? 'he' : 'en'}] both render something`);
  ok(generic!.text !== real!.text, `[${he ? 'he' : 'en'}] the reason replaces the guess`);
  ok(
    real!.text.includes('REQUEST_DENIED'),
    `[${he ? 'he' : 'en'}] the row shows what Google actually said`,
  );
  // And when the reason genuinely IS "no transport", it may say so.
  const none = describeTravelRow('unroutable', he, { kind: 'no_service' });
  ok(
    /תחבורה|transport/i.test(none!.text),
    `[${he ? 'he' : 'en'}] ZERO_RESULTS is still allowed to say there is none`,
  );
}

// A failure recorded while the state is 'no-time' must NOT override: a task
// with no hour was never routed, so any stored reason is from another life.
const noHour = { ...located({ kind: 'denied' }), fixedTime: undefined, scheduledTime: undefined } as Task;
ok(travelRowState(noHour) === 'no-time', 'no hour still wins over a stale reason');
ok(
  describeTravelRow('no-time', true, { kind: 'denied' })!.text.includes('שעה'),
  'the no-time row keeps asking for an hour, not for a key',
);

// ── done ───────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
