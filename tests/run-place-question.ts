/**
 * run-place-question — "Where is "Space Gym"?" (15.10, Koral's pick).
 *
 * A task whose place nobody could find used to stay a card with no pin, no
 * route and no word about why: GoogleSync's geocode returned null, logged one
 * warning, and went on. Now the place is looked up on the map and she is asked
 * which one it is. These pin each half with fakes and NO network:
 *
 *   - what is worth asking (online meetings, "home" are not),
 *   - what Places answered (≤3 real candidates; nothing found ≠ search broke),
 *   - the queue (once per task, the same name not twice a day, races),
 *   - the reason the card carries when nothing could be asked,
 *   - her answer: the location patch, the learned place, the FORCED re-plan,
 *     the record for the server, and every way it can fail.
 *
 *   npx tsx tests/run-place-question.ts
 */
import {
  applyPlace, ApplyDeps, askableText, candidatesFrom, EMPTY_QUEUE, enqueuePlace, EnqueueDeps, forgetPlace,
  keyOf, locationFromCandidate, placeQuery, PlaceQueue, PlaceStore, placeQuestionsFrom, questionOf, resendPlace,
  RETRY_FAILED_MS, RETRY_SEARCH_MS, unplacedFailure,
} from '../src/questions/kinds/place';
import { describeRouteFailure } from '../src/utils/routeFailure';
import type { MeiraQuestion, PlaceAnswerInput } from '../src/questions/types';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

// ── fakes ────────────────────────────────────────────────────────────────────
const memoryStore = (): PlaceStore & { raw: PlaceQueue } => {
  const s = { raw: { items: {}, tried: {} } as PlaceQueue,
    async load() { return JSON.parse(JSON.stringify(s.raw)) as PlaceQueue; },
    async save(q: PlaceQueue) { s.raw = JSON.parse(JSON.stringify(q)); } };
  return s;
};

const HIT = (name: string, address: string, lat: number, lng: number) => ({ name, address, lat, lng });
const SPACE = [
  HIT('Space Gym Yigal Alon', 'Yigal Alon St 76, Tel Aviv-Yafo', 32.0699, 34.7943),
  HIT('Space Gym Ramat Gan', 'Jabotinsky St 12, Ramat Gan', 32.0846, 34.8078),
  HIT('Space Gym Herzliya', 'Sokolov St 5, Herzliya', 32.1664, 34.8447),
  HIT('Space Gym Haifa', 'HaNassi Blvd 3, Haifa', 32.7940, 34.9896),
];

const TASK = { id: 't-gym', text: 'אימון', date: '2026-10-16', fixedTime: '20:00', category: 'gym' };

function enqueueFixture(search: EnqueueDeps['search'], answered = new Set<string>(), clock = { t: 1_000_000 }) {
  const store = memoryStore();
  let searches = 0;
  const deps: EnqueueDeps = {
    store,
    search: async (q) => { searches += 1; return search(q); },
    isAnswered: async (k) => answered.has(k),
    now: () => clock.t,
  };
  return { deps, store, clock, searches: () => searches };
}

(async () => {
  console.log('\nWhat is worth asking\n');
  check('"Space Gym" is askable', askableText('Space Gym', TASK).ok);
  for (const text of ['Zoom', 'Microsoft Teams Meeting', 'https://zoom.us/j/123', 'online', 'בזום']) {
    const r = askableText(text, TASK);
    check(`"${text}" is an online meeting, not a place`, !r.ok && r.why === 'online', JSON.stringify(r));
  }
  for (const text of ['home', 'בבית', 'at home', 'TBD']) {
    const r = askableText(text, TASK);
    check(`"${text}" is not somewhere to look up`, !r.ok && r.why === 'not_a_place', JSON.stringify(r));
  }
  check('an empty place is not askable', askableText('  ', TASK).ok === false);
  check('a task that carries a meeting link is remote, whatever its place text says',
    (askableText('Space Gym', { meetingUrl: 'https://zoom.us/j/123' }) as any).why === 'online');

  console.log('\nWhat is asked of the map\n');
  check('her words get her home city', placeQuery('Space Gym', 'אימון', 'Rothschild 12, תל אביב') === 'Space Gym, תל אביב',
    placeQuery('Space Gym', 'אימון', 'Rothschild 12, תל אביב'));
  check('…but the town the EVENT names comes first',
    placeQuery('Technion Gate', 'ראיון - חיפה', 'Rothschild 12, תל אביב') === 'Technion Gate, חיפה');
  check('a text that names a town is left alone', placeQuery('Space Gym הרצליה', 'x', 'a 1, תל אביב') === 'Space Gym הרצליה');
  check('a segmented address is left alone', placeQuery('Sokolov 5, Herzliya', 'x', 'a 1, תל אביב') === 'Sokolov 5, Herzliya');
  check('with no town to lend, the words go as they are', placeQuery('Space Gym', 'x', '') === 'Space Gym');

  console.log('\nWhat Places answered\n');
  const found = candidatesFrom(SPACE);
  check('at most three', found.length === 3, String(found.length));
  check('best first, nothing reordered', found[0].name === 'Space Gym Yigal Alon');
  check('0,0 is "unknown", never a candidate',
    candidatesFrom([HIT('Nowhere', 'x', 0, 0), HIT('Real', 'Y St 1', 32, 34)]).map((c) => c.name).join() === 'Real');
  check('a hit with no name is dropped, with no address it uses the name',
    candidatesFrom([HIT('', 'a', 32, 34), HIT('Only Name', '', 32.1, 34.1)]).map((c) => c.address).join() === 'Only Name');
  check('the same spot twice is one row',
    candidatesFrom([HIT('Gym', 'a', 32.0001, 34.0001), HIT('Gym again', 'a', 32.0001, 34.0001)]).length === 1);
  check('junk in, nothing out', candidatesFrom(null).length === 0 && candidatesFrom([{} as any]).length === 0);

  console.log('\nThe queue: once per task, and never silent\n');
  {
    // 3+ hits → queued once.
    const f = enqueueFixture(async () => SPACE);
    const first = await enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: 'a 1, תל אביב' });
    check('three hits → the question is queued', first.outcome === 'queued', first.outcome);
    const q = (first as any).question as MeiraQuestion;
    check('…keyed place:<taskId>, kind place', q.key === 'place:t-gym' && q.kind === 'place' && q.subject === 't-gym', q.key);
    check('…worded in both languages, with her words',
      q.ask.en === 'Where is "Space Gym"?' && q.ask.he === 'איפה "Space Gym"?', JSON.stringify(q.ask));
    check('…carrying the task, the day, the query and ≤3 candidates',
      q.place?.taskId === 't-gym' && q.place?.date === '2026-10-16' && q.place?.query === 'Space Gym, תל אביב'
      && q.place?.candidates.length === 3, JSON.stringify(q.place));
    check('…saying WHICH task asks and WHEN, since it may not be today (rule 4)',
      q.place?.taskText === 'אימון' && q.place?.date === '2026-10-16' && q.place?.time === '20:00', JSON.stringify(q.place));
    check('…and it is in the stored queue', Boolean(f.store.raw.items['t-gym']));
    const second = await enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: 'a 1, תל אביב' });
    check('asked again → "already", no second search', second.outcome === 'already' && f.searches() === 1,
      `${second.outcome} after ${f.searches()} searches`);
    check('exactly one question in the queue', Object.keys(f.store.raw.items).length === 1);
  }
  {
    // Nothing found → says so, and does not search again today.
    const f = enqueueFixture(async () => []);
    const a = await enqueuePlace(f.deps, { task: TASK, placeText: 'Qwxz Gym', homeAddress: '' });
    check('no hits → "no_hits" (not "queued", not silence)', a.outcome === 'no_hits', a.outcome);
    check('…nothing waits for her', Object.keys(f.store.raw.items).length === 0);
    const b = await enqueuePlace(f.deps, { task: TASK, placeText: 'Qwxz Gym', homeAddress: '' });
    check('…the same name is not searched again within a day', b.outcome === 'no_hits' && f.searches() === 1,
      `${b.outcome} / ${f.searches()}`);
    f.clock.t += RETRY_SEARCH_MS + 1;
    await enqueuePlace(f.deps, { task: TASK, placeText: 'Qwxz Gym', homeAddress: '' });
    check('…but is tomorrow', f.searches() === 2, String(f.searches()));
    await enqueuePlace(f.deps, { task: TASK, placeText: 'Qwxz Gym 2', homeAddress: '' });
    check('…and a CHANGED name is searched at once', f.searches() === 3, String(f.searches()));
  }
  {
    // The search itself broke → a different fact, and not remembered as tried.
    let broken = true;
    const f = enqueueFixture(async () => { if (broken) throw new Error('place search: signed out'); return SPACE; });
    const a = await enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: '' });
    check('a failed search says search_failed, with its reason',
      a.outcome === 'search_failed' && /signed out/.test((a as any).reason), JSON.stringify(a));
    check('…and is not mistaken for "no such place": only a short back-off is kept',
      f.store.raw.tried['t-gym']?.outcome === 'failed' && Object.keys(f.store.raw.items).length === 0);
    const again = await enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: '' });
    check('…a sweep a minute later does not hammer the endpoint, and still says why',
      again.outcome === 'search_failed' && f.searches() === 1 && /signed out/.test((again as any).reason),
      `${again.outcome} / ${f.searches()}`);
    broken = false;
    f.clock.t += RETRY_FAILED_MS + 1;
    const b = await enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: '' });
    check('…and after the back-off the next sweep asks, and it works', b.outcome === 'queued', b.outcome);
  }
  {
    const f = enqueueFixture(async () => SPACE, new Set([keyOf('t-gym')]));
    const a = await enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: '' });
    check('already answered (or "Something else") → never asked again, no search', a.outcome === 'already' && f.searches() === 0);
    const online = await enqueuePlace(enqueueFixture(async () => SPACE).deps, { task: TASK, placeText: 'Zoom', homeAddress: '' });
    check('an online meeting is skipped, with the reason', online.outcome === 'skipped' && (online as any).why === 'online');
  }
  {
    // Two sweeps at once: one question, not two.
    const f = enqueueFixture(async () => { await new Promise((r) => setTimeout(r, 5)); return SPACE; });
    const [x, y] = await Promise.all([
      enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: '' }),
      enqueuePlace(f.deps, { task: TASK, placeText: 'Space Gym', homeAddress: '' }),
    ]);
    check('two sweeps at once queue ONE question',
      Object.keys(f.store.raw.items).length === 1 && [x.outcome, y.outcome].sort().join() === 'already,queued',
      `${x.outcome},${y.outcome}`);
  }

  console.log('\nThe card says why (rule 1: nothing found ≠ the search broke)\n');
  const reasonOf = (o: any) => unplacedFailure(o, 5);
  check('no hits → not_found (the card already prints "Google cannot place this address")',
    reasonOf({ outcome: 'no_hits', query: 'x' })?.kind === 'not_found');
  check('…in both languages', /לא מזהה/.test(describeRouteFailure(reasonOf({ outcome: 'no_hits', query: 'x' })!, 'he').text)
    && /cannot place/.test(describeRouteFailure(reasonOf({ outcome: 'no_hits', query: 'x' })!, 'en').text));
  check('asked and waiting → the same reason, so the card is not blank while she decides',
    reasonOf({ outcome: 'queued', question: {} as any })?.kind === 'not_found');
  check('a failed search claims NOTHING about the address (not "cannot place", not a 📡 on every offline card)',
    reasonOf({ outcome: 'search_failed', reason: 'signed out' }) === undefined);
  check('…its reason travels in the outcome for the caller to log',
    (await enqueuePlace(enqueueFixture(async () => { throw new Error('place search: signed out'); }).deps,
      { task: TASK, placeText: 'Space Gym', homeAddress: '' }) as any).reason === 'place search: signed out');
  check('an online meeting claims nothing', reasonOf({ outcome: 'skipped', why: 'online' }) === undefined);
  check('every reason is stamped NO_PLACE so the route code can tell it from Google\'s own',
    reasonOf({ outcome: 'no_hits', query: 'x' })?.status === 'NO_PLACE');

  console.log('\nWhich queued questions are still true\n');
  {
    const base = enqueueFixture(async () => SPACE);
    await enqueuePlace(base.deps, { task: TASK, placeText: 'Space Gym', homeAddress: '' });
    const queue = base.store.raw;
    const live = { id: 't-gym', date: '2026-10-16', status: 'pending', location: 'Space Gym' };
    const run = (task: any, today = '2026-10-15') => placeQuestionsFrom(queue, task ? [task] : [], today);
    check('the task is still there, unplaced, same words → kept', run(live).questions.length === 1 && run(live).drop.length === 0);
    check('the task is gone → dropped', run(null).drop.join() === 't-gym');
    check('the task is done → dropped', run({ ...live, status: 'complete' }).drop.length === 1);
    check('its day has passed → dropped', run(live, '2026-10-17').drop.length === 1);
    check('she placed it herself (real coordinates) → dropped',
      run({ ...live, location: { address: 'Space Gym', lat: 32.07, lng: 34.79 } }).drop.length === 1);
    check('she rewrote the place → dropped (the candidates answer another question)',
      run({ ...live, location: 'Holmes Place' }).drop.length === 1);
    check('0,0 is still unplaced → kept',
      run({ ...live, location: { address: 'Space Gym', lat: 0, lng: 0 } }).questions.length === 1);
    await forgetPlace(base.store, 't-gym');
    check('forgetPlace takes it out of the queue', Object.keys(base.store.raw.items).length === 0);
  }

  console.log('\nHer answer: a row\n');
  const question: MeiraQuestion = questionOf({
    taskId: 't-gym', date: '2026-10-16', taskText: 'אימון', time: '20:00', query: 'Space Gym, תל אביב', placeText: 'Space Gym',
    candidates: candidatesFrom(SPACE),
  });
  const applyFixture = (over: Partial<ApplyDeps> = {}) => {
    const calls = {
      patched: [] as Array<Record<string, unknown>>, learned: [] as any[], replans: [] as any[],
      forgot: [] as string[], sent: [] as PlaceAnswerInput[],
    };
    const was = { address: 'Space Gym', confirmed: false, transportType: 'bike', transportTypeBy: 'her',
      transitPlan: { leaveHomeAt: '07:00' }, leaveHomeBy: '07:00', routeFailure: { kind: 'not_found' } };
    const deps: ApplyDeps = {
      findTask: async (id) => (id === 't-gym' ? { id, text: 'אימון', date: '2026-10-16' } : null),
      patchLocation: async (_id, build) => { calls.patched.push(build(was)); },
      learn: async (activity, address, coords) => { calls.learned.push({ activity, address, coords }); },
      replan: async (date, taskId) => { calls.replans.push({ date, taskId }); },
      forget: async (id) => { calls.forgot.push(id); },
      send: async (input) => { calls.sent.push(input); return { ok: true }; },
      ...over,
    };
    return { deps, calls };
  };
  {
    const { deps, calls } = applyFixture();
    const r = await applyPlace(question, { choice: 'pick', index: 1 }, deps);
    const loc = calls.patched[0];
    check('the pick lands: ok, saved on the phone', r.result.ok && r.result.savedLocally, JSON.stringify(r.result));
    check('the location is the picked row, confirmed',
      loc.address === 'Jabotinsky St 12, Ramat Gan' && loc.displayName === 'Space Gym Ramat Gan'
      && loc.lat === 32.0846 && loc.lng === 34.8078 && loc.confirmed === true, JSON.stringify(loc));
    check('the old route and its reason are cleared (the destination changed under them)',
      loc.transitPlan === undefined && loc.leaveHomeBy === undefined && loc.routeFailure === undefined && 'transitPlan' in loc);
    check('her choice of vehicle is kept', loc.transportType === 'bike' && loc.transportTypeBy === 'her');
    check('the place is LEARNED for the activity, with its coordinates',
      calls.learned.length === 1 && calls.learned[0].activity === 'אימון'
      && calls.learned[0].address === 'Jabotinsky St 12, Ramat Gan' && calls.learned[0].coords.lat === 32.0846);
    check('the chain is re-planned for THAT task, that day (forceTaskId)',
      calls.replans.length === 1 && calls.replans[0].date === '2026-10-16' && calls.replans[0].taskId === 't-gym');
    check('the question leaves the queue', calls.forgot.join() === 't-gym');
    check('the record for the server names the pick, the query and the task',
      calls.sent.length === 1 && calls.sent[0].kind === 'place' && calls.sent[0].subject === 't-gym'
      && calls.sent[0].line === 'אימון'
      && JSON.stringify(calls.sent[0].answer) === JSON.stringify({
        choice: 'pick', query: 'Space Gym, תל אביב', name: 'Space Gym Ramat Gan',
        address: 'Jabotinsky St 12, Ramat Gan', lat: 32.0846, lng: 34.8078 }), JSON.stringify(calls.sent[0]));
    check('✓ says what it did, in both languages, and does not promise a route',
      /Jabotinsky/.test(r.result.effect?.en ?? '') && /Jabotinsky/.test(r.result.effect?.he ?? '')
      && /Planning/.test(r.result.effect?.en ?? ''));
  }
  {
    // A plain-text location (hand-typed task) becomes a located one.
    const l = locationFromCandidate('Space Gym', question.place!.candidates[0]);
    check('a task whose location was only a string gets a full one',
      l.address === 'Yigal Alon St 76, Tel Aviv-Yafo' && l.lat === 32.0699 && l.confirmed === true, JSON.stringify(l));
  }
  {
    // The server is unreachable: saved here, waiting there — never "✓ saved".
    const { deps, calls } = applyFixture({ send: async () => ({ ok: false, reason: 'could not reach the server' }) });
    const r = await applyPlace(question, { choice: 'pick', index: 0 }, deps);
    check('offline: NOT ok, but saved on the phone and queued',
      !r.result.ok && r.result.savedLocally && r.result.queued === true && r.result.reason === 'offline', JSON.stringify(r.result));
    check('…the part to retry is the same record', r.retry?.kind === 'place' && r.retry?.subject === 't-gym');
    check('…the task WAS patched and re-planned regardless', calls.patched.length === 1 && calls.replans.length === 1);
    const unauth = await applyPlace(question, { choice: 'pick', index: 0 },
      applyFixture({ send: async () => ({ ok: false, reason: 'sign in again' }) }).deps);
    check('signed out: reported as auth and NOT retried blindly', unauth.result.reason === 'auth' && !unauth.retry);
  }
  {
    const gone = applyFixture({ findTask: async () => null });
    const r = await applyPlace(question, { choice: 'pick', index: 0 }, gone.deps);
    check('the task was deleted meanwhile: said, not "saved"', !r.result.ok && r.result.reason === 'task_gone', JSON.stringify(r.result));
    check('…nothing was patched, learned or planned', gone.calls.patched.length + gone.calls.learned.length + gone.calls.replans.length === 0);
    const bad = applyFixture({ patchLocation: async () => { throw new Error('disk full'); } });
    const w = await applyPlace(question, { choice: 'pick', index: 0 }, bad.deps);
    check('the task could not be written: reason local, nothing learned, nothing planned',
      !w.result.ok && w.result.reason === 'local' && bad.calls.learned.length === 0 && bad.calls.replans.length === 0);
    const out = await applyPlace(question, { choice: 'pick', index: 7 }, applyFixture().deps);
    check('a row that does not exist is refused', !out.result.ok && out.result.reason === 'local');
    const boom = applyFixture({ replan: async () => { throw new Error('directions refused'); } });
    const b = await applyPlace(question, { choice: 'pick', index: 0 }, boom.deps);
    check('a failed re-plan does not undo the answer (the chain writes its own reason on the card)', b.result.ok);
  }

  console.log('\nHer answer: "Something else"\n');
  {
    const { deps, calls } = applyFixture();
    const r = await applyPlace(question, { choice: 'edit' }, deps);
    check('resolved as skipped/edit, ok, with a sentence that claims no save',
      r.result.ok && r.result.skipped === 'edit' && !r.result.savedLocally && Boolean(r.result.effect?.he), JSON.stringify(r.result));
    check('…the task is NOT touched, nothing learned, no route planned',
      calls.patched.length + calls.learned.length + calls.replans.length === 0);
    check('…the question leaves the queue, and the record says "edit"',
      calls.forgot.join() === 't-gym' && (calls.sent[0]?.answer as any)?.choice === 'edit');
    const off = applyFixture({ send: async () => ({ ok: false, reason: 'timed out' }) });
    const o = await applyPlace(question, { choice: 'edit' }, off.deps);
    check('even offline it is skipped, and the record waits in the outbox', o.result.ok && o.result.queued === true && o.retry?.kind === 'place');
  }

  console.log('\nThe outbox\n');
  const input = { kind: 'place', subject: 't-gym', line: 'אימון', answer: { choice: 'edit', query: 'x' }, rewrite_told: false } as PlaceAnswerInput;
  check('sent → done', (await resendPlace(input, async () => ({ ok: true }))) === 'done');
  check('no connection → retry', (await resendPlace(input, async () => ({ ok: false, reason: 'could not reach' }))) === 'retry');
  check('server error → retry', (await resendPlace(input, async () => ({ ok: false, reason: 'HTTP 500' }))) === 'retry');
  check('signed out → dropped, not hammered', (await resendPlace(input, async () => ({ ok: false, reason: 'sign in again' }))) === 'drop');
  check('a throw is a retry, not a crash', (await resendPlace(input, async () => { throw new Error('boom'); })) === 'retry');

  check('EMPTY_QUEUE is empty', Object.keys(EMPTY_QUEUE.items).length === 0 && Object.keys(EMPTY_QUEUE.tried).length === 0);

  console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
  if (failures) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
