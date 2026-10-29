/**
 * run-focus-bypass — "📚 You said you were studying!!"
 *
 * Koral, 17.10: "If the user defined a learning time but somehow BYPASSES the restriction, Meira
 * lectures her … and gives her further opportunities to return to her studies and block out
 * distractions."
 *
 * Four ways to bypass, each its own typed kind: a permission revoked mid-session, the service
 * killed while the session was still inside its window, a blocked app used anyway (measured from
 * UsageStatsManager, browsers reported neutrally), and an early end (gentler). The lecture is short
 * and always offers a way back: resume with the block re-armed, a 5-minute break then auto-resume,
 * move the rest to a free time, done for today.
 *
 * Part A drives the pure rules (utils/focusBypass) in both languages. Part B runs the real services
 * (FocusSessionService, FocusBypassService, TaskStorage) against a FAKE native module and an
 * in-memory store — no device — to prove incidents become pending lectures, an answer does what
 * its label says, a handled lecture never comes back, and a failed answer keeps the lecture up.
 *
 * Run:  npx tsx tests/run-focus-bypass.ts
 */

// ── fakes, installed before any service is imported ────────────────────────
const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) { store.set(k, v); },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};

const sentNotifications: Array<{ title: string; body: string; data?: any }> = [];
const mockNotifications = {
  sendImmediate: async (title: string, body: string, data?: any) => { sentNotifications.push({ title, body, data }); },
  armTaskAlerts: async () => {},
  cancelTaskNotifications: async () => {},
};

const appState = { currentState: 'active' as string };
const mockReactNative = {
  AppState: { get currentState() { return appState.currentState; }, addEventListener: () => ({ remove() {} }) },
};

/** A fake native module: whatever the Kotlin would report, set by the scenario. */
const native = {
  available: true,
  perms: { usageAccess: true, overlay: true, notifications: true },
  incidents: [] as any[],
  scheduled: new Map<string, any>(),
  started: [] as any[],
  session: null as any,
  reconcileState: 'none',
  opened: [] as string[],
};
const ok = (extra: object = {}) => ({ ok: true as const, ...extra });
const fakeFocusGuard = {
  isAvailable: () => native.available,
  unavailableDetail: () => (native.available ? null : 'fake'),
  permissions: () => (native.available
    ? { native: true, ...native.perms }
    : { native: false, usageAccess: false, overlay: false, notifications: false, reason: 'native_unavailable' }),
  openUsageAccessSettings: () => { native.opened.push('usage'); return ok(); },
  openOverlaySettings: () => { native.opened.push('overlay'); return ok(); },
  installedPackages: (p: string[]) => ok({ installed: p }),
  startSession: (o: any) => {
    if (!native.perms.usageAccess) return { ok: false, reason: 'no_usage_access' };
    if (!native.perms.overlay) return { ok: false, reason: 'no_overlay' };
    native.started.push(o);
    return ok({ id: o.sessionId ?? 'manual-1', endsAtMs: o.endsAtMs });
  },
  stopSession: () => ok(),
  endSessionEarly: () => ok(),
  getSession: () => ok({ active: Boolean(native.session), session: native.session ?? undefined, serviceRunning: true, warn: null }),
  lastSession: () => ok({ last: null }),
  scheduleSession: (e: any) => {
    const old = native.scheduled.get(e.id);
    if (old && old.sig === e.sig) return ok({ already: true });
    native.scheduled.set(e.id, { ...e, fired: false });
    return ok();
  },
  cancelScheduled: (id: string) => { native.scheduled.delete(id); return ok(); },
  listScheduled: () => ok({ entries: [...native.scheduled.values()] }),
  drainIncidents: () => { const i = native.incidents; native.incidents = []; return ok({ incidents: i }); },
  reconcile: () => ok({ state: native.reconcileState }),
  usageSummary: async () => ok({ apps: [] }),
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === 'react-native') return mockReactNative;
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
    return { __esModule: true, default: memoryAsyncStorage };
  }
  if (request === './supabaseClient' || request.endsWith('/supabaseClient')) {
    return { __esModule: true, isSupabaseConfigured: false, supabase: null };
  }
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return { __esModule: true, getUserId: async () => null };
  }
  if (request.endsWith('/NotificationService')) return mockNotifications;
  if (request.endsWith('modules/focus-guard')) return { __esModule: true, FocusGuard: fakeFocusGuard, default: fakeFocusGuard };
  return origLoad.call(this, request, ...rest);
};

import type { Task } from '../src/types/index';
import type { NativeIncident, SessionSnapshot } from '../modules/focus-guard';
import {
  BREAK_MINUTES, BROWSER_PACKAGES, LECTURE_TTL_MS, SLIP_THRESHOLD_MS, appendLog, breakPlan, eventsFromIncidents,
  lectureFor, logEntryFor, pickEvent, remainingMinutes, resumePlan, slipLine, slipReport, suggestMoveTarget,
  weeklyLine, weeklySummary, whenLabel, type BypassEvent, type BypassLogEntry,
} from '../src/utils/focusBypass';
import { hhmmOf, parseLocalMs } from '../src/utils/focusSession';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskStorage = require('../src/services/TaskStorage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Bypass = require('../src/services/FocusBypassService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Session = require('../src/services/FocusSessionService');

let checks = 0;
let failures = 0;
function check(label: string, ok2: boolean, detail = '') {
  checks += 1;
  if (!ok2) failures += 1;
  console.log(`  ${ok2 ? '✓' : '✗'} ${label}${ok2 || !detail ? '' : `  — ${detail}`}`);
}

const at = (date: string, hhmm: string) => parseLocalMs(date, hhmm)!;
const DAY = '2026-10-17';
const MIN = 60_000;

const IG = 'com.instagram.android';
const WA = 'com.whatsapp';
const TT1 = 'com.zhiliaoapp.musically';
const TT2 = 'com.ss.android.ugc.trill';
const BLOCKED = [IG, WA, TT1, TT2];

/** A session 19:00–19:45 that Koral started at 19:00 (taskId optional). */
const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: 'study-t1', title: 'Study for the exam', lang: 'he', blocked: BLOCKED,
  startedAtMs: at(DAY, '19:00'), endsAtMs: at(DAY, '19:45'), taskId: null, ...over,
});
const incident = (over: Partial<NativeIncident> & { kind: NativeIncident['kind'] }): NativeIncident => ({
  atMs: at(DAY, '19:22'), session: snap(), ...over,
});
const event = (over: Partial<NativeIncident> & { kind: NativeIncident['kind'] }): BypassEvent =>
  eventsFromIncidents([incident(over)])[0];

async function main() {
  console.log('\nA1. Incidents → events: one per session per kind, unknown kinds dropped\n');
  {
    const kinds: Array<[NativeIncident['kind'], string]> = [
      ['permission_revoked', 'permission_revoked'], ['block_failed', 'block_failed'], ['killed', 'service_killed'],
      ['ended_early', 'ended_early'], ['slipped', 'slipped'],
    ];
    for (const [k, want] of kinds) check(`${k} → ${want}`, event({ kind: k }).kind === want);
    check('an incident from a newer native than this JS is dropped, not guessed at',
      eventsFromIncidents([{ ...incident({ kind: 'slipped' }), kind: 'telepathy' as any }]).length === 0);
    check('a malformed incident (no session) is dropped',
      eventsFromIncidents([{ kind: 'slipped', atMs: 1 } as any]).length === 0);
    const dup = eventsFromIncidents([incident({ kind: 'slipped' }), incident({ kind: 'slipped', atMs: at(DAY, '19:30') })]);
    check('the same kind twice in one session → one event', dup.length === 1);
    const two = eventsFromIncidents([incident({ kind: 'permission_revoked', permission: 'usage' }), incident({ kind: 'permission_revoked', permission: 'overlay' })]);
    check('usage and overlay revoked are two events (different fixes)', two.length === 2);
    const next = eventsFromIncidents([incident({ kind: 'slipped', session: snap({ startedAtMs: at(DAY, '21:00'), endsAtMs: at(DAY, '21:45') }) }), incident({ kind: 'slipped' })]);
    check('the same task studied again later is a new session, a new event', next.length === 2);
  }

  console.log('\nA2. Slips: more than a minute in a blocked app; browsers reported, never judged\n');
  {
    const ms = (n: number) => n * MIN;
    check('exactly 60 s is not a slip', slipReport([{ pkg: IG, ms: SLIP_THRESHOLD_MS }], BLOCKED) === null);
    check('60 s and a moment is', slipReport([{ pkg: IG, ms: SLIP_THRESHOLD_MS + 1 }], BLOCKED) !== null);
    const r = slipReport([{ pkg: IG, ms: ms(12) }, { pkg: WA, ms: ms(5) }, { pkg: 'com.android.chrome', ms: ms(9) }, { pkg: 'com.duolingo', ms: ms(30) }], BLOCKED)!;
    check('blocked apps counted (12 + 5), sorted by time', r.apps.map((a) => `${a.appId}:${a.minutes}`).join() === 'instagram:12,whatsapp:5');
    check('...the browser minutes reported separately (9)', r.browserMinutes === 9);
    check('...an app that is not blocked (Duolingo) is nobody\'s business', !r.apps.some((a) => a.pkg === 'com.duolingo'));
    check('TikTok\'s two packages are one app', slipReport([{ pkg: TT1, ms: ms(2) }, { pkg: TT2, ms: ms(3) }], BLOCKED)!.apps.length === 1
      && slipReport([{ pkg: TT1, ms: ms(2) }, { pkg: TT2, ms: ms(3) }], BLOCKED)!.apps[0].minutes === 5);
    check('browser time alone is never a lecture', slipReport([{ pkg: 'com.android.chrome', ms: ms(40) }], BLOCKED) === null);
    check('no usage → null (and the native "could not measure" is a separate flag)', slipReport(undefined, BLOCKED) === null && slipReport([], BLOCKED) === null);
    check('Chrome and Samsung Internet are on the browser list', BROWSER_PACKAGES.includes('com.android.chrome') && BROWSER_PACKAGES.includes('com.sec.android.app.sbrowser'));

    const rep = slipReport([{ pkg: IG, ms: ms(12) }], BLOCKED)!;
    check('line (he): 12 דק׳ באינסטגרם', slipLine(rep, 'he') === '12 דק׳ באינסטגרם', slipLine(rep, 'he'));
    check('line (en): 12 min on Instagram', slipLine(rep, 'en') === '12 min on Instagram');
    check('two apps (he)', slipLine(r, 'he') === '12 דק׳ באינסטגרם, 5 דק׳ בוואטסאפ · ועוד 9 דק׳ בדפדפן', slipLine(r, 'he'));
    check('two apps (en), browser neutral', slipLine(r, 'en') === '12 min on Instagram, 5 min on WhatsApp · plus 9 min in the browser', slipLine(r, 'en'));
  }

  console.log('\nA3. The lecture, kind by kind — short, in both languages\n');
  {
    const now = at(DAY, '19:22'); // 23 minutes before 19:45
    check('remaining minutes round UP (22 min 10 s left = 23)', remainingMinutes(snap(), at(DAY, '19:22') + 50_000) === 23 && remainingMinutes(snap(), now) === 23);
    check('...and never go negative', remainingMinutes(snap(), at(DAY, '20:30')) === 0);

    const revoked = lectureFor(event({ kind: 'permission_revoked', permission: 'usage' }), now, 'he', {})!;
    check('revoked (he): title "📚 אמרת שאת לומדת!!", body "כיבית את החסימה."', revoked.title === '📚 אמרת שאת לומדת!!' && revoked.body === 'כיבית את החסימה.');
    const revokedEn = lectureFor(event({ kind: 'permission_revoked', permission: 'overlay' }), now, 'en', {})!;
    check('revoked (en): "You said you were studying!!" / "You turned the block off."', revokedEn.title === '📚 You said you were studying!!' && revokedEn.body === 'You turned the block off.');
    check('...it says WHICH switch (usage vs overlay)', /usage/i.test(lectureFor(event({ kind: 'permission_revoked', permission: 'usage' }), now, 'en')!.hint!)
      && /overlay|other apps/i.test(revokedEn.hint!));
    check('it is a lecture', revoked.tone === 'lecture');

    const killed = lectureFor(event({ kind: 'killed', minutesLeft: 30 }), now, 'he')!;
    check('killed (he): the block stopped mid-session', killed.tone === 'lecture' && /נעצרה/.test(killed.body), killed.body);
    check('killed (en)', lectureFor(event({ kind: 'killed' }), now, 'en')!.body === 'The block stopped mid-session.');

    const slipped = lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] }), now, 'he')!;
    check('slipped (he): אמרת שאת לומדת!! + 12 דק׳ באינסטגרם', slipped.title === '📚 אמרת שאת לומדת!!' && slipped.body === '12 דק׳ באינסטגרם');
    check('slipped (en): You said you were studying!! + 12 min on Instagram',
      lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] }), now, 'en')!.body === '12 min on Instagram');
    check('a "slip" no blocked app backs up has nothing to say', lectureFor(event({ kind: 'slipped', usage: [{ pkg: 'com.android.chrome', ms: 20 * MIN }] }), now, 'he') === null);

    const early = lectureFor(event({ kind: 'ended_early', minutesLeft: 23 }), at(DAY, '19:22'), 'he')!;
    check('ended early (he): gentle — "אמרת שתלמדי עד 19:45 — נשארו 23 דק׳"', early.tone === 'gentle' && early.body === 'אמרת שתלמדי עד 19:45 — נשארו 23 דק׳', early.body);
    check('ended early (en): "You said you\'d study until 19:45 — 23 min left"', lectureFor(event({ kind: 'ended_early' }), now, 'en')!.body === "You said you'd study until 19:45 — 23 min left");
    check('...it is not titled as a lecture', !/!!/.test(early.title));
    check('ended early with 3 minutes left → nothing to say', lectureFor(event({ kind: 'ended_early' }), at(DAY, '19:42'), 'he') === null);

    const failed = lectureFor(event({ kind: 'block_failed' }), now, 'he')!;
    check('block_failed is not hers: gentle, and says what to allow', failed.tone === 'gentle' && /הצגה מעל/.test(failed.body));
    check('a lecture older than 12 h is stale', lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 9 * MIN }] }), at(DAY, '19:22') + LECTURE_TTL_MS + 1, 'he') === null);

    for (const lang of ['he', 'en'] as const) {
      for (const k of ['permission_revoked', 'killed', 'slipped', 'ended_early', 'block_failed'] as const) {
        const l = lectureFor(event({ kind: k, usage: [{ pkg: IG, ms: 9 * MIN }] }), now, lang)!;
        check(`${k} (${lang}): short — title ≤ 32 chars, body ≤ 90`, l.title.length <= 32 && l.body.length <= 90, `${l.title.length}/${l.body.length}`);
      }
    }
  }

  console.log('\nA4. The ways back — resume, break, move, done\n');
  {
    const now = at(DAY, '19:22');
    const move = { date: DAY, start: '21:00', end: '21:23', from: 'gap' as const };
    const l = lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] }), now, 'he', { moveTo: move })!;
    check('four offers, in order: resume, break, move, done', l.offers.map((o) => o.kind).join() === 'resume,break,move,done');
    check('resume (he): 📚 חזרה ללמידה — עוד 23 דק׳, חוסמת שוב', l.offers[0].label === '📚 חזרה ללמידה — עוד 23 דק׳, חוסמת שוב', l.offers[0].label);
    check('break (he): ☕ הפסקה של 5 דק׳ ואז ממשיכים', l.offers[1].label === '☕ הפסקה של 5 דק׳ ואז ממשיכים');
    check('move (he): 🕐 להעביר את השאר ל21:00', l.offers[2].label === '🕐 להעביר את השאר ל21:00', l.offers[2].label);
    check('done (he): סיימתי להיום', l.offers[3].label === 'סיימתי להיום');
    const en = lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] }), now, 'en', { moveTo: move })!;
    check('offers (en)', en.offers.map((o) => o.label).join(' | ')
      === '📚 Back to learning — 23 more min, blocking again | ☕ 5-min break, then we go on | 🕐 Move the rest to 21:00 | I\'m done for today', en.offers.map((o) => o.label).join(' | '));
    check('the offers carry the minutes they give back', l.offers.slice(0, 3).every((o) => o.minutes === 23) && l.offers[3].minutes === 0);

    // The remaining-minutes math at the edges.
    const at10 = lectureFor(event({ kind: 'permission_revoked', permission: 'usage' }), at(DAY, '19:35'), 'en', { moveTo: move })!;
    check('10 min left: still resume, break and move', at10.offers.map((o) => o.kind).join() === 'resume,break,move,done');
    const at9 = lectureFor(event({ kind: 'permission_revoked', permission: 'usage' }), at(DAY, '19:36'), 'en', { moveTo: move })!;
    check('9 min left: resume only (a break + move are not worth it)', at9.offers.map((o) => o.kind).join() === 'resume,done');
    const at3 = lectureFor(event({ kind: 'permission_revoked', permission: 'usage' }), at(DAY, '19:42'), 'en', { moveTo: move })!;
    check('3 min left: only "done"', at3.offers.map((o) => o.kind).join() === 'done');
    const over = lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] }), at(DAY, '19:50'), 'en', { moveTo: move })!;
    check('window over + slipped 12 min → "make it up": resume offers 12 min', over.offers[0].kind === 'resume' && over.offers[0].minutes === 12 && /12 more min/.test(over.offers[0].label), over.offers[0]?.label);
    const overSmall = lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 2 * MIN }] }), at(DAY, '19:50'), 'en', { moveTo: move })!;
    check('...never less than 10 minutes (a 2-minute slip owes 10)', overSmall.offers[0].minutes === 10);
    const overBig = lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 80 * MIN }] }), at(DAY, '19:50'), 'en', { moveTo: move })!;
    check('...nor more than 45', overBig.offers[0].minutes === 45);
    const noMove = lectureFor(event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] }), now, 'en')!;
    check('no free slot computed → no "move" offer (never an empty promise)', !noMove.offers.some((o) => o.kind === 'move'));
    check('"done" is always there, and last', [l, en, at9, at3, over].every((x) => x.offers[x.offers.length - 1].kind === 'done'));

    // What the offers do.
    const ev = event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] });
    const rp = resumePlan(ev, l.offers[0], now);
    check('resume: now → the original 19:45 (block re-armed on the same list)', hhmmOf(rp.endsAtMs) === '19:45' && rp.minutes === 23);
    const rp2 = resumePlan(ev, over.offers[0], at(DAY, '19:50'));
    check('resume after the window: a NEW window of the minutes owed', rp2.minutes === 12 && hhmmOf(rp2.endsAtMs) === '20:02', hhmmOf(rp2.endsAtMs));
    const bp = breakPlan(l.offers[1], now);
    check(`break: starts in ${BREAK_MINUTES} min and owes the full 23 minutes`, hhmmOf(bp.startAtMs) === '19:27' && bp.minutes === 23 && hhmmOf(bp.endsAtMs) === '19:50', `${hhmmOf(bp.startAtMs)}–${hhmmOf(bp.endsAtMs)}`);
  }

  console.log('\nA5. Where the rest could go\n');
  {
    const mk = (id: string, start: string, dur: number, over: Partial<Task> = {}): Task => ({
      id, text: id, category: 'work', priority: 'need_to', isFixed: true, fixedTime: start, durationMinutes: dur,
      date: DAY, status: 'pending', createdAt: 0, historicalDurations: [], ...over,
    });
    const now = at(DAY, '19:22');
    const free = suggestMoveTarget([mk('dinner', '20:00', 60)], now, 23);
    check('the first free window that holds it, ≥ 15 min from now (21:00 after dinner)', free.from === 'gap' && free.start === '21:00' && free.end === '21:23', JSON.stringify(free));
    const before = suggestMoveTarget([], now, 23);
    check('an empty evening → a quarter-hour from now, rounded to 5', before.from === 'gap' && before.start >= '19:40' && before.date === DAY, JSON.stringify(before));
    const full = suggestMoveTarget([mk('a', '19:30', 150)], now, 23);
    check('the day is full → the next hour is only offered when it is free; else tomorrow', full.from === 'tomorrow' && full.date === '2026-10-18', JSON.stringify(full));
    const away = suggestMoveTarget([mk('far', '19:00', 50, { location: { address: 'Tel Aviv', lat: 32, lng: 34, confirmed: true } as any })], now, 40, { dayEnd: '21:00' });
    check('...the next hour is not offered while she is still travelling back from a task at a place', away.from === 'tomorrow', JSON.stringify(away));
    const late = suggestMoveTarget([], at(DAY, '21:50'), 40, { dayEnd: '22:30' });
    check('too late today → tomorrow 09:00, DATED', late.from === 'tomorrow' && late.start === '09:00' && late.date === '2026-10-18', JSON.stringify(late));
    check('tomorrow shows as "tomorrow 09:00" / "מחר 09:00" (rule 4)', whenLabel(late, at(DAY, '21:50'), 'en') === 'tomorrow 09:00' && whenLabel(late, at(DAY, '21:50'), 'he') === 'מחר 09:00');
    check('today shows as just the hour', whenLabel(free, now, 'en') === '21:00');
    const own = suggestMoveTarget([mk('mine', '19:30', 45)], now, 23, { ignoreTaskId: 'mine' });
    check('the task being moved does not block its own new slot', own.from === 'gap' && own.date === DAY);
  }

  console.log('\nA6. Of several waiting, the worst first; and the weekly count\n');
  {
    const evs = [event({ kind: 'ended_early' }), event({ kind: 'block_failed', atMs: at(DAY, '19:23') }), event({ kind: 'killed', atMs: at(DAY, '19:24') }), event({ kind: 'slipped', atMs: at(DAY, '19:10'), usage: [{ pkg: IG, ms: 5 * MIN }] })];
    check('slipped, then revoked/killed, then ended early, block_failed last',
      pickEvent(evs)!.kind === 'slipped' && pickEvent([evs[0], evs[1], evs[2]])!.kind === 'service_killed' && pickEvent([evs[1], evs[0]])!.kind === 'ended_early');
    check('nothing waiting → null', pickEvent([]) === null);

    const now = at(DAY, '20:00');
    let log: BypassLogEntry[] = [];
    for (const e of [event({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] }), event({ kind: 'ended_early', minutesLeft: 23 }), event({ kind: 'permission_revoked', permission: 'usage' }), event({ kind: 'block_failed' })]) {
      log = appendLog(log, logEntryFor(e));
    }
    check('each bypass is logged with its date (YYYY-MM-DD)', log.every((e) => e.date === DAY));
    check('...slipped records its minutes, an early end the minutes left', log.find((e) => e.kind === 'slipped')!.minutes === 12 && log.find((e) => e.kind === 'ended_early')!.minutes === 23);
    check('logging the same event twice adds nothing', appendLog(log, log[0]).length === log.length);
    const w = weeklySummary(log, now);
    check('weekly: 3 counted (slipped, early, revoked); block_failed is not held against her', w.total === 3 && w.byKind.block_failed === 0 && w.slippedMinutes === 12, JSON.stringify(w));
    const old = appendLog(log, { id: 'old', date: '2026-10-01', kind: 'slipped', minutes: 5, atMs: at('2026-10-01', '10:00') });
    check('...and only the last 7 days', weeklySummary(old, now).total === 3);
    check('weekly line (he)', weeklyLine(w, 'he') === 'השבוע: 3 פעמים יצאת מהלמידה');
    check('weekly line (en)', weeklyLine(w, 'en') === 'This week: 3 times out of learning');
    check('one time (he/en)', weeklyLine({ ...w, total: 1 }, 'he') === 'השבוע: פעם אחת יצאת מהלמידה' && weeklyLine({ ...w, total: 1 }, 'en') === 'This week: 1 time out of learning');
    check('none → nothing is said', weeklyLine(weeklySummary([], now), 'en') === '');
  }

  console.log('\nB. The real services against a fake native module\n');
  {
    const reset = () => {
      store.clear(); sentNotifications.length = 0;
      native.available = true; native.perms = { usageAccess: true, overlay: true, notifications: true };
      native.incidents = []; native.scheduled.clear(); native.started = []; native.session = null;
      native.reconcileState = 'none'; native.opened = []; appState.currentState = 'active';
    };
    const NOWB = at(DAY, '19:22');
    const task = (id: string, over: Partial<Task> = {}): Task => ({
      id, text: 'Study for the exam', category: 'course', priority: 'have_to', isFixed: true, fixedTime: '19:00',
      durationMinutes: 45, date: DAY, status: 'pending', createdAt: 0, historicalDurations: [], ...over,
    });

    // B1 — incidents become pending lectures, the worst first, and are logged once.
    reset();
    native.incidents = [
      incident({ kind: 'permission_revoked', permission: 'usage' }),
      incident({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }, { pkg: 'com.android.chrome', ms: 9 * MIN }] }),
    ];
    let r = await Bypass.collectBypasses(NOWB);
    check('B1 two incidents → two pending events', r.pending.length === 2);
    let shown = await Bypass.nextLecture('he', NOWB);
    check('B1 the worst (slipped) is shown first, in Hebrew', shown?.event.kind === 'slipped' && /12 דק׳ באינסטגרם/.test(shown.lecture.body) && /9 דק׳ בדפדפן/.test(shown.lecture.body), shown?.lecture.body);
    check('B1 the weekly count already knows (no server)', (await Bypass.weeklyCountLine('he', NOWB)) === 'השבוע: 2 פעמים יצאת מהלמידה');
    r = await Bypass.collectBypasses(NOWB);
    check('B1 collecting again (nothing new) changes nothing, and logs nothing twice', r.pending.length === 2 && (await Bypass.weeklyCountLine('he', NOWB)) === 'השבוע: 2 פעמים יצאת מהלמידה');

    // B2 — done: gone for good, even if the native side reports it again.
    let a = await Bypass.answerLecture(shown, shown.lecture.offers.find((o: any) => o.kind === 'done'), 'he', NOWB);
    check('B2 "done" answers in one short line', a.ok === true && a.line.length < 40, JSON.stringify(a));
    native.incidents = [incident({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] })];
    r = await Bypass.collectBypasses(NOWB);
    check('B2 a handled lecture never comes back (the same session again is the same event)', !r.pending.some((e: BypassEvent) => e.kind === 'slipped'));
    check('B2 ...its sibling of the same session was retired with it', r.pending.length === 0, String(r.pending.length));

    // B3 — resume: starts blocking again on the SAME list, until the SAME end.
    reset();
    native.incidents = [incident({ kind: 'permission_revoked', permission: 'usage' })];
    await Bypass.collectBypasses(NOWB);
    shown = await Bypass.nextLecture('en', NOWB);
    const resume = shown.lecture.offers.find((o: any) => o.kind === 'resume');
    a = await Bypass.answerLecture(shown, resume, 'en', NOWB);
    check('B3 resume starts a session', a.ok === true && native.started.length === 1, JSON.stringify(a));
    check('B3 ...on exactly the packages it had, until the original end', native.started[0].blocked.join() === BLOCKED.join() && hhmmOf(native.started[0].endsAtMs) === '19:45');
    check('B3 ...and keeps the title and the language', native.started[0].title === 'Study for the exam' && native.started[0].lang === 'en');
    r = await Bypass.collectBypasses(NOWB);
    check('B3 an answered lecture is retired', r.pending.length === 0);

    // B4 — resume refused: the lecture STAYS, with the reason and the fix (rule 3).
    reset();
    native.perms.overlay = false;
    native.incidents = [incident({ kind: 'permission_revoked', permission: 'overlay' })];
    await Bypass.collectBypasses(NOWB);
    shown = await Bypass.nextLecture('he', NOWB);
    a = await Bypass.answerLecture(shown, shown.lecture.offers.find((o: any) => o.kind === 'resume'), 'he', NOWB);
    check('B4 resume without the overlay permission fails…', a.ok === false && a.fix === 'overlay', JSON.stringify(a));
    check('B4 …in words that name the fix', /הצגה מעל/.test(a.failure.title));
    check('B4 …and the lecture is NOT retired', (await Bypass.nextLecture('he', NOWB)) !== null);
    native.perms.overlay = true; native.perms.usageAccess = false;
    a = await Bypass.answerLecture(shown, shown.lecture.offers.find((o: any) => o.kind === 'resume'), 'he', NOWB);
    check('B4 usage access off reads differently (usage, not overlay)', a.ok === false && a.fix === 'usage');
    native.available = false;
    a = await Bypass.answerLecture(shown, shown.lecture.offers.find((o: any) => o.kind === 'resume'), 'he', NOWB);
    check('B4 no native module → says so (never a silent no-op)', a.ok === false && /Expo Go|מותקנת/.test(a.failure.body), JSON.stringify(a));

    // B5 — break: a scheduled auto-resume 5 minutes out, owing the full minutes.
    reset();
    native.incidents = [incident({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }] })];
    await Bypass.collectBypasses(NOWB);
    shown = await Bypass.nextLecture('en', NOWB);
    a = await Bypass.answerLecture(shown, shown.lecture.offers.find((o: any) => o.kind === 'break'), 'en', NOWB);
    const sched = [...native.scheduled.values()];
    check('B5 break schedules ONE session', a.ok === true && sched.length === 1, JSON.stringify(a));
    check('B5 ...starting at 19:27, ending 19:50, same list', hhmmOf(sched[0].startAtMs) === '19:27' && hhmmOf(sched[0].endsAtMs) === '19:50' && sched[0].blocked.join() === BLOCKED.join());
    check('B5 ...announced when it starts ("Break is over")', /Break is over/.test(sched[0].startTitle) && sched[0].id.startsWith('resume-'));
    check('B5 ...and its id is not a study-task id (calendar sync leaves it alone)', !sched[0].id.startsWith('study-'));

    // B6 — move: the session's own task is moved and shortened; the next sync alarms it.
    reset();
    const t1 = task('t1');
    const dinner = task('dinner', { text: 'Dinner with mom', category: 'general', fixedTime: '20:00', durationMinutes: 60 });
    await TaskStorage.saveAllTasks([t1, dinner]);
    native.incidents = [incident({ kind: 'slipped', usage: [{ pkg: IG, ms: 12 * MIN }], session: snap({ taskId: 't1' }) })];
    await Bypass.collectBypasses(NOWB);
    shown = await Bypass.nextLecture('he', NOWB);
    const mv = shown.lecture.offers.find((o: any) => o.kind === 'move');
    check('B6 the move offer names a real free hour (after dinner)', shown.lecture.moveTo.start === '21:00' && /21:00/.test(mv.label), mv?.label);
    a = await Bypass.answerLecture(shown, mv, 'he', NOWB);
    const moved = (await TaskStorage.getAllTasks()).find((t: Task) => t.id === 't1');
    check('B6 the task is moved to 21:00 for the 23 minutes that were left', a.ok === true && moved.fixedTime === '21:00' && moved.durationMinutes === 23 && moved.date === DAY, JSON.stringify(moved));
    check('B6 ...and the answer says where (dated)', /21:00/.test(a.line));
    const alarm = native.scheduled.get('study-t1');
    check('B6 ...and an alarm for the new hour exists', Boolean(alarm) && hhmmOf(alarm.startAtMs) === '21:00' && hhmmOf(alarm.endsAtMs) === '21:23', alarm && `${hhmmOf(alarm.startAtMs)}–${hhmmOf(alarm.endsAtMs)}`);

    // B7 — a session with no task (started by hand): the rest becomes a new study task.
    reset();
    await TaskStorage.saveAllTasks([dinner]);
    native.incidents = [incident({ kind: 'permission_revoked', permission: 'usage', session: snap({ id: 'manual-1', taskId: null, title: 'Linear algebra' }) })];
    await Bypass.collectBypasses(NOWB);
    shown = await Bypass.nextLecture('en', NOWB);
    a = await Bypass.answerLecture(shown, shown.lecture.offers.find((o: any) => o.kind === 'move'), 'en', NOWB);
    const added = (await TaskStorage.getAllTasks()).find((t: Task) => /Study \(rest\): Linear algebra/.test(t.text));
    check('B7 no task → "Study (rest): …" is added at the free hour', a.ok === true && Boolean(added) && added.fixedTime === '21:00' && added.durationMinutes === 23, JSON.stringify(added));
    check('B7 ...and it is itself a study task, so the next sync blocks at its hour', native.scheduled.has(`study-${added?.id}`));

    // B8 — killed while the app was closed: said once, by notification; the lecture waits for the open.
    reset();
    appState.currentState = 'background';
    native.incidents = [incident({ kind: 'killed', minutesLeft: 30 })];
    await Bypass.focusTick('he', 'background', NOWB);
    check('B8 closed app: the "service was killed" is notified', sentNotifications.length === 1 && /אמרת שאת לומדת/.test(sentNotifications[0].title), JSON.stringify(sentNotifications));
    await Bypass.focusTick('he', 'background', NOWB);
    check('B8 ...once only', sentNotifications.length === 1);
    appState.currentState = 'active';
    shown = await Bypass.nextLecture('he', NOWB);
    check('B8 ...and the lecture is still waiting for her next open', shown?.event.kind === 'service_killed');
    native.incidents = [incident({ kind: 'permission_revoked', permission: 'usage', session: snap({ id: 'study-z', startedAtMs: at(DAY, '20:00'), endsAtMs: at(DAY, '20:45') }) })];
    sentNotifications.length = 0; appState.currentState = 'background';
    await Bypass.focusTick('he', 'background', NOWB);
    check('B8 revoked/slipped are announced by the native service itself, not twice from JS', sentNotifications.length === 0);

    // B9 — the study-session alarms follow the schedule.
    reset();
    await TaskStorage.saveAllTasks([task('s1', { fixedTime: '21:00' })]);
    let rep = await Session.scheduleStudySessions(await TaskStorage.getAllTasks(), 'he', NOWB);
    check('B9 a study task → one alarm', rep.state === 'ok' && rep.scheduled === 1 && native.scheduled.has('study-s1'), JSON.stringify(rep));
    check('B9 ...with the notice "📚 מתחילים ללמוד — חסמתי את אינסטגרם…"', native.scheduled.get('study-s1').startTitle === '📚 מתחילים ללמוד' && /^חסמתי את אינסטגרם/.test(native.scheduled.get('study-s1').startBody));
    rep = await Session.scheduleStudySessions(await TaskStorage.getAllTasks(), 'he', NOWB);
    check('B9 a second sync changes nothing (idempotent)', rep.scheduled === 0 && rep.cancelled === 0 && rep.unchanged === 1, JSON.stringify(rep));
    await TaskStorage.saveAllTasks([task('s1', { fixedTime: '21:30' })]);
    rep = await Session.scheduleStudySessions(await TaskStorage.getAllTasks(), 'he', NOWB);
    check('B9 moved → rescheduled to 21:30', rep.scheduled === 1 && hhmmOf(native.scheduled.get('study-s1').startAtMs) === '21:30');
    await TaskStorage.saveAllTasks([task('s1', { fixedTime: '21:30', status: 'complete' })]);
    rep = await Session.scheduleStudySessions(await TaskStorage.getAllTasks(), 'he', NOWB);
    check('B9 ticked off → its alarm is cancelled', rep.cancelled === 1 && !native.scheduled.has('study-s1'));

    // B10 — not set up: nothing scheduled, ONE nudge, and the sheet is armed.
    reset();
    native.perms.usageAccess = false;
    await TaskStorage.saveAllTasks([task('s2', { fixedTime: '21:00' })]);
    rep = await Session.scheduleStudySessions(await TaskStorage.getAllTasks(), 'he', NOWB);
    check('B10 without permissions: nothing is scheduled, and it says why (state + missing)', rep.state === 'needs_permission' && rep.missing[0] === 'usage' && native.scheduled.size === 0, JSON.stringify(rep));
    check('B10 ...she is told once (notification)', sentNotifications.length === 1 && /הרשאות|permissions/.test(sentNotifications[0].body));
    await Session.scheduleStudySessions(await TaskStorage.getAllTasks(), 'he', NOWB + 60_000);
    check('B10 ...not again on the next sync', sentNotifications.length === 1);
    check('B10 ...and the chooser opens at her next visit, once', (await Session.takeSetupPrompt()) === true && (await Session.takeSetupPrompt()) === false);
    native.available = false;
    rep = await Session.scheduleStudySessions(await TaskStorage.getAllTasks(), 'he', NOWB);
    check('B10 Expo Go / old build: state "unavailable" (not "ok with 0")', rep.state === 'unavailable');

    // B11 — starting by hand.
    reset();
    let s = await Session.startLearning({ minutes: 45, title: 'Algorithms', taskId: 'x', lang: 'en', now: NOWB });
    check('B11 manual start passes the default apps', s.ok === true && native.started[0].blocked.includes(WA) && native.started[0].blocked.includes(IG) && hhmmOf(native.started[0].endsAtMs) === '20:07');
    reset();
    await Session.saveChoice(['youtube']);
    s = await Session.startLearning({ minutes: 30, lang: 'en', now: NOWB });
    check('B11 her saved list persists across launches', native.started[0].blocked.join() === 'com.google.android.youtube');
    await Session.saveChoice([]);
    s = await Session.startLearning({ minutes: 30, lang: 'he', now: NOWB });
    check('B11 nothing chosen → refused, with words', s.ok === false && s.reason === 'nothing_to_block' && s.failure.body.length > 5);
    reset();
    native.perms.usageAccess = false;
    s = await Session.startLearning({ minutes: 30, lang: 'en', now: NOWB });
    check('B11 no usage access → refused BEFORE a session that blocks nothing is started', s.ok === false && s.fix === 'usage' && native.started.length === 0);
    native.available = false;
    s = await Session.startLearning({ minutes: 30, lang: 'en', now: NOWB });
    check('B11 no native module → {native_unavailable}, no fix button offered', s.ok === false && s.reason === 'native_unavailable' && s.fix === 'none');

    // B12 — Android refused to start the service from the background: the open app starts it.
    reset();
    native.scheduled.set('study-q', {
      id: 'study-q', startAtMs: at(DAY, '19:00'), endsAtMs: at(DAY, '19:45'), blocked: BLOCKED, title: 'Study for the exam',
      lang: 'he', sig: 's', fired: true, error: 'service_start_refused:ForegroundServiceStartNotAllowedException', taskId: 'q',
    });
    native.scheduled.set('study-r', { id: 'study-r', startAtMs: at(DAY, '19:00'), endsAtMs: at(DAY, '19:45'), blocked: BLOCKED, title: 'x', lang: 'he', sig: 's', fired: true, error: 'missed_window' });
    native.scheduled.set('study-p', { id: 'study-p', startAtMs: at(DAY, '19:00'), endsAtMs: at(DAY, '19:45'), blocked: BLOCKED, title: 'y', lang: 'he', sig: 's', fired: true });
    const rec = await Session.recoverFailedStarts('he', NOWB);
    check('B12 a start Android refused is started when the app is open, for the rest of its window',
      rec.started === 1 && native.started.length === 1 && hhmmOf(native.started[0].endsAtMs) === '19:45' && native.started[0].sessionId === 'study-q', JSON.stringify(rec));
    check('B12 ...a window that was simply missed, or one that started fine, is left alone', native.started.length === 1);
    check('B12 ...and the failure record is cleared', !native.scheduled.has('study-q') && native.scheduled.has('study-r'));
    appState.currentState = 'active';
    native.scheduled.set('study-q2', { id: 'study-q2', startAtMs: at(DAY, '19:00'), endsAtMs: at(DAY, '19:45'), blocked: BLOCKED, title: 'z', lang: 'he', sig: 's', fired: true, error: 'service_start_refused:X' });
    await Bypass.focusTick('he', 'active', NOWB);
    check('B12 focusTick does it on its own while the app is open', native.started.length === 2);
    native.perms.overlay = false;
    native.scheduled.set('study-q3', { id: 'study-q3', startAtMs: at(DAY, '19:00'), endsAtMs: at(DAY, '19:45'), blocked: BLOCKED, title: 'w', lang: 'he', sig: 's', fired: true, error: 'service_start_refused:X' });
    const rec2 = await Session.recoverFailedStarts('he', NOWB);
    check('B12 if it cannot be recovered the reason is returned, not swallowed', rec2.started === 0 && rec2.errors.length === 1 && /no_overlay/.test(rec2.errors[0]), JSON.stringify(rec2));
  }

  console.log('\nB13. The Play disclosure comes BEFORE Settings opens (prominent disclosure)\n');
  {
    native.opened = [];
    const before = await Session.requestPermission('usage', 'he');
    check('B13 before she read it, Settings does NOT open', !before.ok && before.reason === 'disclosure_needed' && native.opened.length === 0, JSON.stringify(before));
    check('B13 ...and the refusal has words in her language', !before.ok && /[֐-׿]/.test(before.failure.title));
    check('B13 nothing was remembered as read', !(await Session.disclosureAccepted()));
    await Session.acceptDisclosure(at(DAY, '09:00'));
    const after = await Session.requestPermission('overlay', 'en');
    check('B13 after "Got it", Settings opens', after.ok && native.opened.join(',') === 'overlay', native.opened.join(','));
    check('B13 ...and it is remembered', (await Session.disclosureAccepted()) && Boolean(await memoryAsyncStorage.getItem('meira.focus.disclosure.v1')));
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
