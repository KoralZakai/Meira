/**
 * run-feasibility-differential — does the app judge a day the way an
 * independently written rule does?
 *
 * src/utils/resolveClashes.ts and server/clashes.py are two copies of one rule,
 * kept honest by run-clash-parity. tests/fixtures/meira-sim/generators/
 * scheduler.py is a THIRD, written in a separate session against a different
 * schema, and its verdicts are checked in as golden files: 434 transitions over
 * twelve edge-case users and three simulated personas. Agreement with a rule
 * nobody here wrote is a much stronger signal than two copies agreeing.
 *
 * The app is run for real, not re-created: each user's days go in as raw
 * Google Calendar items, through GoogleService → GoogleSync.syncCalendarForDate
 * (the import) → GoogleSync.ensureTravelChain (routing, answered with the
 * golden travel minutes) → TaskStorage, and resolveClashes judges the day the
 * app ends up holding. So a verdict here is what her phone would say.
 *
 * Mapping, per golden transition prev → next:
 *   app OVERLAP            resolveClashes reports a clash with `next` as the
 *                          later task and overlapMinutes > 0
 *   app INFEASIBLE_TRAVEL  …with no overlap but a travel shortfall
 *   app TIGHT /            no clash, and the app's day judge
 *       WAKE_CONFLICT      (utils/dayFeasibility.judgeDay — what dayWarnings
 *                          and answerFeasibility say) flags `next`
 *   app OK                 none of the above
 * The judge's margin and wake floor come from the app's PROFILE: the buffer,
 * earliest wake and car the persona has, and the departure delay it had
 * learned by that date (the fixture's learning trace for sim, the edge users'
 * recorded average). The judge must also agree with resolveClashes wherever
 * both speak (OVERLAP / INFEASIBLE_TRAVEL) — two readers of one day.
 *
 * Nothing is relaxed to get green: every golden row is a check, the fixture is
 * read-only, and Noa Levi (user 103) is the control — any warning on her month
 * is a false positive.
 *
 * Run:  npm run test:differential
 */
import './support/fixedClock';   // before any import that reads the clock
import {
  bootUser, collectWarnings, googleItem, installFixtureRouting, setCalendar, setDepartDelay, taskIdOf,
} from './meira-sim-app';
import {
  FeasibilityRow, RouteAsk, byUserDay, goldenRouteSource, goldenTravel,
  loadFeasibility, loadLearnedMargins, loadLocations, loadMeetings, loadUsers,
} from './meira-sim-fixture';
import type { Task } from '../src/types/index';

/* eslint-disable @typescript-eslint/no-var-requires */
const GoogleSync = require('../src/services/GoogleSync');
const TaskStorage = require('../src/services/TaskStorage');
const { resolveClashes } = require('../src/utils/resolveClashes');
const { dayWarnings, sortTimed } = require('../src/utils/dayPlanning');
const { classifyOverlap } = require('../src/utils/overlapKind');
const { judgeDay, feasibilityOptionsOf } = require('../src/utils/dayFeasibility');
const { normalizeProfile } = require('../src/utils/profileShape');
const { loadProfile } = require('../src/services/UserProfileStorage');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

type AppStatus = 'OK' | 'TIGHT' | 'INFEASIBLE_TRAVEL' | 'OVERLAP' | 'WAKE_CONFLICT';
const EXPECTED = ['OK', 'TIGHT', 'INFEASIBLE_TRAVEL', 'OVERLAP', 'WAKE_CONFLICT'] as const;
const ACTUAL: AppStatus[] = ['OK', 'TIGHT', 'INFEASIBLE_TRAVEL', 'OVERLAP', 'WAKE_CONFLICT'];

interface Judged {
  row: FeasibilityRow;
  app: AppStatus;
  /** What the other task in the deciding clash was, when it was not a fixture meeting. */
  blamedOn?: string;
  goldenTravel: number;
  appTravel?: number;
  dayWarning?: string;
  overlapKind?: string;
  wakeUpBy?: string;
  /** The vehicle(s) the app actually chose for the trip into `next`. */
  appVehicle?: string;
  /** The day judge's own reading of `next`, and its margin. */
  judge?: string;
  judgeMargin?: number;
  /** The judge and resolveClashes disagree on an overlap / travel verdict. */
  readersDisagree?: string;
}

/** Why a row disagrees — descriptive, from the golden columns and the stored task. */
function causeOf(j: Judged): string {
  const { row } = j;
  if (row.toId !== 'online' && j.appTravel !== undefined && j.appTravel !== j.goldenTravel) {
    return `travel not delivered (app used ${j.appTravel}, golden ${j.goldenTravel})`;
  }
  if (j.blamedOn) return `app-created block "${j.blamedOn}"`;
  if (j.judgeMargin !== undefined && Math.abs(j.judgeMargin - row.margin) > 0.05) {
    return `margin differs (app ${j.judgeMargin}, golden ${row.margin})`;
  }
  if (row.status === 'TIGHT' && j.app === 'OK') return 'the app judged the gap comfortable';
  if (row.status === 'WAKE_CONFLICT' && j.app === 'OK') return 'the app accepted the wake time';
  if (row.status === 'OK') return 'false alarm';
  return 'missed';
}

async function judgeDataset(dataset: 'edge' | 'sim') {
  const locations = loadLocations();
  const users = loadUsers(dataset);
  const meetings = loadMeetings(dataset);
  const rows = loadFeasibility(dataset);
  const golden = goldenTravel(rows);
  const meetingsByUserDay = byUserDay(meetings);
  const rowsByUserDay = byUserDay(rows);
  const judged: Judged[] = [];
  const offGolden: RouteAsk[] = [];
  let unmappedTotal = 0;
  const noaFindings: string[] = [];
  const readerSplits: string[] = [];
  const margins = loadLearnedMargins();

  for (const [userId, days] of rowsByUserDay) {
    const user = users.get(userId)!;
    await bootUser(user);
    const { unmapped } = installFixtureRouting(
      user, locations, goldenRouteSource(user, locations, golden, offGolden), meetings);
    const own = meetings.filter((m) => m.userId === userId);
    setCalendar(own.map((m) => googleItem(m, locations)));

    for (const [date, dayRows] of [...days.entries()].sort()) {
      // What the app has learned about her lateness by this date.
      if (dataset === 'sim') {
        const m = margins.get(`${userId}|${date}`);
        if (m !== undefined) await setDepartDelay(Math.round((m - user.buffer) * 100) / 100);
      }
      await collectWarnings(async () => {
        await GoogleSync.syncCalendarForDate(date, 'en');
        await GoogleSync.ensureTravelChain(date, 'en');
      });
      const tasks: Task[] = await TaskStorage.getTasksForDate(date);
      const dayMeetings = meetingsByUserDay.get(userId)?.get(date) ?? [];
      const fixtureIds = new Set(dayMeetings.map((m) => taskIdOf(m)));
      const byMeeting = new Map<string, Task>(
        dayMeetings.map((m) => [m.id, tasks.find((t) => t.id === taskIdOf(m))!]));

      const clashes = resolveClashes(tasks);
      // The same options analyzeWeek hands dayWarnings: from her profile.
      const opts = feasibilityOptionsOf(normalizeProfile(await loadProfile()));
      const warnings: string[] = dayWarnings(sortTimed(tasks), false, opts);
      const judgedDay = new Map<string, any>(judgeDay(tasks, opts).map((t: any) => [t.taskId, t]));

      for (const row of dayRows) {
        const next = byMeeting.get(row.nextId);
        const j: Judged = { row, app: 'OK', goldenTravel: row.travel };
        if (!next) {
          // The import dropped a meeting the fixture holds: that is a finding
          // about the import, and the row cannot agree.
          judged.push({ ...j, app: 'OK', blamedOn: 'MEETING NOT IMPORTED' });
          continue;
        }
        const loc: any = typeof next.location === 'object' ? next.location : undefined;
        j.appTravel = typeof loc?.travelMinutes === 'number' ? loc.travelMinutes : undefined;
        j.wakeUpBy = loc?.wakeUpBy;
        const rides = (loc?.transitPlan?.legs ?? []).map((l: any) => l.type).filter((t: string) => t !== 'walk');
        j.appVehicle = rides.length ? [...new Set(rides)].join('+') : loc?.transitPlan?.legs?.[0]?.type;
        for (const c of clashes) {
          if (c.b.id !== next.id) continue;
          const status: AppStatus = c.overlapMinutes > 0 ? 'OVERLAP' : 'INFEASIBLE_TRAVEL';
          const worse = status === 'OVERLAP' || j.app === 'OK';
          if (worse) {
            j.app = status;
            j.blamedOn = fixtureIds.has(c.a.id) ? undefined : c.a.text;
          }
        }
        const jd = judgedDay.get(next.id);
        j.judge = jd?.status;
        j.judgeMargin = jd && row.toId !== 'online' ? Math.round(jd.margin * 100) / 100 : undefined;
        if (jd && (jd.status === 'OVERLAP' || jd.status === 'INFEASIBLE_TRAVEL' || j.app !== 'OK')
          && (j.app === 'OVERLAP' || j.app === 'INFEASIBLE_TRAVEL' || jd.status === 'OVERLAP' || jd.status === 'INFEASIBLE_TRAVEL')
          && jd.status !== j.app) {
          j.readersDisagree = `resolveClashes ${j.app}, judgeDay ${jd.status}`;
          readerSplits.push(`${userId} ${date} → ${next.text}: ${j.readersDisagree}`);
        }
        if (j.app === 'OK' && jd && (jd.status === 'TIGHT' || jd.status === 'WAKE_CONFLICT')) j.app = jd.status;
        j.dayWarning = warnings.find((w) => w.includes(`and "${next.text}"`) || w.includes(`"${next.text}" needs you up`));
        for (const other of tasks) {
          if (other.id === next.id) continue;
          const v = classifyOverlap(other, next, j.appTravel);
          if (v) j.overlapKind = v.kind;
        }
        judged.push(j);

        if (userId === '103') {
          if (j.app !== 'OK') noaFindings.push(`${date} → ${next.text}: resolveClashes ${j.app}`);
          if (j.dayWarning) noaFindings.push(`${date} → ${next.text}: dayWarnings "${j.dayWarning}"`);
          if (j.overlapKind === 'spatial' || j.overlapKind === 'displaced') {
            noaFindings.push(`${date} → ${next.text}: classifyOverlap ${j.overlapKind}`);
          }
        }
      }
    }
    unmappedTotal += unmapped.length;
  }
  return { judged, offGolden, unmappedTotal, noaFindings, readerSplits };
}

function printMatrix(judged: Judged[]) {
  const cell = (e: string, a: string) => judged.filter((j) => j.row.status === e && j.app === a).length;
  console.log(`    ${'expected \\ app'.padEnd(18)}${ACTUAL.map((a) => a.padStart(19)).join('')}`);
  for (const e of EXPECTED) {
    const counts = ACTUAL.map((a) => String(cell(e, a)).padStart(19)).join('');
    const total = judged.filter((j) => j.row.status === e).length;
    if (total) console.log(`    ${e.padEnd(18)}${counts}`);
  }
}

async function main() {
  console.log('\nrun-feasibility-differential — the app (for real) vs scheduler.py\'s golden verdicts\n');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  check('the run uses the Jerusalem zone database', zone === 'Asia/Jerusalem', zone);

  for (const dataset of ['edge', 'sim'] as const) {
    const { judged, offGolden, unmappedTotal, noaFindings, readerSplits } = await judgeDataset(dataset);
    const physical = judged.filter((j) => j.row.toId !== 'online');
    const delivered = physical.filter((j) => j.appTravel === j.goldenTravel).length;
    console.log(`\n${dataset} · ${judged.length} golden transitions`);
    console.log(`  travel input: ${delivered}/${physical.length} arrived on the task with the golden minutes`
      + ` · ${offGolden.length} routing question(s) off-golden · ${unmappedTotal} unmapped`);
    printMatrix(judged);
    const offInput = physical.filter((j) => j.appTravel !== j.goldenTravel);
    for (const j of offInput) {
      const r = j.row;
      console.log(`    · judged on non-golden travel: user ${r.userId} ${r.date} ${r.fromId}→${r.toId}`
        + ` golden ${r.travel}, stored ${j.appTravel ?? 'none'}${j.appVehicle ? ` (${j.appVehicle})` : ''} → ${j.app}`
        + (r.fromId === r.toId ? ' (same place: no trip either way)' : ''));
    }

    const agree = judged.filter((j) => j.app === (j.row.status as string));
    const perUser = byUserDay(judged.map((j) => ({ ...j, userId: j.row.userId, date: j.row.date })));
    for (const [userId] of perUser) {
      const mine = judged.filter((j) => j.row.userId === userId);
      const ok = mine.filter((j) => j.app === (j.row.status as string)).length;
      if (ok === mine.length) check(`${dataset} user ${userId}: ${ok}/${mine.length} transitions agree`, true);
    }
    for (const j of judged) {
      if (j.app === (j.row.status as string)) continue;
      const r = j.row;
      check(
        `${dataset} user ${r.userId} ${r.date} ${r.prevId ?? 'home'}→${r.nextId} (${r.fromId}→${r.toId})`
          + ` expected ${r.status}, app ${j.app}`,
        false,
        `${causeOf(j)} · gap ${r.gap ?? '—'} · travel ${r.travel} · margin ${r.margin}`
          + (j.appVehicle ? ` · app went by ${j.appVehicle}` : '')
          + (r.requiredWake ? ` · golden wake ${r.requiredWake}, app wake ${j.wakeUpBy ?? '—'}` : '')
          + (j.dayWarning ? ` · dayWarnings: ${j.dayWarning}` : '')
          + (j.overlapKind ? ` · overlapKind: ${j.overlapKind}` : ''),
      );
    }
    console.log(`  agreement: ${agree.length}/${judged.length}`);
    check(`${dataset}: the day judge and resolveClashes agree on every overlap / travel verdict`,
      readerSplits.length === 0, readerSplits.slice(0, 4).join(' | ') || 'same reading');

    if (dataset === 'sim') {
      console.log('\nNoa Levi (user 103) — the control. Every warning is a false positive.');
      check('no feasibility warning of any kind on Noa\'s month', noaFindings.length === 0,
        noaFindings.length ? noaFindings.join(' | ') : 'none raised');
    }
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ run-feasibility-differential crashed:', e);
  process.exit(1);
});

