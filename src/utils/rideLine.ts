/**
 * rideLine — which bus, from where, at what time, in one line.
 *
 * Koral, 1.10: "it's not clear which bus to take and from where". The leave
 * pill said WHEN; the line and the stop were a tap away, and inside a "which
 * one?" card they were nowhere. One helper, so the day card and the clash
 * card say it the same way.
 */
import { Task, TransitLeg } from '../types/index';

export const RIDE_ICON: Record<string, string> = { train: '🚆', subway: '🚇', bus: '🚌' };

/** The rides of a timetabled plan, in order — bike / car / walk have none. */
export function ridesOf(task: Task): TransitLeg[] {
  const loc: any = task.location && typeof task.location === 'object' ? task.location : undefined;
  return ((loc?.transitPlan?.legs || []) as TransitLeg[])
    .filter((l) => l && RIDE_ICON[l.type] && (l.stopName || l.from) && l.to);
}

/** "🚌 61 · from Ibn Gabirol/Arlozorov · 22:24" — or '' when there is no ride. */
export function firstRideLine(task: Task, he: boolean): string {
  const ride = ridesOf(task)[0];
  if (!ride) return '';
  return `${RIDE_ICON[ride.type]} ${[ride.lineNumber, (he ? 'מ־' : 'from ') + (ride.stopName || ride.from), ride.departureTime]
    .filter(Boolean).join(' · ')}`;
}

/**
 * The whole door-to-door story, walks included.
 *
 * Koral, 13.10: "the plan is missing the walking times from place to place —
 * from where I am now to the train, when EXACTLY the train leaves, how long
 * the walk is to the next place". The card drew the rides and dropped every
 * walking leg, so a 13-minute walk from the station was nowhere, and "leave
 * 10:29" and "train 10:34" sat on the card with nothing explaining the gap.
 *
 * One step per thing she does, in order. Consecutive walks are one walk.
 */
export type JourneyStep =
  /** `reach`: when she gets to the end of the walk — leave + walk for the
   *  first one (Google's own walk clock can disagree with our leave time, and
   *  "Leave 14:52" beside "walk 14:57" reads as a mistake), the previous
   *  ride's arrival + walk after that. */
  | { kind: 'walk'; minutes: number; at: string; reach: string; to: string; role: 'to-stop' | 'transfer' | 'to-place' }
  | { kind: 'ride'; leg: TransitLeg };

const plus = (hhmm: string, m: number): string => {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm || '')) return '';
  const t = (Number(hhmm.split(':')[0]) * 60 + Number(hhmm.split(':')[1]) + Math.round(m) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export function journeySteps(legs: TransitLeg[] | undefined, placeName: string, leaveAt?: string): JourneyStep[] {
  const all = (legs ?? []).filter(Boolean);
  const firstRide = all.findIndex((l) => RIDE_ICON[l.type]);
  if (firstRide < 0) return [];
  const out: JourneyStep[] = [];
  let walk: { minutes: number; at: string } | null = null;
  let ridesSeen = 0;
  let lastArrival = '';
  const flush = (to: string, role: 'to-stop' | 'transfer' | 'to-place') => {
    // Under a minute is "cross the road", not a step.
    if (walk && walk.minutes >= 1) {
      const at = role === 'to-stop' ? (leaveAt || walk.at) : (lastArrival || walk.at);
      out.push({ kind: 'walk', minutes: Math.round(walk.minutes), at, reach: plus(at, walk.minutes), to, role });
    }
    walk = null;
  };
  for (const l of all) {
    if (RIDE_ICON[l.type]) {
      flush(l.stopName || l.from, ridesSeen === 0 ? 'to-stop' : 'transfer');
      out.push({ kind: 'ride', leg: l });
      ridesSeen += 1;
      lastArrival = l.arrivalTime;
    } else if (l.type === 'walk') {
      walk = walk
        ? { minutes: walk.minutes + (l.durationMinutes || 0), at: walk.at }
        : { minutes: l.durationMinutes || 0, at: l.departureTime };
    }
  }
  flush(placeName, 'to-place');
  return out;
}

/** "line 22" / "קו 22" — the words for a bus number, one place. */
export const lineWord = (line: string, he: boolean): string => (he ? `קו ${line}` : `line ${line}`);

/** One step of the closed card's route: a walk, or a ride with its line and its minute. */
export interface RouteChip {
  kind: 'walk' | 'ride';
  icon: string;
  /** The bus / line number — the thing she matches against the bus in front of her. */
  line?: string;
  /** When the ride leaves. */
  time?: string;
  /** A walk: "5 min" / "5 דק׳". */
  text?: string;
}

/**
 * The closed card's route as separate steps, so each one can wrap onto its own
 * line instead of being cut. 18.10, Koral: "buses to today's event were really
 * unclear — missed the bus line!" The route was ONE sentence cut at two lines,
 * "🚌 12:28 line 22 → 🚌 12:35 lin…": the second bus's number was the end of the
 * sentence, so it was the part that went — and the stop it leaves from, last
 * of all, never showed. The line number now leads its step, and no step is
 * ever shortened.
 */
export function routeChips(task: Task, he: boolean): { chips: RouteChip[]; from: string } {
  const loc: any = task.location && typeof task.location === 'object' ? task.location : undefined;
  const steps = journeySteps(loc?.transitPlan?.legs, '', loc?.transitPlan?.leaveHomeAt);
  const rides = steps.filter((x): x is { kind: 'ride'; leg: TransitLeg } => x.kind === 'ride');
  if (!rides.length) return { chips: [], from: '' };
  const min = (m: number) => (he ? `${m} דק׳` : `${m} min`);
  const before = steps[0]?.kind === 'walk' ? steps[0] : null;
  const last = steps[steps.length - 1];
  const after = last?.kind === 'walk' && last.role === 'to-place' ? last : null;
  const chips: RouteChip[] = [
    ...(before ? [{ kind: 'walk' as const, icon: '🚶', text: min(before.minutes) }] : []),
    ...rides.map(({ leg }) => ({
      kind: 'ride' as const, icon: RIDE_ICON[leg.type], line: leg.lineNumber || undefined, time: leg.departureTime || undefined,
    })),
    ...(after ? [{ kind: 'walk' as const, icon: '🚶', text: min(after.minutes) }] : []),
  ];
  const first = rides[0].leg;
  const stop = first.stopName || first.from;
  return { chips, from: stop ? `${he ? 'מ־' : 'from '}${stop}` : '' };
}

/**
 * "🚶 5 דק׳ ← 🚌 קו 10 · 10:31 ← 🚆 10:48 ← 🚶 13 דק׳ · מ־סבידור" — the route as one
 * line, for the screen reader and anything that cannot lay out chips. The line
 * number comes BEFORE the minute: it is what she has to recognise. In Hebrew the
 * line is a right-to-left paragraph, so the steps run leftwards and the joiner
 * is ← (same rule as neighbourLine).
 */
export function walkRideWalkLine(task: Task, he: boolean): string {
  const { chips, from } = routeChips(task, he);
  if (!chips.length) return '';
  return chips.map((c) => (c.kind === 'walk'
    ? `${c.icon} ${c.text}`
    : `${c.icon} ${[c.line ? lineWord(c.line, he) : '', c.time].filter(Boolean).join(' · ')}`))
    .join(he ? ' ← ' : ' → ')
    + (from ? ` · ${from}` : '');
}
