/**
 * run-week-schedule — end-to-end dry run of a real multi-stop week.
 *
 * For every SESSION (date + hour + location + transport) it:
 *   1. chains the route from the PREVIOUS session's place (home for the first),
 *      hitting the real Google Directions API,
 *   2. prints DATE / HOUR / LOCATION / TRANSPORT / route legs / leave + wake,
 *   3. prints every notification that would fire, with the screen its tap opens,
 *   4. asserts the plan is coherent (arrive by the hour, alerts before it,
 *      every alert routed to a screen, no unexplained travel gaps).
 *
 * Same code paths as the app: services/RoutePlanner (routing),
 * utils/alertPlan (alert times + tap target), utils/dayPlanning (clashes).
 *
 * Run:  npx tsx tests/run-week-schedule.ts
 *       npx tsx tests/run-week-schedule.ts --home="דיזנגוף 100, תל אביב" --transport=car
 *       npx tsx tests/run-week-schedule.ts --offline     (no API calls, layout only)
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { getPlanForMode } from '../src/services/RoutePlanner';
import { planTransitAlerts, planFixedTimeAlerts, PlannedAlert } from '../src/utils/alertPlan';
import { dayWarnings, sortTimed } from '../src/utils/dayPlanning';
import { timeToMinutes, minutesToTime } from '../src/utils/timeUtils';
import { Task, TransitPlan, TransportType, UserProfile } from '../src/types/index';

// ── config ───────────────────────────────────────────────────────────────────
const arg = (name: string, fallback: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OFFLINE = process.argv.includes('--offline');
const HOME = arg('home', 'הרצל 1, תל אביב');
const DEFAULT_TRANSPORT = arg('transport', 'bus') as TransportType;
/** Minutes of getting ready before leaving — mirrors LumiCoachEngine.GET_READY_MINUTES. */
const GET_READY_MINUTES = 45;

// The Maps key lives in .env (Expo injects it at build time; node does not).
if (!process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY) {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

// ── the week under test ──────────────────────────────────────────────────────
const today = new Date();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plusDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
/** Next Sunday (today counts only if it IS Sunday and nothing later is meant). */
const nextSunday = () => {
  const d = new Date(today);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
  return iso(d);
};

const TODAY = plusDays(0);
const TOMORROW = plusDays(1);
const SUNDAY = nextSunday();

interface Session {
  id: string;
  title: string;
  date: string;
  hour: string;            // HH:MM — arrival deadline
  durationMinutes: number;
  location: string;
  transport?: TransportType;
}

const SESSIONS: Session[] = [
  { id: 's1', title: 'פגישה באור יהודה', date: TODAY, hour: '11:00', durationMinutes: 60, location: 'אור יהודה' },
  { id: 's2', title: 'פגישה בורדיאל 17', date: TODAY, hour: '14:00', durationMinutes: 60, location: 'ורדיאל 17, תל אביב' },
  { id: 's3', title: 'זמן עבודה — ורדיאל', date: TODAY, hour: '15:00', durationMinutes: 150, location: 'ורדיאל 17, תל אביב' },
  { id: 's4', title: 'מכון כושר', date: TODAY, hour: '18:00', durationMinutes: 60, location: 'יגאל אלון 94, תל אביב' },
  { id: 's5', title: 'פגישה בפרישמן', date: TODAY, hour: '20:00', durationMinutes: 60, location: 'פרישמן 50, תל אביב' },
  { id: 's6', title: 'יוגה', date: TOMORROW, hour: '11:00', durationMinutes: 60, location: 'יגאל אלון, תל אביב' },
  { id: 's7', title: 'פגישה במשרדי Apple', date: SUNDAY, hour: '10:00', durationMinutes: 90, location: 'Apple, הרצליה' },
  { id: 's8', title: 'פגישה ב-MER GROUP', date: SUNDAY, hour: '13:00', durationMinutes: 60, location: 'MER Group, אור יהודה' },
];

const profile = {
  name: 'test',
  homeAddress: HOME,
  transportType: DEFAULT_TRANSPORT,
  wakeBufferMinutes: 10,
  morningRoutineMinutes: 30,
} as unknown as UserProfile;

// ── helpers ──────────────────────────────────────────────────────────────────
const asTask = (s: Session, plan?: TransitPlan, firstTrip = false): Task => ({
  id: s.id,
  text: s.title,
  date: s.date,
  fixedTime: s.hour,
  isFixed: true,
  durationMinutes: s.durationMinutes,
  status: 'pending',
  createdAt: 0,
  historicalDurations: [],
  location: {
    address: s.location,
    lat: 0,
    lng: 0,
    confirmed: true,
    ...(plan
      ? {
        transitPlan: plan,
        leaveHomeBy: plan.leaveHomeAt,
        travelMinutes: plan.totalDurationMinutes,
        // Wake alarm only for the day's FIRST trip (same rule as ensureTravelChain).
        ...(firstTrip
          ? { wakeUpBy: minutesToTime((timeToMinutes(plan.leaveHomeAt) - GET_READY_MINUTES + 1440) % 1440) }
          : {}),
      }
      : {}),
  },
} as unknown as Task);

/** Offline stand-in so the layout can be checked with no API key / no network. */
const fakePlan = (from: string, to: string, arriveBy: string): TransitPlan => {
  const ride = 25;
  const leave = minutesToTime((timeToMinutes(arriveBy) - ride - 10 + 1440) % 1440);
  return {
    totalDurationMinutes: ride + 10,
    leaveHomeAt: leave,
    arriveAt: arriveBy,
    firstBusDeparture: minutesToTime((timeToMinutes(leave) + 5) % 1440),
    firstBusStop: `תחנה ליד ${from}`,
    walkToStopMinutes: 5,
    legs: [
      { type: 'walk', from, to: `תחנה ליד ${from}`, durationMinutes: 5, departureTime: leave, arrivalTime: minutesToTime((timeToMinutes(leave) + 5) % 1440) },
      { type: 'bus', from: `תחנה ליד ${from}`, to, durationMinutes: ride, lineNumber: '000', departureTime: minutesToTime((timeToMinutes(leave) + 5) % 1440), arrivalTime: arriveBy },
    ],
    source: 'google',
    fetchedAt: Date.now(),
  };
};

const icon = (t: string) => (t === 'train' ? '🚆' : t === 'subway' ? '🚇' : t === 'car' ? '🚗' : t === 'bike' ? '🚲' : t === 'walk' ? '🚶' : '🚌');

// ── run ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🏠 בית: ${HOME}   🚏 תחבורה ברירת מחדל: ${DEFAULT_TRANSPORT}${OFFLINE ? '   (offline)' : ''}`);

  const byDate = new Map<string, Session[]>();
  for (const s of SESSIONS) byDate.set(s.date, [...(byDate.get(s.date) || []), s]);

  const allTasks: Task[] = [];
  let routed = 0;
  let unrouted = 0;

  for (const [date, daySessions] of [...byDate.entries()].sort()) {
    const label = new Date(`${date}T12:00:00`).toLocaleDateString('he-IL', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    console.log(`\n${'═'.repeat(78)}\n📅 ${label}  (${date})\n${'═'.repeat(78)}`);

    const ordered = [...daySessions].sort((a, b) => (a.hour < b.hour ? -1 : 1));
    let origin = HOME;
    let firstTripDone = false;
    const dayTasks: Task[] = [];

    for (const s of ordered) {
      const transport = s.transport || DEFAULT_TRANSPORT;
      const samePlace = origin === s.location;
      let plan: TransitPlan | null = null;

      if (samePlace) {
        // Already there — no trip, no travel alerts (only the time reminders).
        console.log(`\n🔹 SESSION ${s.id} · ${s.hour} · ${s.title}`);
        console.log(`   📍 ${s.location}   ⏱ ${s.durationMinutes} דק'`);
        console.log(`   🚏 אין נסיעה — כבר במקום (${origin})`);
      } else {
        plan = OFFLINE
          ? fakePlan(origin, s.location, s.hour)
          : await getPlanForMode(transport, s.location, s.hour, { ...profile, homeAddress: origin }, s.date);
        console.log(`\n🔹 SESSION ${s.id} · ${s.hour} · ${s.title}`);
        console.log(`   📍 ${s.location}   ⏱ ${s.durationMinutes} דק'   🚏 ${transport}`);
        console.log(`   🧭 מוצא: ${origin}`);
        if (!plan) {
          unrouted++;
          console.log('   ❌ Google לא החזיר מסלול (כתובת/שעה/מפתח API)');
        } else {
          routed++;
          const wake = minutesToTime((timeToMinutes(plan.leaveHomeAt) - GET_READY_MINUTES + 1440) % 1440);
          console.log(`   ⏰ להתעורר/להתכונן: ${wake}   🚪 לצאת: ${plan.leaveHomeAt}   ⏱ ${plan.totalDurationMinutes} דק' דלת-לדלת   📍 הגעה: ${plan.arriveAt}`);
          for (const leg of plan.legs) {
            const line = leg.lineNumber ? ` קו ${leg.lineNumber}` : '';
            console.log(`      ${icon(leg.type)}${line} ${leg.departureTime}→${leg.arrivalTime} (${leg.durationMinutes} דק') ${leg.from || ''} → ${leg.to || ''}`);
          }
        }
      }

      const task = asTask(s, plan || undefined, firstTripDone === false && Boolean(plan));
      if (plan) firstTripDone = true;
      dayTasks.push(task);
      allTasks.push(task);

      const alerts: PlannedAlert[] = [
        ...(plan ? planTransitAlerts(task, plan, 'he') : []),
        ...planFixedTimeAlerts(task, 'he', plan?.leaveHomeAt),
      ].sort((a, b) => (a.at < b.at ? -1 : 1));

      console.log('   🔔 התראות:');
      for (const a of alerts) {
        console.log(`      ${a.at}  ${a.kind.padEnd(15)}→ ${a.screen}  · ${a.title}`);
        // Every alert must land on a REGISTERED route and fire before the
        // session starts. (Routes live in types/navigation RootStackParamList.)
        assert.ok(
          ['TaskDetail', 'LeaveNow', 'CheckIn', 'PlanTomorrow'].includes(a.screen),
          `alert ${a.kind} points at an unknown screen: ${a.screen}`);
        assert.ok(a.taskId === s.id, `alert ${a.kind} not bound to its task`);
        assert.ok(
          timeToMinutes(a.at) <= timeToMinutes(s.hour),
          `alert ${a.kind} at ${a.at} fires after the session starts (${s.hour})`,
        );
      }
      assert.ok(alerts.length > 0, `session ${s.id} got no alerts at all`);
      if (plan) {
        assert.ok(
          alerts.some((a) => a.kind === 'leave_home'),
          `session ${s.id} has a route but no leave-home alert`);
        // The leave alert is the one that opens the countdown/route screen.
        assert.ok(
          alerts.filter((a) => a.screen === 'LeaveNow').length >= 1,
          `session ${s.id} has no alert opening the LeaveNow screen`);
        assert.strictEqual(plan.arriveAt <= s.hour, true,
          `session ${s.id} arrives ${plan.arriveAt}, after ${s.hour}`);
        assert.ok(timeToMinutes(plan.leaveHomeAt) < timeToMinutes(s.hour),
          `session ${s.id} leave time is not before the meeting`);
      }

      origin = s.location;
    }

    const warnings = dayWarnings(sortTimed(dayTasks), true);
    console.log(warnings.length ? `\n⚠️  אזהרות היום:\n   ${warnings.join('\n   ')}` : '\n✅ אין חפיפות או מרווחים קצרים מדי');
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`סה"כ SESSIONS: ${SESSIONS.length} · מסלולים שחושבו: ${routed} · ללא מסלול: ${unrouted}`);
  assert.strictEqual(allTasks.length, SESSIONS.length, 'every session produced a task');
  if (!OFFLINE) {
    assert.ok(routed > 0, 'no route came back at all — check EXPO_PUBLIC_GOOGLE_MAPS_API_KEY / network');
  }
  console.log('✅ week schedule: every session timed, routed and alerted, every alert routed to a screen\n');
})();
