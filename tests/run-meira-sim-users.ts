/**
 * run-meira-sim-users — the three personas, one at a time, with the REASONS.
 *
 * Koral, 2026-09-27: "test the users, user by user first — Meira should work
 * as a Reason-Act agent: show me the reason why you act as you act; if I find
 * mistakes I will correct you."
 *
 * So this runner does not only assert. For each persona it runs the real app
 * over the fixture month (import → travel ladder → alerts → day judge) and
 * keeps, for every trip and every question, the reasoning the app itself
 * recorded: the ladder's thought / action / observation steps (stored on the
 * trip as `location.routeWhy`), the day judge's verdicts, and the feasibility
 * answers' steps. That is written to a JSON report for review.
 *
 * Travel here is the fixture's own model PER VEHICLE (no golden override), so
 * the vehicle choice is a real choice: a bike trip really is slower than the
 * train on a long run. The fixture's model knows no rail coverage — every
 * train query has an answer — which is the one thing real Google would add.
 *
 * What is asserted is what her rules say must always hold:
 *   - someone with a car who drives, drives;
 *   - someone without a car is never routed by car unless the ladder said
 *     "taxi" and the card says so;
 *   - no bike ride over 45 min and no walk over 40 min is proposed;
 *   - every trip either has a plan or a stated reason, and a "why";
 *   - every answer to "does it fit?" carries its reasoning.
 *
 * Run:  npm run test:users      (report: $MEIRA_REPORT or the OS temp dir)
 */
import './support/fixedClock';   // before any import that reads the clock
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bootUser, collectWarnings, googleItem, installFixtureRouting, setCalendar, setDepartDelay,
} from './meira-sim-app';
import {
  FixtureUser, RouteAsk, goldenRouteSource, loadLearnedMargins, loadLocations, loadMeetings, loadUsers, readJson,
} from './meira-sim-fixture';

/* eslint-disable @typescript-eslint/no-var-requires */
const GoogleSync = require('../src/services/GoogleSync');
const TaskStorage = require('../src/services/TaskStorage');
const { answerFeasibility } = require('../src/services/ScheduleQueryService');
const { judgeDay, feasibilityOptionsOf, isPhysical } = require('../src/utils/dayFeasibility');
const { normalizeProfile } = require('../src/utils/profileShape');
const { loadProfile } = require('../src/services/UserProfileStorage');
const { hasCarOf } = require('../src/utils/travelLadder');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

interface TripRow {
  date: string; time: string; text: string; place: string;
  vehicle?: string; chosenBy?: string; minutes?: number; leave?: string; wake?: string;
  note?: string; why: string[]; failure?: string;
}
interface VerdictRow { date: string; text: string; status: string; reason: string; steps: string[] }
interface AnswerRow { id: string; question: string; answer: string; answerHe: string; verdict: string; steps: string[] }
interface UserReport {
  id: string; name: string;
  profile: { mode: string; modes: string[]; hasCar: boolean; buffer: number; earliestWake: string; routine: number };
  trips: TripRow[]; verdicts: VerdictRow[]; answers: AnswerRow[];
}

/** The language the trips are planned in — `MEIRA_LANG=he` writes every "why" in Hebrew. */
const LANG: 'en' | 'he' = process.env.MEIRA_LANG === 'he' ? 'he' : 'en';

const stepLine = (s: any) => [s.thought, s.action ? `⟶ ${s.action}` : '', s.observation ? `⟹ ${s.observation}` : '']
  .filter(Boolean).join('  ');

const locations = loadLocations();
const users = loadUsers('sim');
const meetings = loadMeetings('sim');
const cases: any[] = readJson('scenarios.json');
const margins = loadLearnedMargins();

async function runUser(user: FixtureUser): Promise<UserReport> {
  console.log(`\n── ${user.name} (${user.id}) — ${user.mode}${user.modes.length > 1 ? ` (+${user.modes.slice(1).join(', ')})` : ''}, `
    + `${user.modes.includes('car') ? 'has a car' : 'no car'}, earliest wake ${user.earliestWake}, buffer ${user.buffer} ──`);
  await bootUser(user);
  const off: RouteAsk[] = [];
  installFixtureRouting(user, locations, goldenRouteSource(user, locations, new Map(), off), meetings);
  const mine = meetings.filter((m) => m.userId === user.id);
  setCalendar(mine.map((m) => googleItem(m, locations)));
  const profile = normalizeProfile(await loadProfile());
  const report: UserReport = {
    id: user.id, name: user.name,
    profile: {
      mode: user.mode, modes: user.modes, hasCar: hasCarOf(profile), buffer: user.buffer,
      earliestWake: user.earliestWake, routine: user.routine,
    },
    trips: [], verdicts: [], answers: [],
  };

  const dates = [...new Set(mine.map((m) => m.date))].sort();
  for (const date of dates) {
    const m = margins.get(`${user.id}|${date}`);
    if (m !== undefined) await setDepartDelay(Math.round((m - user.buffer) * 100) / 100);
    await collectWarnings(async () => {
      await GoogleSync.syncCalendarForDate(date, LANG);
      await GoogleSync.ensureTravelChain(date, LANG);
    });
    const tasks = await TaskStorage.getTasksForDate(date);
    for (const t of tasks.filter((x: any) => isPhysical(x))
      .sort((a: any, b: any) => String(a.fixedTime).localeCompare(String(b.fixedTime)))) {
      const loc: any = t.location;
      report.trips.push({
        date, time: t.fixedTime, text: t.text, place: loc?.address ?? String(t.location ?? ''),
        vehicle: loc?.transportType, chosenBy: loc?.transportTypeBy, minutes: loc?.travelMinutes,
        leave: loc?.leaveHomeBy, wake: loc?.wakeUpBy, note: loc?.modeNote, why: loc?.routeWhy ?? [],
        failure: loc?.routeFailure ? `${loc.routeFailure.kind}${loc.noRouteForMode ? ` (${loc.noRouteForMode})` : ''}` : undefined,
      });
    }
    const opts = feasibilityOptionsOf(normalizeProfile(await loadProfile()));
    for (const v of judgeDay(tasks, opts)) {
      if (v.status === 'OK') continue;
      report.verdicts.push({
        date, text: v.text, status: v.status, reason: v.reasonEn, steps: v.steps.map(stepLine),
      });
    }
  }

  // Her questions — the fixture's scenarios for this persona, asked of the app.
  for (const c of cases.filter((k) => String(k.user_id) === user.id)) {
    const asks: Array<{ id: string; date: string; start?: string; minutes: number; loc?: string | null; what: string }> = [];
    if (c.kind === 'insert') {
      asks.push({ id: c.case_id, date: c.date, start: c.proposal.desired_start_local, minutes: c.proposal.duration_min, loc: c.proposal.location_id, what: c.proposal.title });
    } else if (c.kind === 'interview') {
      for (const s of c.offered_slots) {
        asks.push({ id: `${c.case_id} ${s.date}`, date: s.date, start: s.start_local, minutes: c.proposal.duration_min, loc: c.proposal.location_id, what: c.proposal.title });
      }
    } else if (c.kind === 'cancel') {
      for (const cand of c.candidates) {
        asks.push({ id: `${c.case_id} ${cand.title}`, date: c.date, minutes: cand.duration_min, loc: cand.location_id, what: cand.title });
      }
    }
    for (const a of asks) {
      const q = {
        kind: 'feasibility', date: a.date, minutes: a.minutes, startTime: a.start, what: a.what,
        place: a.loc === null || a.loc === undefined ? undefined : locations.get(String(a.loc))!.address,
      };
      const en = await collectWarnings<any>(() => answerFeasibility(q, 'en'));
      const he = await collectWarnings<any>(() => answerFeasibility(q, 'he'));
      report.answers.push({
        id: a.id,
        question: `${a.minutes} min "${a.what}" on ${a.date}${a.start ? ` at ${a.start}` : ' (any time)'}`,
        answer: en.value.text, answerHe: he.value.text, verdict: en.value.verdict,
        steps: (en.value.steps ?? []).map(stepLine),
      });
    }
  }

  // ── What her rules say must always hold ──────────────────────────────────
  const hasCar = hasCarOf(profile);
  const byCar = report.trips.filter((t) => t.vehicle === 'car');
  if (hasCar && user.mode === 'car') {
    check(`${user.name}: has a car and drives → every trip by car`, byCar.length === report.trips.length,
      `${byCar.length}/${report.trips.length} by car`);
  } else {
    const untold = byCar.filter((t) => !/taxi/i.test(t.note ?? ''));
    check(`${user.name}: no car → never routed by car unless the card says "taxi"`, untold.length === 0,
      untold.slice(0, 2).map((t) => `${t.date} ${t.text}`).join(' | ') || `${byCar.length} taxi trip(s)`);
  }
  const longRides = report.trips.filter((t) => t.vehicle === 'bike' && (t.minutes ?? 0) > 45);
  const longWalks = report.trips.filter((t) => t.vehicle === 'walk' && (t.minutes ?? 0) > 40);
  check(`${user.name}: no bike ride over 45 min, no walk over 40 min`, !longRides.length && !longWalks.length,
    [...longRides, ...longWalks].slice(0, 2).map((t) => `${t.date} ${t.text} ${t.vehicle} ${t.minutes}m`).join(' | ') || 'none');
  const silent = report.trips.filter((t) => !t.leave && !t.failure);
  check(`${user.name}: every trip has a plan or a stated reason`, silent.length === 0,
    silent.slice(0, 2).map((t) => `${t.date} ${t.text}`).join(' | ') || `${report.trips.length} trips`);
  const noWhy = report.trips.filter((t) => t.leave && !t.why.length);
  check(`${user.name}: every planned trip carries its "why"`, noWhy.length === 0,
    noWhy.slice(0, 2).map((t) => `${t.date} ${t.text}`).join(' | ') || 'all explained');
  const bare = report.answers.filter((a) => !a.steps.length);
  check(`${user.name}: every answer carries its reasoning`, bare.length === 0 && report.answers.length > 0,
    `${report.answers.length} answers`);

  const vehicles = report.trips.reduce<Record<string, number>>((acc, t) => {
    const k = `${t.vehicle ?? 'none'}${t.note ? ' *' : ''}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`    trips: ${report.trips.length} · by vehicle ${JSON.stringify(vehicles)} (* = with a note)`);
  console.log(`    day verdicts that are not OK: ${report.verdicts.map((v) => `${v.date} ${v.status}`).join(', ') || 'none'}`);
  return report;
}

async function main() {
  console.log('\nrun-meira-sim-users — the personas one by one, with the reasons\n');
  const out: UserReport[] = [];
  for (const id of ['101', '102', '103']) out.push(await runUser(users.get(id)!));
  const file = process.env.MEIRA_REPORT || path.join(os.tmpdir(), 'meira-sim-users.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n  report: ${file}`);
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ run-meira-sim-users crashed:', e);
  process.exit(1);
});
