/**
 * transitAlertWindow — which trips get a fresh disruption check, and what to ask about.
 *
 * Koral, 20.10: Meira should look for roadworks, closed train lines and strikes
 * on the way. The server reads the news (POST /app/transit/alerts); this file
 * decides, without any I/O, WHEN a trip is checked and WHAT its route terms are,
 * so the rule is testable in node (tests/run-transit-alerts.ts).
 *
 * The window: a trip leaving in the next 60 minutes, today, not checked in the
 * last 20. That is the push "before leaving" — early enough to leave sooner,
 * late enough that the news is the news of this trip.
 */
import type { Task, TaskLocation, TaskTransitAlerts, TransitAlert } from '../types/index';

export const RECHECK_AHEAD_MIN = 60;
export const RECHECK_EVERY_MIN = 20;

export interface RouteTerms {
  places: string[];
  stations: string[];
  lines: string[];
  modes: string[];
}

function toMinutes(hhmm?: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The structured location, or undefined — an old row may carry a bare string. */
export function locOf(task: Task): TaskLocation | undefined {
  return task.location && typeof task.location === 'object' ? task.location : undefined;
}

/** The trip's leave-home time, if it has one. */
export function leaveTimeOf(task: Task): string | undefined {
  const loc = locOf(task);
  return loc?.leaveHomeBy || loc?.transitPlan?.leaveHomeAt || undefined;
}

/** Trips to (re)check now: today, leaving within RECHECK_AHEAD_MIN, not done,
 *  and not checked in the last RECHECK_EVERY_MIN. */
export function tripsToRecheck(tasks: Task[], now: Date, today: string): Task[] {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return tasks.filter((t) => {
    if (t.date !== today || t.status === 'complete' || t.status === 'missed') return false;
    const leave = toMinutes(leaveTimeOf(t));
    if (leave === null || leave < nowMin || leave - nowMin > RECHECK_AHEAD_MIN) return false;
    const last = locOf(t)?.transitAlerts?.checkedAt ?? 0;
    return now.getTime() - last >= RECHECK_EVERY_MIN * 60_000;
  });
}

/** 'Herzl 12, Haifa, Israel' → ['Herzl', 'Haifa'] — same rule as the server's places_from_address. */
export function placesFromAddress(address?: string): string[] {
  return String(address || '')
    .split(',')
    .map((p) => p.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 2 && !/^(israel|ישראל)$/i.test(p));
}

/** What the news search should look for on this trip. */
export function routeTerms(task: Task, homeAddress?: string): RouteTerms {
  const loc = locOf(task);
  const places = [...placesFromAddress(loc?.address), ...placesFromAddress(homeAddress)];
  const stations: string[] = [];
  const lines: string[] = [];
  const modes: string[] = [];
  for (const leg of loc?.transitPlan?.legs ?? []) {
    if (leg.type === 'walk') continue;
    modes.push(leg.type);
    if (leg.lineNumber) lines.push(String(leg.lineNumber));
    if (leg.stopName) stations.push(leg.stopName);
    if (leg.from) stations.push(leg.from);
    if (leg.to) stations.push(leg.to);
  }
  if (loc?.transportType) modes.push(loc.transportType);
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].slice(0, 12);
  return { places: uniq(places), stations: uniq(stations), lines: uniq(lines), modes: uniq(modes) };
}

/** Alerts she has not been told about yet on this trip (by link). */
export function newAlerts(alerts: TransitAlert[], prev?: TaskTransitAlerts): TransitAlert[] {
  const seen = new Set((prev?.alerts ?? []).map((a) => a.link));
  return alerts.filter((a) => a.link && !seen.has(a.link));
}

/** The push: one short line, the task, the first headline. */
export function alertPush(task: Task, alert: TransitAlert, he: boolean): { title: string; body: string } {
  return he
    ? { title: `⚠️ ייתכן שיבוש בדרך ל${task.text}`, body: `${alert.title} — כדאי לצאת קצת קודם` }
    : { title: `⚠️ Possible disruption on the way to ${task.text}`, body: `${alert.title} — consider leaving a bit earlier` };
}
