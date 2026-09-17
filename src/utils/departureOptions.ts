/**
 * departureOptions — the pure shape of "so what are my choices?".
 *
 * Until now a missed departure produced ONE recomputed plan and a sentence
 * describing it. That is an answer, not a choice: at 09:00, having missed the
 * 08:30, "the next one is 09:15" leaves you unable to see that 09:45 also gets
 * you there in time and lets you finish your coffee. The screens ask for three
 * because three is what makes a decision possible.
 *
 * Everything here is pure — plans in, ranked options out. The Google probing
 * lives in RoutePlanner.getDepartNowOptions; the rendering lives in
 * TransitOptionsList. Splitting it this way is what lets
 * tests/run-departure-options.ts drive every branch with no network and no
 * device.
 */
import { TransitPlan } from '../types/index';

export interface DepartureOption {
  plan: TransitPlan;
  /** HH:MM she has to be moving. Never reads earlier than `after`: a plan
   *  computed at 08:37 that says "leave 08:32" is telling her to time-travel. */
  departAt: string;
  /** Minutes on foot from the door to the first stop — the part she is late by. */
  walkMinutes: number;
  /** HH:MM the VEHICLE leaves. This is the thing that can actually be missed. */
  boardAt?: string;
  /** Where she boards it. */
  boardStop?: string;
  /** HH:MM Google says she is there. */
  arriveAt: string;
  durationMinutes: number;
  /** Vehicles, in order — walking legs are not rides. */
  lines: string[];
  rides: number;
  /** Minutes of slack against the appointment: positive early, negative late. */
  slackMinutes?: number;
  /** True when this option does not make the appointment at all. */
  late: boolean;
  /** The option currently stored on the task. */
  current: boolean;
}

const toMinutes = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const isHHMM = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v);

/** Vehicles only — a walk to the platform is not a ride. */
const ridesOf = (plan: TransitPlan) =>
  (plan.legs ?? []).filter((l) => l.type !== 'walk');

/**
 * Two routes on the same lines leaving at the same minute are one option
 * printed twice. Google returns those routinely (different walking paths to
 * the same platform), and a list of three that is really one option repeated
 * is worse than a list of one.
 */
export function optionSignature(plan: TransitPlan): string {
  const lines = ridesOf(plan).map((l) => l.lineNumber || l.type).join('+');
  return `${plan.leaveHomeAt}|${lines}|${plan.arriveAt}`;
}

/**
 * Rank raw plans into the options a screen should show.
 *
 * Order is DEPARTURE TIME, ascending — not "best first". This list answers
 * "what leaves next", and a list of times that is not in time order is a list
 * you have to read twice. Quality still shows: `late` and `slackMinutes` say
 * which ones actually work.
 *
 * `after` drops anything that has already gone (the whole premise is that she
 * is standing there having missed one). `appointment` is what makes an option
 * late. `currentDeparture` marks the one already on the task so the list never
 * offers her what she already has as if it were new.
 */
export function rankDepartureOptions(
  plans: (TransitPlan | null | undefined)[],
  opts: {
    after?: string;
    appointment?: string;
    currentDeparture?: string;
    max?: number;
  } = {},
): DepartureOption[] {
  const { after, appointment, currentDeparture, max = 3 } = opts;
  const seen = new Set<string>();
  const out: DepartureOption[] = [];

  for (const plan of plans) {
    if (!plan || !isHHMM(plan.leaveHomeAt)) continue;
    // A plan with no arrival is a plan you cannot judge; the point of the list
    // is showing BOTH ends of the trip.
    if (!isHHMM(plan.arriveAt)) continue;
    // Catchability, not tidiness.
    //
    // This used to drop anything whose leaveHomeAt was in the past, which is
    // the wrong clock on both ends. parseTransitRoute sets
    // leaveHomeAt = doorDeparture - 5 as a safety margin, so a departure
    // probed at 08:37 comes back reading 08:32 and was thrown away — the
    // genuinely next train was the one option she could never be offered.
    // Meanwhile a CACHED option whose train left at 08:25 kept its old
    // leaveHomeAt and sailed through.
    //
    // The real question is the one she asked: can she still walk to the
    // platform before the vehicle pulls out? boardAt - walkMinutes is the
    // last moment that is true. Modes with no vehicle (car, walk, bike) have
    // no timetable to miss, so they fall back to the door time.
    const walk = Number.isFinite(plan.walkToStopMinutes) ? Number(plan.walkToStopMinutes) : 0;
    const board = isHHMM(plan.firstBusDeparture) ? plan.firstBusDeparture : undefined;
    const mustMoveBy = board ? toMinutes(board) - walk : toMinutes(plan.leaveHomeAt);
    if (after && isHHMM(after) && mustMoveBy < toMinutes(after)) continue;
    const sig = optionSignature(plan);
    if (seen.has(sig)) continue;
    seen.add(sig);

    const rides = ridesOf(plan);
    const slackMinutes = appointment && isHHMM(appointment)
      ? toMinutes(appointment) - toMinutes(plan.arriveAt)
      : undefined;
    // "Leave now" beats a leave time that has already been and gone.
    const departAt = after && isHHMM(after) && toMinutes(plan.leaveHomeAt) < toMinutes(after)
      ? after
      : plan.leaveHomeAt;
    out.push({
      plan,
      departAt,
      walkMinutes: walk,
      boardAt: board,
      boardStop: plan.firstBusStop || undefined,
      arriveAt: plan.arriveAt,
      durationMinutes: plan.totalDurationMinutes,
      lines: rides.map((l) => l.lineNumber).filter(Boolean) as string[],
      rides: rides.length,
      slackMinutes,
      late: slackMinutes !== undefined && slackMinutes < 0,
      current: Boolean(currentDeparture && currentDeparture === plan.leaveHomeAt),
    });
  }

  // Sort on the PLAN's own departure, not the clamped display time: three
  // options that all clamp to "leave now" must still be listed in timetable
  // order, and boardAt is what separates them.
  const order = (o: DepartureOption) =>
    toMinutes(o.boardAt ?? o.plan.leaveHomeAt) * 100 + toMinutes(o.arriveAt) / 100;
  out.sort((a, b) => order(a) - order(b));
  return out.slice(0, max);
}

/** "direct" / "1 change" — the thing that decides between two similar times. */
export function changesLabel(option: DepartureOption, he: boolean): string {
  if (option.rides <= 1) return he ? 'ישיר' : 'direct';
  const n = option.rides - 1;
  if (he) return n === 1 ? 'החלפה אחת' : `${n} החלפות`;
  return n === 1 ? '1 change' : `${n} changes`;
}

/** "7 min early" / "4 min late" — stated, never left to be worked out. */
export function slackLabel(option: DepartureOption, he: boolean): string {
  const s = option.slackMinutes;
  if (s === undefined || s === 0) return '';
  return s > 0
    ? (he ? `${s} דק׳ לפני` : `${s} min early`)
    : (he ? `${-s} דק׳ אחרי` : `${-s} min late`);
}

/**
 * The vehicle badge: "🚆 המכבים" / "🚌 176 + 271".
 *
 * Kept short on purpose — this sits next to two clock times in a fixed-width
 * row, and a long line name must shrink the badge, never the times.
 */
export function vehicleLabel(option: DepartureOption, he: boolean): string {
  const icon = option.plan.legs?.find((l) => l.type !== 'walk')?.type;
  const emoji = icon === 'train' || icon === 'subway' ? '🚆'
    : icon === 'bus' ? '🚌'
      : icon === 'car' ? '🚗'
        : icon === 'bike' ? '🚴' : '🚶';
  const lines = option.lines.join(' + ');
  if (lines) return `${emoji} ${lines}`;
  return `${emoji} ${he ? 'נסיעה' : 'ride'}`;
}

/**
 * "🚶 12 דק׳ לתחנה · 🚆 08:52" — the two facts the list was missing.
 *
 * The row showed only door-to-door: "08:37 → 09:20". Missing the 08:25 and
 * being handed "08:37 →" with no idea which train that is, or whether twelve
 * minutes is enough to reach the platform, is the same anxiety the departure
 * alert exists to remove. Both numbers are already in the plan; they were
 * simply never rendered.
 *
 * Empty for car / walk / bike, which have no platform to miss.
 */
export function boardLabel(option: DepartureOption, he: boolean): string {
  if (!option.boardAt || !option.rides) return '';
  const walk = option.walkMinutes > 0
    ? (he ? `🚶 ${option.walkMinutes} דק׳ לתחנה` : `🚶 ${option.walkMinutes} min to the stop`)
    : '';
  const stop = option.boardStop ? ` ${option.boardStop}` : '';
  const board = he
    ? `יוצאת ${option.boardAt}${stop ? ` מ${option.boardStop}` : ''}`
    : `departs ${option.boardAt}${stop ? ` from ${option.boardStop}` : ''}`;
  return walk ? `${walk} · ${board}` : board;
}

/**
 * Has this option gone, counting the walk?
 *
 * The same test rankDepartureOptions applies when it builds the list, exposed
 * so a screen holding a list it fetched minutes ago can ask again without
 * re-probing Google. A departure is gone when the vehicle leaves before she
 * could physically reach the stop — boardAt minus the walk. Options with no
 * vehicle (car, walk, bike) never expire: there is no timetable to miss.
 */
export function departureUncatchable(option: DepartureOption, now: string): boolean {
  if (!isHHMM(now)) return false;
  if (!option.boardAt || !isHHMM(option.boardAt)) return false;
  return toMinutes(option.boardAt) - option.walkMinutes < toMinutes(now);
}

/**
 * Minutes left before this option becomes uncatchable — negative once it is.
 *
 * The deadline is not the train, it is the walk: a train at 08:52 twelve
 * minutes from the door has to be decided by 08:40. That is the number she is
 * actually racing, and it was nowhere on the screen.
 */
export function minutesToDecide(option: DepartureOption, now: string): number | undefined {
  if (!isHHMM(now) || !option.boardAt || !isHHMM(option.boardAt)) return undefined;
  return toMinutes(option.boardAt) - option.walkMinutes - toMinutes(now);
}

/** "צאי עכשיו" / "עוד 6 דק׳ לצאת" — the countdown, in words. */
export function urgencyLabel(option: DepartureOption, now: string, he: boolean): string {
  const left = minutesToDecide(option, now);
  if (left === undefined) return '';
  if (left <= 0) return he ? '🏃 צאי עכשיו' : '🏃 leave now';
  if (left === 1) return he ? '🏃 עוד דקה לצאת' : '🏃 leave in 1 min';
  if (left <= 5) return he ? `🏃 עוד ${left} דק׳ לצאת` : `🏃 leave in ${left} min`;
  return he ? `עוד ${left} דק׳ לצאת` : `leave in ${left} min`;
}
