/**
 * meira-sim-fixture — read-only access to tests/fixtures/meira-sim/data.
 *
 * The fixture is the specification: three simulated personas living 28 days
 * (sim_*), twelve hand-built edge-case users (edge_*), and fifteen decision
 * scenarios, with golden files written by an independent implementation
 * (tests/fixtures/meira-sim/generators/scheduler.py). Nothing here writes to
 * that folder, and nothing here computes an expected value: expected values
 * are read from the golden files, never derived.
 *
 * The one thing ported is the fixture's TRAVEL MODEL (personas.predict_legs).
 * It is an input, not a rule under test — the app gets its travel minutes from
 * Google, the fixture from a distance model, and a test has to hand the app the
 * fixture's numbers or it is comparing two travel models instead of two
 * feasibility rules. `travelModelMismatches` checks the port against every
 * minute the fixture recorded, so a drifting port fails loudly instead of
 * quietly shifting verdicts.
 *
 * Dependencies: node fs/path only. Consumed by run-feasibility-differential,
 * run-meira-sim-month and run-decision-scenarios.
 */
import * as fs from 'fs';
import * as path from 'path';

export const SIM_ROOT = path.join(__dirname, 'fixtures', 'meira-sim');
const DATA = path.join(SIM_ROOT, 'data');

type Row = Record<string, string>;

/** CSV with quoted fields (addresses contain commas). */
export function readCsv(name: string): Row[] {
  const text = fs.readFileSync(path.join(DATA, name), 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n');
  const split = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; continue; }
        quoted = !quoted;
        continue;
      }
      if (ch === ',' && !quoted) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const header = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

export function readJson<T = any>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')) as T;
}

const n = (s: string | undefined): number | undefined =>
  s === undefined || s === '' ? undefined : Number(s);

// ── entities ──────────────────────────────────────────────────────────────

export interface FixtureLocation {
  id: string; name: string; kind: string; lat: number; lng: number; address: string; placeId: string;
}

export interface FixtureUser {
  id: string;
  name: string;
  homeAddress: string;
  home: [number, number];
  /** The fixture's mode word: car | train | bus | bike | walk | scooter. */
  mode: string;
  routine: number;
  buffer: number;
  earliestWake: string;
  /** Edge users: the learned delay the golden margins were built with. */
  avgDelay: number;
  /** Every way this person gets around (primary first) — sim other_modes / edge transport types. */
  modes: string[];
}

export interface FixtureMeeting {
  dataset: 'sim' | 'edge';
  id: string;
  userId: string;
  locationId?: string;
  title: string;
  category: string;
  date: string;
  startAt: string;
  endAt: string;
  startLocal: string;
  endLocal: string;
  isOnline: boolean;
  meetingUrl?: string;
}

export interface FeasibilityRow {
  dataset: 'sim' | 'edge';
  userId: string;
  date: string;
  prevId?: string;
  nextId: string;
  fromId: string;
  toId: string;
  gap?: number;
  travel: number;
  margin: number;
  slack?: number;
  requiredWake?: string;
  status: 'OK' | 'TIGHT' | 'INFEASIBLE_TRAVEL' | 'OVERLAP' | 'WAKE_CONFLICT';
}

export function loadLocations(): Map<string, FixtureLocation> {
  return new Map(readCsv('locations.csv').map((r) => [r.id, {
    id: r.id, name: r.name, kind: r.kind, lat: Number(r.lat), lng: Number(r.lng),
    address: r.address, placeId: r.google_place_id,
  }]));
}

export function loadUsers(dataset: 'sim' | 'edge'): Map<string, FixtureUser> {
  const rows = readCsv(dataset === 'sim' ? 'sim_users.csv' : 'edge_users.csv');
  const extra = new Map<string, string[]>();
  if (dataset === 'edge') {
    for (const r of readCsv('edge_user_transport_types.csv')) {
      if (r.is_primary === '1') continue;
      extra.set(r.user_id, [...(extra.get(r.user_id) ?? []), r.transport_type]);
    }
  }
  return new Map(rows.map((r) => [r.id, {
    modes: [r.transportation_type, ...(dataset === 'sim'
      ? (r.other_modes || '').split('|').filter(Boolean)
      : extra.get(r.id) ?? [])],
    id: r.id,
    name: r.name,
    homeAddress: r.home_address,
    home: [Number(r.home_lat), Number(r.home_lng)] as [number, number],
    mode: r.transportation_type,
    routine: Number(r.morning_routine_minutes),
    buffer: Number(r.buffer_minutes),
    earliestWake: r.earliest_wake_time,
    avgDelay: n(r.avg_lateness_minutes ?? r.initial_avg_lateness_minutes) ?? 0,
  }]));
}

export function loadMeetings(dataset: 'sim' | 'edge'): FixtureMeeting[] {
  return readCsv(dataset === 'sim' ? 'sim_meetings.csv' : 'edge_meetings.csv').map((r) => ({
    dataset,
    id: r.id,
    userId: r.user_id,
    locationId: r.location_id || undefined,
    title: r.title,
    category: r.category,
    date: r.date,
    startAt: r.start_at,
    endAt: r.end_at,
    startLocal: r.start_local,
    endLocal: r.end_local,
    isOnline: r.is_online === '1',
    meetingUrl: r.meeting_url || undefined,
  }));
}

export function loadFeasibility(dataset: 'sim' | 'edge'): FeasibilityRow[] {
  return readCsv(dataset === 'sim' ? 'sim_feasibility.csv' : 'edge_feasibility.csv').map((r) => ({
    dataset,
    userId: r.user_id,
    date: r.date,
    prevId: r.prev_meeting_id || undefined,
    nextId: r.next_meeting_id,
    fromId: r.from_id,
    toId: r.to_id,
    gap: n(r.gap_min),
    travel: Number(r.travel_min),
    margin: Number(r.margin_min),
    slack: n(r.slack_min),
    requiredWake: r.required_wake_local || undefined,
    status: r.status as FeasibilityRow['status'],
  }));
}

/** Group anything with userId + date into user → date → items. */
export function byUserDay<T extends { userId: string; date: string }>(items: T[]): Map<string, Map<string, T[]>> {
  const out = new Map<string, Map<string, T[]>>();
  for (const it of items) {
    if (!out.has(it.userId)) out.set(it.userId, new Map());
    const days = out.get(it.userId)!;
    if (!days.has(it.date)) days.set(it.date, []);
    days.get(it.date)!.push(it);
  }
  return out;
}

// ── travel model (INPUT) — a port of generators/personas.py predict_legs ──

export function haversineKm(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const [la1, lo1] = a; const [la2, lo2] = b;
  const p1 = rad(la1); const p2 = rad(la2);
  const dp = p2 - p1; const dl = rad(lo2 - lo1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371.0 * Math.asin(Math.sqrt(h));
}

export function rushFactor(hour: number): number {
  if (hour >= 7 && hour < 9) return 1.45;
  if (hour >= 16 && hour < 19) return 1.40;
  if ((hour >= 6 && hour < 7) || (hour >= 9 && hour < 10) || (hour >= 15 && hour < 16)) return 1.15;
  return 1.0;
}

const TRAIN_HEADWAY_MIN = 20;
const BUS_HEADWAY_MIN = 12;

export interface PredictedLeg { type: 'walk' | 'wait' | 'bike' | 'scooter' | 'car' | 'bus' | 'train'; minutes: number }

/** The legs the fixture's planner believes in (personas.predict_legs). */
export function predictLegs(
  origin: [number, number], dest: [number, number], mode: string, departHour: number,
): PredictedLeg[] {
  const km = haversineKm(origin, dest) * 1.3;
  if (km < 0.05) return [];
  switch (mode) {
    case 'walk': return [{ type: 'walk', minutes: Math.ceil((km / 5) * 60) }];
    case 'bike': return [{ type: 'bike', minutes: Math.ceil((km / 15) * 60) + 2 }];
    case 'scooter': return [{ type: 'scooter', minutes: Math.ceil((km / 18) * 60) + 2 }];
    case 'car': {
      const spd = km < 15 ? 26 : 78;
      return [{ type: 'car', minutes: Math.ceil((km / spd) * 60 * rushFactor(departHour)) + 7 }];
    }
    case 'bus': {
      const spd = km < 20 ? 16 : 45;
      const ride = (km / spd) * 60 * (rushFactor(departHour) > 1.2 ? 1.25 : 1.0);
      return [
        { type: 'walk', minutes: 5 },
        { type: 'wait', minutes: Math.floor(BUS_HEADWAY_MIN / 2) },
        { type: 'bus', minutes: Math.ceil(ride) },
        { type: 'walk', minutes: 4 },
      ];
    }
    case 'train': {
      if (km < 12) return predictLegs(origin, dest, 'bus', departHour);   // no useful rail
      return [
        { type: 'walk', minutes: 12 },
        { type: 'wait', minutes: Math.floor(TRAIN_HEADWAY_MIN / 2) },
        { type: 'train', minutes: Math.ceil((km / 78) * 60) },
        { type: 'walk', minutes: 9 },
      ];
    }
    default: throw new Error(`unknown mode ${mode}`);
  }
}

/** Predicted door-to-door minutes, exactly as the fixture's planner believes. */
export function predictMinutes(
  origin: [number, number], dest: [number, number], mode: string, departHour: number,
): number {
  return predictLegs(origin, dest, mode, departHour).reduce((s, l) => s + l.minutes, 0);
}

/**
 * Every RAW prediction the simulator recorded (sim_transit_plans
 * .predicted_minutes), re-predicted by the port at the simulator's own departure
 * guess — the end of the day's latest commitment so far, or an hour before the
 * meeting for the first trip. Returns the rows that disagree; empty means the
 * port IS the model scheduler.py plans with.
 *
 * (The edge set is not checked here: gen_mock.py has its own, different travel
 * formula, and its minutes are read straight from edge_travel_times.csv.)
 */
export function travelModelMismatches(
  users: Map<string, FixtureUser>, locations: Map<string, FixtureLocation>,
  meetings: FixtureMeeting[],
): string[] {
  const where = (userId: string, id: string): [number, number] =>
    (id === 'home' ? users.get(userId)!.home : [locations.get(id)!.lat, locations.get(id)!.lng]);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const bad: string[] = [];
  for (const p of readCsv('sim_transit_plans.csv')) {
    const m = byId.get(p.meeting_id)!;
    const earlier = meetings.filter((x) => x.userId === m.userId && x.date === m.date
      && hhmmToMin(x.startLocal) < hhmmToMin(m.startLocal));
    const freeAt = earlier.length ? Math.max(...earlier.map((x) => hhmmToMin(x.endLocal))) : undefined;
    const hour = Math.floor((freeAt ?? hhmmToMin(m.startLocal) - 60) / 60);
    const got = predictMinutes(where(m.userId, p.origin_id), where(m.userId, p.dest_id), p.mode, hour);
    if (got !== Number(p.predicted_minutes)) {
      bad.push(`meeting ${p.meeting_id} ${p.origin_id}→${p.dest_id} ${p.mode}@${hour}: `
        + `fixture ${p.predicted_minutes}, port ${got}`);
    }
  }
  return bad;
}

// ── routing answers for the app ───────────────────────────────────────────

/** One routing question, already mapped to fixture place ids ('home' or a location id). */
export interface RouteAsk {
  from: string;
  to: string;
  date: string;
  /** The app's word: car / bike / walk / rail / bus / transit. */
  mode: string;
  arriveBy?: string;
  departEpoch?: number;
}
export type RouteSource = (ask: RouteAsk) => PredictedLeg[] | null;

/**
 * Door-to-door minutes the golden files used, keyed `user|date|from|to`. These are
 * the fixture's PLANNED minutes (raw prediction × learned bias on sim days,
 * the edge table on edge days) — the exact travel each golden verdict was
 * computed with.
 */
export function goldenTravel(rows: FeasibilityRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.toId === 'online') continue;
    const key = `${r.userId}|${r.date}|${r.fromId}|${r.toId}`;
    if (!out.has(key)) out.set(key, r.travel);
  }
  return out;
}

/**
 * Answer the app with the golden minutes, shaped like the vehicle it asked
 * for. A public-transport answer keeps the fixture's own access / wait /
 * egress legs and gives the ride the rest, so a "train" the fixture routes by
 * bus (under 12 km) comes back as a bus — which is what the app's rail filter
 * has to cope with in reality too.
 *
 * The fixture has ONE travel time per transition. Whatever vehicle the app
 * asks about, that is the time it gets — otherwise the app's multi-modal
 * choice (a bus when the train is slow) would be compared against a rule that
 * only ever considers the user's primary mode, and the differential would be
 * measuring mode choice instead of the feasibility rule.
 *
 * Questions the golden files never answered (a pair the fixture did not plan)
 * fall back to the raw model at the asked hour and are recorded in
 * `offGolden`, so the report can say which verdicts rest on fixture travel and
 * which do not.
 */
export function goldenRouteSource(
  user: FixtureUser, locations: Map<string, FixtureLocation>,
  golden: Map<string, number>, offGolden: RouteAsk[],
): RouteSource {
  const where = (id: string): [number, number] =>
    (id === 'home' ? user.home : [locations.get(id)!.lat, locations.get(id)!.lng]);
  const hourOf = (a: RouteAsk): number => {
    if (a.departEpoch) return new Date(a.departEpoch * 1000).getHours();
    if (a.arriveBy) return Math.max(0, Math.floor(hhmmToMin(a.arriveBy) / 60) - 1);
    return 9;
  };
  const vehicleFor = (mode: string): string => {
    if (mode === 'rail') return 'train';
    if (mode === 'transit') return user.mode === 'bus' ? 'bus' : 'train';
    return mode;
  };
  return (a) => {
    if (a.from === a.to) return [];
    const vehicle = vehicleFor(a.mode);
    const shape = predictLegs(where(a.from), where(a.to), vehicle, hourOf(a));
    const total = golden.get(`${user.id}|${a.date}|${a.from}|${a.to}`);
    if (total === undefined) {
      offGolden.push(a);
      return shape;
    }
    const ride = shape.find((l) => l.type !== 'walk' && l.type !== 'wait');
    if (!ride || shape.length === 1) return [{ type: shape[0]?.type ?? 'walk', minutes: total }];
    const fixed = shape.filter((l) => l !== ride).reduce((s, l) => s + l.minutes, 0);
    if (total <= fixed) return [{ type: 'walk', minutes: total }];
    return shape.map((l) => (l === ride ? { ...l, minutes: total - fixed } : l));
  };
}

// ── small clock helpers for FIXTURE-side values only ─────────────────────
// App-side arithmetic always goes through src/utils/timeUtils.

export const hhmmToMin = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/**
 * The margin (buffer + learned departure delay) each sim persona had on each
 * date — sim_learning_trace.csv `margin_used_minutes`, which is exactly what
 * the golden sim_feasibility rows were judged with (checked: 128/128).
 * Keyed `user|date`.
 */
export function loadLearnedMargins(): Map<string, number> {
  return new Map(readCsv('sim_learning_trace.csv')
    .map((r) => [`${r.user_id}|${r.date}`, Number(r.margin_used_minutes)] as [string, number]));
}
