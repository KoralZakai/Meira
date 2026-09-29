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
import { checkPlan, planProblemLine } from './planIntegrity';

export type Superlative = 'fastest' | 'earliest' | 'latest';

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
  /**
   * The direction the first vehicle is signed with — "לכיוון בנימינה".
   *
   * "for trains it's important מספר רציף. if we check many optionals of train
   * they are from other platform." Google returns no platform number for any
   * Israeli station, and inventing one would be the worst possible lie to tell
   * someone running for a train. The direction IS how the boards are
   * organised, and it is what tells two trains leaving the same station
   * minutes apart apart.
   */
  boardDirection?: string;
  /** A literal platform, if a provider ever gives one. Google does not. */
  boardPlatform?: string;
  /**
   * HH:MM the FIRST VEHICLE reaches its stop — the other half of the pair
   * printed on a railway timetable. On a direct journey this is the number she
   * can look up; on a connection it is where the first leg ends.
   */
  rideArriveAt?: string;
  /** HH:MM Google says she is there, door to door. */
  arriveAt: string;
  durationMinutes: number;
  /** Vehicles, in order — walking legs are not rides. */
  lines: string[];
  rides: number;
  /** Minutes of slack against the appointment: positive early, negative late. */
  slackMinutes?: number;
  /**
   * What this option is BEST at, among the ones she is actually shown.
   *
   * Koral, 2026-09-23, after checking rail.co.il herself and finding all three
   * of her trains missing from the card: "you need to score the options and
   * offer the best way: fastest route, Earliest arrival, latest departure".
   *
   * They are her three words and they pull against each other on purpose — the
   * fastest train is rarely the latest departure. Naming which axis each option
   * wins on is the honest way to present that: the ranker still picks one, and
   * the list says what she gives up by taking a different one. Empty for an
   * option that wins nothing, which is itself information.
   *
   * Computed over the SLICE she sees. Calling something "the fastest" when a
   * faster one was cut off the bottom of the list would be a lie by omission.
   */
  superlatives: Superlative[];
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
    // A journey that disagrees with itself is not an option.
    //
    // "you wrote: 13:51-14:13 ?!?! this it really bad!" — a TransitPlan carries
    // four separate accounts of one trip (leaveHomeAt, arriveAt,
    // totalDurationMinutes, and the legs), each read from a different field of
    // Google's response, and nothing had ever compared them. Whatever came
    // back was rendered. utils/planIntegrity compares them, and rule 2 says
    // the drop may be silent to the list but never to the log.
    const verdict = checkPlan(plan);
    if (!verdict.ok) {
      console.warn(planProblemLine(plan, verdict));
      continue;
    }
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
      rideArriveAt: rides[0]?.arrivalTime && isHHMM(rides[0].arrivalTime)
        ? rides[0].arrivalTime : undefined,
      boardDirection: rides[0]?.headsign || undefined,
      boardPlatform: rides[0]?.platform || undefined,
      arriveAt: plan.arriveAt,
      durationMinutes: plan.totalDurationMinutes,
      lines: rides.map((l) => l.lineNumber).filter(Boolean) as string[],
      rides: rides.length,
      slackMinutes,
      superlatives: [],
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
  return awardSuperlatives(out.slice(0, max));
}

/**
 * Mark which option wins on each of her three axes.
 *
 * Only among options that actually make the appointment: "the earliest
 * arrival" is meaningless praise if the option also gets her there after the
 * interview started, and a late option carrying a gold star is how a list
 * stops being trusted. When nothing arrives in time every option is judged,
 * because then the axes are all she has left to choose on.
 *
 * Ties are shared rather than broken arbitrarily — two trains arriving at the
 * same minute are both the earliest, and picking one to crown would be
 * inventing a difference.
 */
export function awardSuperlatives(options: DepartureOption[]): DepartureOption[] {
  const inTime = options.filter((o) => !o.late);
  const pool = inTime.length ? inTime : options;
  if (!pool.length) return options;
  const best = {
    fastest: Math.min(...pool.map((o) => o.durationMinutes)),
    earliest: Math.min(...pool.map((o) => toMinutes(o.arriveAt))),
    latest: Math.max(...pool.map((o) => toMinutes(o.boardAt ?? o.departAt))),
  };
  for (const o of options) {
    const won: Superlative[] = [];
    if (pool.includes(o)) {
      if (o.durationMinutes === best.fastest) won.push('fastest');
      if (toMinutes(o.arriveAt) === best.earliest) won.push('earliest');
      if (toMinutes(o.boardAt ?? o.departAt) === best.latest) won.push('latest');
    }
    o.superlatives = won;
  }
  return options;
}

/** "הכי מהירה · יציאה הכי מאוחרת" — her own three words, on the row. */
const SUPERLATIVE_TEXT: Record<Superlative, { he: string; en: string }> = {
  fastest: { he: 'הכי מהירה', en: 'fastest' },
  earliest: { he: 'מגיעה הכי מוקדם', en: 'earliest arrival' },
  latest: { he: 'יוצאת הכי מאוחר', en: 'latest departure' },
};

export function superlativeLabel(option: DepartureOption, he: boolean): string {
  return option.superlatives.map((k) => SUPERLATIVE_TEXT[k][he ? 'he' : 'en']).join(' · ');
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
  // No line number is normal for rail here — Israel Railways gives none, and
  // its `line.name` is the route's two termini, which is not what she is
  // boarding (see transitParse.lineLabel). Name the VEHICLE rather than fall
  // back to "a ride": the direction is on the line below.
  const noun = icon === 'train' || icon === 'subway'
    ? (he ? 'רכבת' : 'train')
    : icon === 'bus' ? (he ? 'אוטובוס' : 'bus') : (he ? 'נסיעה' : 'ride');
  return `${emoji} ${noun}`;
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
  // THE VEHICLE'S OWN PAIR OF TIMES, not the door-to-door pair above it.
  //
  // Koral checked rail.co.il and read back "13:15-14:01, 13:20-13:58,
  // 13:30-14:16", then could not find any of them on the card — because the
  // card's headline times are door to door and include the walk at each end,
  // so her 13:15→14:01 train appears there as 13:03→14:02. All three WERE
  // being offered. She had no way to tell, because the one pair of numbers she
  // could verify against was the one pair we never printed.
  const ridePair = option.rideArriveAt
    ? `${option.boardAt}–${option.rideArriveAt}`
    : `${option.boardAt}`;
  const board = he
    ? `${ridePair}${stop ? ` מ${option.boardStop}` : ''}`
    : `${ridePair}${stop ? ` from ${option.boardStop}` : ''}`;
  const where = platformLabel(option, he);
  const line = walk ? `${walk} · ${board}` : board;
  return where ? `${line} · ${where}` : line;
}

/**
 * Which platform — or the only honest substitute for it.
 *
 * A real platform number when a provider gives one (none does here yet), and
 * otherwise the direction, which is what the departure boards are signed with
 * and the thing that separates two trains out of the same station. Empty when
 * we have neither: a blank is a fact, and a guessed platform number is how
 * someone ends up on the wrong train.
 */
export function platformLabel(option: DepartureOption, he: boolean): string {
  if (option.boardPlatform) {
    return he ? `רציף ${option.boardPlatform}` : `platform ${option.boardPlatform}`;
  }
  if (option.boardDirection) {
    return he ? `לכיוון ${option.boardDirection}` : `towards ${option.boardDirection}`;
  }
  return '';
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
