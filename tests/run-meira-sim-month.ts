/**
 * run-meira-sim-month — three simulated people live October 2026 on the real app.
 *
 * Ronen (car, field engineer), Shani (train + bus, leaves late) and Noa (bike,
 * the control) from tests/fixtures/meira-sim. Their whole month goes into the
 * app the way her month does: raw Google Calendar items → GoogleService →
 * GoogleSync.syncCalendarForDate (import) → GoogleSync.ensureTravelChain
 * (routing, answered with the fixture's planned minutes) → TaskStorage →
 * NotificationService (every alert, captured from a fake OS scheduler). Then:
 *
 *   1. DST        Israel leaves summer time on 2026-10-25. Every meeting keeps
 *                 its local hour across it, and every alert on 10-26 fires at a
 *                 +02:00 instant, not a +03:00 one.
 *   2. Phantoms   every notification resolves to a real meeting; no duplicate
 *                 (user, type, target, fire_at); no online meeting gets a route
 *                 or a leave alert (a wake alarm for a morning Zoom is policy).
 *   3. Noa        nothing about her month may raise a warning of any kind.
 *   4. Learning   the replayed departures teach the lead through the app's own
 *                 completion path (markTaskComplete → recordLeadLearning). The
 *                 signal must be the DEPARTURE slip, not arrival lateness.
 *
 * What run-alert-integrity already covers (and this does not repeat): planning
 * one task twice yields one set, alerts land on the task's date, nothing in
 * the past, the wake policy, the task id on every alert — all on hand-built
 * tasks through the pure planner. This file is the same scheduler over a whole
 * imported month, where duplicates and phantoms actually come from.
 *
 * Run:  npm run test:month
 */
import {
  bootUser, collectWarnings, googleItem, installFixtureRouting, scheduledNotifications,
  setCalendar, taskIdOf, withClock,
} from './meira-sim-app';
import {
  FixtureMeeting, RouteAsk, goldenRouteSource, goldenTravel, loadFeasibility, loadLocations,
  loadMeetings, loadUsers, readCsv,
} from './meira-sim-fixture';
import type { Task } from '../src/types/index';

/* eslint-disable @typescript-eslint/no-var-requires */
const GoogleSync = require('../src/services/GoogleSync');
const TaskStorage = require('../src/services/TaskStorage');
const UserProfileStorage = require('../src/services/UserProfileStorage');
const { localClockOf } = require('../src/utils/calendarTime');
const { resolveClashes } = require('../src/utils/resolveClashes');
const { dayWarnings, sortTimed } = require('../src/utils/dayPlanning');
const { classifyOverlap } = require('../src/utils/overlapKind');
const { resolveLeadMinutes, DAY } = require('../src/utils/leadTime');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const LEAVE_KINDS = new Set(['leave_home', 'leave_nag']);
const names: Record<string, string> = { '101': 'Ronen', '102': 'Shani', '103': 'Noa' };

interface Month {
  userId: string;
  tasks: Map<string, Task>;          // task id → task, after the whole month is routed
  notifications: ReturnType<typeof scheduledNotifications>;
  meetings: FixtureMeeting[];
  warnings: string[];
}

async function liveMonth(userId: string): Promise<Month> {
  const locations = loadLocations();
  const user = loadUsers('sim').get(userId)!;
  const meetings = loadMeetings('sim').filter((m) => m.userId === userId);
  const golden = goldenTravel(loadFeasibility('sim'));
  const offGolden: RouteAsk[] = [];
  await bootUser(user);
  installFixtureRouting(user, locations, goldenRouteSource(user, locations, golden, offGolden), meetings);
  setCalendar(meetings.map((m) => googleItem(m, locations)));
  const warnings: string[] = [];
  const dates = [...new Set(meetings.map((m) => m.date))].sort();
  for (const date of dates) {
    const r = await collectWarnings(async () => {
      await GoogleSync.syncCalendarForDate(date, 'en');
      await GoogleSync.ensureTravelChain(date, 'en');
    });
    warnings.push(...r.warnings.map((w) => `${date} ${w}`));
  }
  const tasks = new Map<string, Task>();
  for (const date of dates) {
    for (const t of await TaskStorage.getTasksForDate(date)) tasks.set(t.id, t);
  }
  return { userId, tasks, notifications: scheduledNotifications(), meetings, warnings };
}

const locOf = (t?: Task): any => (t && typeof t.location === 'object' ? t.location : undefined);
const iso = (d: any) => new Date(d).toISOString();

// ── 1. DST ──────────────────────────────────────────────────────────────────
function dstSection(months: Month[]) {
  console.log('\n1. The DST boundary (Israel leaves summer time on 2026-10-25)\n');
  check('09:00 local on 10-24 is 06:00Z — the conversion reads the zone, not a fixed +3',
    localClockOf('2026-10-24T06:00:00Z') === '09:00', String(localClockOf('2026-10-24T06:00:00Z')));
  check('09:00 local on 10-26 is 07:00Z — and 06:00Z that day is 08:00, not 09:00',
    localClockOf('2026-10-26T07:00:00Z') === '09:00' && localClockOf('2026-10-26T06:00:00Z') === '08:00',
    `${localClockOf('2026-10-26T07:00:00Z')} / ${localClockOf('2026-10-26T06:00:00Z')}`);

  let imported = 0;
  const wrongHour: string[] = [];
  for (const mo of months) {
    for (const m of mo.meetings) {
      const t = mo.tasks.get(taskIdOf(m));
      if (!t) { wrongHour.push(`${m.date} ${m.title}: not imported`); continue; }
      imported += 1;
      if (t.fixedTime !== m.startLocal) wrongHour.push(`${m.date} ${m.title}: ${t.fixedTime} ≠ ${m.startLocal}`);
    }
  }
  check(`every imported meeting keeps its local start across the boundary (${imported} meetings)`,
    wrongHour.length === 0, wrongHour.slice(0, 5).join(' | ') || 'all equal to start_local');

  const around = months.flatMap((mo) => mo.meetings.filter((m) => m.date === '2026-10-25' || m.date === '2026-10-26')
    .map((m) => ({ mo, m })));
  for (const { mo, m } of around) {
    const t = mo.tasks.get(taskIdOf(m));
    console.log(`    ${names[mo.userId]} ${m.date} ${m.startAt} → ${t?.fixedTime} (${m.title})`);
  }

  // Every alert that belongs to a task dated on/after the change must be an
  // instant at +02:00; before it, +03:00. And its local clock must be exactly
  // the time the plan says.
  const offsetBad: string[] = [];
  const clockBad: string[] = [];
  let sampled = 0;
  for (const mo of months) {
    for (const n of mo.notifications) {
      const t = mo.tasks.get(String(n.content.data?.taskId));
      const at = new Date(n.trigger.date as any);
      if (!t || Number.isNaN(at.getTime())) continue;
      const winter = at.getTime() >= Date.parse('2026-10-24T23:00:00Z');
      const want = winter ? -120 : -180;
      if (at.getTimezoneOffset() !== want) offsetBad.push(`${t.text} ${iso(at)} offset ${at.getTimezoneOffset()}`);
      const plan = n.content.data?.notificationType === 'leave_home' ? locOf(t)?.leaveHomeBy
        : n.content.data?.notificationType === 'wake_up' ? locOf(t)?.wakeUpBy : undefined;
      if (plan && t.date >= '2026-10-25') {
        sampled += 1;
        const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
        if (clock !== plan) clockBad.push(`${t.date} ${n.content.data?.notificationType} "${t.text}" fires ${clock}, plan ${plan}`);
      }
    }
  }
  check('every alert instant carries the offset of its own side of the change', offsetBad.length === 0,
    offsetBad.slice(0, 4).join(' | ') || 'all consistent');
  check(`wake/leave alerts after the change fire at the planned local minute (${sampled} checked)`,
    sampled > 0 && clockBad.length === 0, clockBad.slice(0, 4).join(' | ') || 'all on the minute');
}

// ── 2. Phantom notifications ────────────────────────────────────────────────
function phantomSection(months: Month[]) {
  console.log('\n2. Phantom notifications — the month through the real scheduler\n');
  const fixtureRows = readCsv('sim_notifications.csv');
  for (const mo of months) {
    const who = `${names[mo.userId]} (${mo.userId})`;
    const meetingTask = new Map(mo.meetings.map((m) => [taskIdOf(m), m]));
    const orphans = mo.notifications.filter((n) => !mo.tasks.has(String(n.content.data?.taskId)));
    const notMeetings = mo.notifications.filter((n) => mo.tasks.has(String(n.content.data?.taskId))
      && !meetingTask.has(String(n.content.data?.taskId)));
    check(`${who}: every one of ${mo.notifications.length} notifications resolves to a stored task`,
      orphans.length === 0, orphans.slice(0, 3).map((n) => `${n.content.data?.notificationType} → ${n.content.data?.taskId}`).join(' | '));
    check(`${who}: …and every such task is one of her calendar meetings`, notMeetings.length === 0,
      notMeetings.slice(0, 3).map((n) => `${n.content.data?.notificationType} → ${mo.tasks.get(String(n.content.data?.taskId))?.text}`).join(' | ') || 'no app-invented targets');

    const seen = new Map<string, number>();
    for (const n of mo.notifications) {
      const key = `${mo.userId}|${n.content.data?.notificationType}|${n.content.data?.taskId}|${iso(n.trigger.date)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dups = [...seen.entries()].filter(([, c]) => c > 1);
    check(`${who}: no duplicate (user, type, target, fire_at)`, dups.length === 0,
      dups.slice(0, 3).map(([k, c]) => `${k} ×${c}`).join(' | '));

    const online = mo.meetings.filter((m) => m.isOnline);
    const routed = online.filter((m) => {
      const t = mo.tasks.get(taskIdOf(m));
      return Boolean(locOf(t)?.transitPlan || locOf(t)?.leaveHomeBy);
    });
    const onlineIds = new Set(online.map((m) => taskIdOf(m)));
    const travelAlerts = mo.notifications.filter((n) => LEAVE_KINDS.has(n.content.data?.notificationType)
      && onlineIds.has(String(n.content.data?.taskId)));
    check(`${who}: none of ${online.length} online meetings got a route or a leave alert`,
      routed.length === 0 && travelAlerts.length === 0,
      [...routed.map((m) => `route on "${m.title}"`), ...travelAlerts.map((n) => `${n.content.data?.notificationType} for ${n.content.data?.taskId}`)].slice(0, 4).join(' | ') || 'none');
    const wakeForOnline = mo.notifications.filter((n) => ['wake_up', 'get_ready'].includes(n.content.data?.notificationType)
      && onlineIds.has(String(n.content.data?.taskId)));
    if (wakeForOnline.length) {
      console.log(`    ${who}: ${wakeForOnline.length} wake_up/get_ready alert(s) on online meetings — not a route: the`
        + ' "clock alarm every morning according to the schedule" policy (alertPlan.needsWakeAlarm) applies to a Zoom too');
    }

    // The fixture's own schedule, side by side. Not asserted: its re_check and
    // missed_bus kinds are not alerts this app schedules, and its leave time is
    // its own margin policy — the invariants above are the contract.
    const mine = fixtureRows.filter((r) => r.user_id === mo.userId);
    const count = (kind: string) => mo.notifications.filter((n) => n.content.data?.notificationType === kind).length;
    const fcount = (kind: string) => mine.filter((r) => r.type === kind).length;
    console.log(`    ${who}: app wake_up ${count('wake_up')} / fixture ${fcount('wake_up')}`
      + ` · app leave_home ${count('leave_home')} / fixture ${fcount('leave_home')}`
      + ` · app get_ready ${count('get_ready')} · leave_nag ${count('leave_nag')} · lead ${count('lead')}`
      + ` · day_before ${count('day_before')} · fixture re_check ${fcount('re_check')}, missed_bus ${fcount('missed_bus')}`);
  }
}

// ── 4. Learning ─────────────────────────────────────────────────────────────

/**
 * markTaskComplete starts the learning with `void recordCompletionLearning(…)`
 * and returns without waiting for it, so nothing the caller holds can say when
 * the lead has been written. Between two real completions there are hours;
 * this is that pause, compressed.
 */
const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * Replay the fixture's departures on a routed month: she leaves `delay`
 * minutes after the departure the APP gave her (the fixture's delay is
 * relative to the plan it was shown), then the meeting is completed through
 * the app's own path. `spaced` waits for the learning between completions, as
 * a day does; unspaced is the end-of-day review ticking them all at once.
 */
async function replayDepartures(
  mo: Month, lefts: Record<string, string>[], spaced: boolean,
): Promise<{ replayed: number; learned: Record<string, number> }> {
  let replayed = 0;
  await collectWarnings(async () => {
    for (const e of [...lefts].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
      const task = mo.tasks.get(`gcal-sim-${e.meeting_id}`);
      const leave = locOf(task)?.leaveHomeBy;
      if (!task || !leave) continue;
      const [h, m] = leave.split(':').map(Number);
      const [y, mo2, d] = task.date.split('-').map(Number);
      const departed = new Date(y, mo2 - 1, d, h, m).getTime() + Number(e.lateness_minutes) * 60_000;
      await TaskStorage.updateTaskFields(task.id, { lastDepartureDetectedAt: departed });
      await TaskStorage.markTaskComplete(task.id, true);
      replayed += 1;
      if (spaced) await settle();
    }
    await settle();   // let the last write land before anything reads or resets
  });
  const profile = await UserProfileStorage.loadProfile();
  return { replayed, learned: profile?.learnedLeadMinutes ?? {} };
}

async function learningSection() {
  console.log('\n4. Learning — which signal sets the lead\n');
  const events = readCsv('sim_task_events.csv');
  for (const userId of ['102', '103', '101']) {
    const mo = await liveMonth(userId);
    const lefts = events.filter((e) => e.user_id === userId && e.event_type === 'left_home');
    const arrivals = events.filter((e) => e.user_id === userId && e.event_type === 'arrived');
    const meanDepart = lefts.reduce((s, e) => s + Number(e.lateness_minutes), 0) / Math.max(1, lefts.length);
    const meanArrive = arrivals.reduce((s, e) => s + Number(e.lateness_minutes), 0) / Math.max(1, arrivals.length);

    const { replayed, learned } = await replayDepartures(mo, lefts, true);

    if (userId === '102') {
      // The same 24 completions, ticked back to back — the end-of-day review.
      const again = await liveMonth(userId);
      const burst = await replayDepartures(again, lefts, false);
      const same = JSON.stringify(Object.entries(burst.learned).sort())
        === JSON.stringify(Object.entries(learned).sort());
      check('completing her 24 meetings back to back teaches the same lead as completing them hours apart',
        same, `spaced ${JSON.stringify(learned)} · back-to-back ${JSON.stringify(burst.learned)}`);
    }
    // Keyed by the category the APP gave each meeting (it re-reads the title),
    // which is what learnedLeadMinutes is keyed by — not the fixture's column.
    const appCat = (e: Record<string, string>) => String(mo.tasks.get(`gcal-sim-${e.meeting_id}`)?.category ?? e.category);
    const cats = [...new Set(lefts.map(appCat))];
    const remaps = new Map<string, number>();
    for (const e of lefts) if (appCat(e) !== e.category) remaps.set(`${e.category}→${appCat(e)}`, (remaps.get(`${e.category}→${appCat(e)}`) ?? 0) + 1);
    const rows = cats.map((c) => {
      const base = (resolveLeadMinutes({ category: c }, {}) as number[]).filter((n) => n < DAY)[0];
      return { c, base, learned: learned[c] };
    });
    console.log(`    ${names[userId]}: ${replayed} departures replayed · mean departure delay ${meanDepart.toFixed(1)} min`
      + ` · mean ARRIVAL lateness ${meanArrive.toFixed(1)} min`);
    console.log(`      learned lead by category: ${rows.map((r) => `${r.c} ${r.base}→${r.learned ?? r.base}`).join(', ')}`);
    if (remaps.size) console.log(`      the app re-categorised by title: ${[...remaps.entries()].map(([k, v]) => `${k} ×${v}`).join(', ')}`);

    const moved = rows.filter((r) => r.learned !== undefined);
    if (userId === '102') {
      // She leaves 5–12 minutes late and, thanks to the margin, still arrives
      // EARLY on average. A lateness-driven learner would shrink her lead; a
      // departure-driven one must grow it.
      check('Shani: late departures raise her lead even though she arrives early on average',
        meanArrive <= 0 && moved.length > 0 && moved.every((r) => r.learned! > r.base),
        `arrival ${meanArrive.toFixed(1)}, ${rows.map((r) => `${r.c} ${r.base}→${r.learned ?? r.base}`).join(', ')}`);
    }
    if (userId === '103') {
      check('Noa: a punctual month never raises her lead above the default',
        rows.every((r) => (r.learned ?? r.base) <= r.base),
        rows.map((r) => `${r.c} ${r.base}→${r.learned ?? r.base}`).join(', '));
    }
    if (userId === '101') {
      check('Ronen: the lead only ever moves for categories he actually travelled to',
        Object.keys(learned).every((c) => cats.includes(c)), Object.keys(learned).join(', ') || 'nothing learned');
    }
  }
}

// ── 3. Noa, the control ─────────────────────────────────────────────────────
function noaSection(mo: Month) {
  console.log('\n3. Noa Levi — the control. Any warning is a false positive.\n');
  const findings: string[] = [];
  const byDate = new Map<string, Task[]>();
  for (const t of mo.tasks.values()) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date)!.push(t);
  }
  for (const [date, tasks] of [...byDate.entries()].sort()) {
    for (const c of resolveClashes(tasks)) findings.push(`${date} clash "${c.a.text}" / "${c.b.text}"`);
    for (const w of dayWarnings(sortTimed(tasks), false)) findings.push(`${date} ${w}`);
    for (let i = 0; i < tasks.length; i += 1) {
      for (let k = i + 1; k < tasks.length; k += 1) {
        const v = classifyOverlap(tasks[i], tasks[k]);
        if (v && (v.kind === 'spatial' || v.kind === 'displaced')) findings.push(`${date} ${v.kind} "${tasks[i].text}" / "${tasks[k].text}"`);
      }
    }
    for (const t of tasks) {
      const l = locOf(t);
      if (l?.routeFailure || l?.noRouteForMode) findings.push(`${date} no route for "${t.text}"`);
      if (l?.transitPlan?.late || l?.transitPlan?.problems?.length) findings.push(`${date} plan problem on "${t.text}"`);
    }
  }
  // Status lines at warn are not warnings: "a route asked / saved" is logged
  // at warn on purpose (1e8e213 — a release build drops console.log).
  const worrying = mo.warnings.filter((w) => !/geocode|map pin|created \d+ interview prep|offer \d|\[GoogleSync\] chain saved|\[LiveRoute\] .* saved|\[RouteGateway\] asked/.test(w));
  check('no clash, day warning, spatial/displaced overlap, route failure or plan problem in her month',
    findings.length === 0, findings.slice(0, 6).join(' | ') || `${byDate.size} days, none raised`);
  check('the app printed no warning about her month (beyond "no map pin" — geocoding is offline here)',
    worrying.length === 0, worrying.slice(0, 4).join(' | '));
}

async function main() {
  console.log('\nrun-meira-sim-month — October 2026 for three simulated people, on the real app\n');
  const months: Month[] = [];
  // October 2026 is now the month the suite runs IN: what counts as past and
  // what is still to learn moved with the hour (6.10 — green at 11:41, red at
  // 14:00). Run the month from a fixed moment the gate passed at.
  await withClock('2026-10-04T13:00:00+03:00', async () => {
    for (const userId of ['101', '102', '103']) months.push(await liveMonth(userId));
  });
  for (const mo of months) {
    const routed = [...mo.tasks.values()].filter((t) => locOf(t)?.leaveHomeBy).length;
    console.log(`  ${names[mo.userId]}: ${mo.meetings.length} meetings → ${mo.tasks.size} tasks, ${routed} routed,`
      + ` ${mo.notifications.length} notifications scheduled`);
  }
  dstSection(months);
  phantomSection(months);
  noaSection(months[2]);
  await withClock('2026-10-04T13:00:00+03:00', () => learningSection());

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ run-meira-sim-month crashed:', e);
  process.exit(1);
});
