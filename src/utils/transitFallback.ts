/**
 * transitFallback — "by train, and if there is no train there, by bus."
 *
 * Koral's rule, verbatim: "נסיעה ברכבת!! מתי לקחת רכבת כדי להגיע בזמן ואם אין
 * לשם רכבת אז אוטובוס."
 *
 * THE BUG THIS CLOSES
 *
 * `getPlanForMode('train', …)` is deliberately absolute: it keeps only routes
 * made entirely of rail and returns `null` when there are none, with the
 * comment "an explicit 'no train', never a bus in disguise". That is the right
 * call — being handed a bus when you asked for a train is a different journey,
 * not a smaller answer.
 *
 * But `ensureTravelChain` asked for ONE mode and used what came back. So with
 * `transportType: 'train'` and a destination no train reaches — Ra'anana, for
 * one — the answer was `null`, and `null` meant no route, no leave-home time,
 * no wake alarm and nothing on the timeline. Silently. A preference for trains
 * turned into having no plan at all.
 *
 * A preference is not a constraint. The ladder below says which vehicles to
 * try and in what order; the caller walks it and takes the first real plan.
 * What it must never do is quietly claim the fallback was what she asked for,
 * so every result carries which mode actually answered and whether that was
 * the preferred one.
 *
 * Pure. No network, no Expo runtime — the arithmetic of "which do we ask
 * next" is testable on its own, which is why it does not live in GoogleSync.
 *
 * Consumers: services/GoogleSync.ensureTravelChain.
 */
import { TransportType, TransitPlan, AppLanguage } from '../types/index';

/** Vehicles that are "public transport" and can stand in for one another. */
const PUBLIC: TransportType[] = ['train', 'bus'];

/**
 * The order to ask Google, given what she prefers.
 *
 * Public transport is a LADDER, not a single choice: rail first because she
 * asked for rail, bus underneath it because a journey by bus beats no journey.
 * Private modes are not a ladder — someone who drives does not want a bus
 * timetable as a consolation prize, and someone who walks has no fallback that
 * is still walking.
 */
export function modeLadder(preferred: TransportType): TransportType[] {
  if (!PUBLIC.includes(preferred)) return [preferred];
  // Even a stored preference of 'bus' tries rail first: her instruction was
  // about the journey, not about a setting she may never have opened.
  return ['train', 'bus'];
}

export interface ChosenPlan {
  plan: TransitPlan;
  /** The vehicle that actually answered. */
  mode: TransportType;
  /** True when that was the first choice on the ladder. */
  preferred: boolean;
  /** What was tried and came back empty, in order. */
  rejected: TransportType[];
}

/**
 * Walk the ladder and keep the first real plan.
 *
 * `ask` is the network call, injected so this stays pure and so the caller
 * keeps its own caching, key handling and error swallowing. A mode that
 * throws counts as "no route by that vehicle" — one dead request must not
 * cost her the fallback.
 */
export async function planWithFallback(
  preferred: TransportType,
  ask: (mode: TransportType) => Promise<TransitPlan | null>,
): Promise<ChosenPlan | null> {
  const ladder = modeLadder(preferred);
  const rejected: TransportType[] = [];
  for (const mode of ladder) {
    let plan: TransitPlan | null = null;
    try {
      plan = await ask(mode);
    } catch (e) {
      // Rule 2: the throw may be swallowed, the reason may not.
      console.warn('[transitFallback] route request failed', mode, e);
      plan = null;
    }
    if (plan) {
      return { plan, mode, preferred: mode === ladder[0], rejected };
    }
    rejected.push(mode);
  }
  return null;
}

/**
 * What to tell her, when the vehicle she got is not the one she asked for.
 *
 * Returns undefined when nothing needs saying. This is the half that keeps
 * the fallback honest: a bus that arrives while the UI still shows 🚆 is the
 * exact complaint already on the known-open list.
 */
export function fallbackNote(
  chosen: ChosenPlan,
  destination: string,
  lang: AppLanguage,
): string | undefined {
  if (chosen.preferred) return undefined;
  if (!chosen.rejected.includes('train')) return undefined;
  const place = destination.split(',')[0].trim();
  return lang === 'he'
    ? `אין רכבת ל${place} — ${vehicleHe(chosen.mode)}`
    : `No train to ${place} — ${vehicleEn(chosen.mode)} instead`;
}

const vehicleHe = (m: TransportType): string =>
  ({ bus: 'אוטובוס', train: 'רכבת', car: 'רכב', walk: 'ברגל', bike: 'אופניים' }[m] ?? m);
const vehicleEn = (m: TransportType): string =>
  ({ bus: 'bus', train: 'train', car: 'car', walk: 'walking', bike: 'bike' }[m] ?? m);

/**
 * Does this plan get her there in time?
 *
 * A route that exists is not automatically a route that works. The ladder must
 * not prefer a train that arrives at 14:45 over a bus that arrives at 14:10
 * for a 14:30 interview — "by train" was never a request to be late.
 */
export function arrivesInTime(plan: TransitPlan, arriveBy: string): boolean {
  if (!plan.arriveAt) return true;   // unknown arrival is not a known failure
  return plan.arriveAt <= arriveBy;
}

const toMin = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes between getting there and being due. Undefined when unknowable. */
export function slackMinutes(plan: TransitPlan, arriveBy: string): number | undefined {
  if (!/^\d{1,2}:\d{2}$/.test(plan.arriveAt ?? '')) return undefined;
  if (!/^\d{1,2}:\d{2}$/.test(arriveBy ?? '')) return undefined;
  return toMin(arriveBy) - toMin(plan.arriveAt);
}

/**
 * How much room to aim for before a `must`.
 *
 * Thirteen minutes is technically on time and is not how anyone wants to walk
 * into a job interview. It was 30, and on 13.10 it picked her a train landing
 * an hour early — "you chose a train that arrives too early for me". She chose
 * "the latest one still on time, with 10–15 minutes to walk", and Google's
 * arrival is already at the door, so 20 is the target: for 13:00 the 12:37
 * (23 early) beats the 12:07 (53), and for 14:30 the 13:58 (32) still beats
 * the 14:16 (14), which she asked for on 22.9.
 */
export const MUST_ARRIVAL_BUFFER_MIN = 20;

/**
 * Kinds of appointment where arriving on the dot is arriving badly. Someone
 * else is holding the slot, and the cost of being fourteen minutes out is not
 * fourteen minutes.
 */
const HIGH_STAKES = ['interview', 'doctor', 'conference'];

/**
 * The cushion this task deserves, in minutes. 0 means "the old rule" — take
 * the latest departure that works and sleep in.
 *
 * Priority first, because she is the one who decides what is a must, and an
 * exam, a flight and a first date are all the same question as an interview.
 *
 * But not priority ALONE. Her Ceva interview is stored `have_to`, not `must` —
 * the categoriser labels an interview `must`, and by the time it had been
 * through the calendar import and the reconcile it was `have_to`. So the very
 * appointment she asked for this rule for would not have got it. The kind of
 * thing it is has to count too.
 */
export function arrivalBufferFor(
  task: { priority?: string; category?: string } | null | undefined,
): number {
  if (!task) return 0;
  if (task.priority === 'must') return MUST_ARRIVAL_BUFFER_MIN;
  return HIGH_STAKES.includes(task.category ?? '') ? MUST_ARRIVAL_BUFFER_MIN : 0;
}

/**
 * How far this plan lands from the cushion we are aiming for. LOWER IS BETTER,
 * and 0 means "arrives exactly `buffer` minutes early".
 *
 * TWO WRONG VERSIONS CAME BEFORE THIS ONE, in opposite directions.
 *
 * A boolean "does it clear the bar" was first, and it threw the answer away:
 * two real trains with 25 and 7 minutes to spare both failed a 30-minute bar,
 * so they tied, and "latest departure" handed it to the 7.
 *
 * Capping — `Math.min(slack, buffer)` — was second, and on the morning of the
 * interview it did this, from the device log:
 *
 *   12:33 → 13:32   58 min spare   ← CHOSEN
 *   13:09 → 13:59   31 min spare
 *   13:03 → 14:02   28 min spare   (a direct train)
 *
 * Everything at or above 30 tied at 30, so the tie-breaks ran, and a direct
 * train beat a two-train connection — leaving her standing in Ra'anana for
 * nearly an hour. Meanwhile the direct 14:02 train, two minutes under the bar,
 * could not compete at all. Koral had named both of the ones it skipped: "it's
 * better to arrive on 14:00 or better the train which leave by 13:20".
 *
 * So the target is a TARGET, not a floor. Distance from it is the score, and
 * the two directions are not symmetric: a minute of missing cushion is worth
 * three of extra waiting, because arriving late has no upper bound on what it
 * costs and arriving early is only boring.
 *
 * `buffer` 0 disables the whole thing — every plan scores 0 and the existing
 * tie-breaks decide, exactly as they did before any of this.
 */
export const SHORTFALL_WEIGHT = 3;

export function missesTargetBy(
  plan: TransitPlan,
  arriveBy: string,
  buffer: number,
): number {
  if (buffer <= 0) return 0;
  const slack = slackMinutes(plan, arriveBy);
  // Unknowable is not a demerit — an unparseable time is our problem, not a
  // reason to send her on a different train.
  if (slack === undefined) return 0;
  return slack < buffer
    ? (buffer - slack) * SHORTFALL_WEIGHT
    : slack - buffer;
}

// ---------------------------------------------------------------------------
// Which journey is the better journey
// ---------------------------------------------------------------------------

/** Leg types that count as rail. `tram` is not in TransitLeg's union but
 *  Google returns it, so it is matched defensively rather than assumed away. */
const RAIL = ['train', 'subway', 'tram'];

/**
 * Koral's ordering, in her words: "if there is a direct train to this location
 * — train is better; else if there is a direct bus so better; then offer mix
 * ways".
 *
 * DIRECTNESS is the axis, not the vehicle. One train beats one bus, and one of
 * anything beats a connection, because a transfer is not merely minutes — it
 * is a second chance to miss something, on the morning of an interview.
 */
export type JourneyTier = 'direct_rail' | 'direct_bus' | 'mixed';

const TIER_ORDER: Record<JourneyTier, number> = {
  direct_rail: 0, direct_bus: 1, mixed: 2,
};

/** Vehicles this plan puts her on. Walking to the platform is not a ride. */
export function rideCount(plan: TransitPlan): number {
  return (plan.legs ?? []).filter((l) => l.type !== 'walk').length;
}

/**
 * Which tier a plan belongs to.
 *
 * A plan with no vehicle legs at all — Google sometimes answers a short hop
 * with pure walking — is `mixed`, which is the honest place for "not one of
 * the two things she named".
 */
export function tierOf(plan: TransitPlan): JourneyTier {
  const rides = (plan.legs ?? []).filter((l) => l.type !== 'walk');
  if (rides.length !== 1) return 'mixed';
  if (RAIL.includes(rides[0].type)) return 'direct_rail';
  if (rides[0].type === 'bus') return 'direct_bus';
  return 'mixed';
}

/**
 * Is the train what carries this journey? True when the longest ride is rail —
 * "bus to the station, train to Haifa, a short bus at the end" is a train
 * journey; "three buses" is not.
 *
 * 13.10, Koral, on a Haifa interview planned as buses 24 → 669 → 998 → 768:
 * "no train?! better a train, arriving with enough time ahead to walk to the
 * place". Every connection counted as 'mixed', so a train with a feeder bus
 * and three buses tied on tier, and whichever landed nearer the 30-minute
 * target won — the buses, by a few minutes.
 */
export function railCarries(plan: TransitPlan): boolean {
  const rides = (plan.legs ?? []).filter((l) => l.type !== 'walk');
  if (!rides.length) return false;
  const longest = rides.reduce((a, b) => ((b.durationMinutes ?? 0) > (a.durationMinutes ?? 0) ? b : a));
  return RAIL.includes(longest.type);
}

/**
 * How much "further from the target" a train journey may land and still beat
 * a bus one: arriving half an hour earlier by train is better than exactly on
 * target by bus. In the same units as missesTargetBy (a minute early = 1, a
 * minute short of the cushion = SHORTFALL_WEIGHT).
 */
export const RAIL_PREFERENCE = 30;

/**
 * The vehicle to show for a plan.
 *
 * A mixed journey has no single answer, so it reports the FIRST vehicle she
 * actually boards — that is the one she has to catch, and the one the chip
 * has to be right about when she is standing on a platform.
 */
export function vehicleOf(plan: TransitPlan): TransportType {
  const rides = (plan.legs ?? []).filter((l) => l.type !== 'walk');
  if (!rides.length) return 'walk';
  return RAIL.includes(rides[0].type) ? 'train' : 'bus';
}

/**
 * Rank candidate journeys, best first.
 *
 * WHY THIS EXISTS: there were already two sorts, and the second quietly undid
 * the first. `parseTransitAlternatives` ranks on-time → fewest rides → shortest
 * → latest departure, which is right. Then `getPlanForMode` ran
 * `pickLatestArrivingInTime` over the survivors, which ranks latest departure
 * FIRST and fewest rides second. So directness was demoted, and a two-train
 * connection leaving at 13:55 beat a direct train leaving at 13:40.
 *
 * One sort, stated once:
 *
 *   1. arrives in time       — a plan that makes her late is not a better plan
 *   2. lands near the target — `missesTargetBy`, 0 when minBufferMinutes is 0,
 *                              less RAIL_PREFERENCE when a train carries it
 *   3. tier                  — direct rail, then direct bus, then mixed
 *   4. fewest rides          — separates a 2-leg mix from a 3-leg one
 *   5. latest departure      — every minute earlier is a minute spent waiting
 *   6. shortest              — tie-break
 *
 * STEP 2 IS THE ONE SHE ASKED FOR. Rule 5 ("latest departure") is right for a
 * gym class and wrong for an interview, and on 2026-09-22 it chose her the
 * 13:30 train arriving 14:16 for a 14:30 interview — thirteen minutes — over
 * the 13:20 arriving 13:58. Her words: "i think it's better to arrive on 14:00
 * or better the train which leave by 13:20 and arrives at 13:58".
 *
 * It is a TARGET and not a floor, which is a correction to the first attempt
 * at step 2 — see `missesTargetBy` for the morning it sent her out an hour
 * early. "In time" and "in time with your coat off" are different answers, so
 * they are different steps. minBufferMinutes defaults to 0, which leaves every
 * existing caller's ordering exactly as it was.
 */
export function rankPlans(
  plans: TransitPlan[],
  arriveBy: string,
  opts: { minBufferMinutes?: number } = {},
): TransitPlan[] {
  const buffer = opts.minBufferMinutes ?? 0;
  // A train journey is preferred (railCarries) — in time comes first, always.
  const miss = (p: TransitPlan): number => missesTargetBy(p, arriveBy, buffer)
    - (railCarries(p) ? RAIL_PREFERENCE : 0);
  return [...plans].sort((a, b) => {
    const aOk = arrivesInTime(a, arriveBy);
    const bOk = arrivesInTime(b, arriveBy);
    if (aOk !== bOk) return aOk ? -1 : 1;
    const room = miss(a) - miss(b);
    if (room !== 0) return room;
    const t = TIER_ORDER[tierOf(a)] - TIER_ORDER[tierOf(b)];
    if (t !== 0) return t;
    const r = rideCount(a) - rideCount(b);
    if (r !== 0) return r;
    if (a.leaveHomeAt !== b.leaveHomeAt) return b.leaveHomeAt.localeCompare(a.leaveHomeAt);
    return a.totalDurationMinutes - b.totalDurationMinutes;
  });
}

export interface RankedChoice {
  plan: TransitPlan;
  tier: JourneyTier;
  /** True when this plan actually gets her there by `arriveBy`. */
  inTime: boolean;
  /** The tiers that were available to choose from, best first. */
  offered: JourneyTier[];
  /** Minutes to spare against the appointment. Undefined when unknowable. */
  slackMinutes?: number;
  /** This plan beat a later departure because it leaves more room. */
  chosenForMargin?: boolean;
}

/**
 * The best journey out of everything Google returned, by the ordering above.
 *
 * Takes plans from every vehicle query at once rather than walking a ladder of
 * separate calls: "is there a direct train" and "is there a direct bus" are
 * one comparison, not two independent questions whose answers never meet.
 * Duplicates (the same departure returned by both the rail and the bus query)
 * are collapsed.
 */
export function pickByPreference(
  plans: TransitPlan[],
  arriveBy: string,
  opts: { minBufferMinutes?: number } = {},
): RankedChoice | null {
  const seen = new Set<string>();
  const unique = plans.filter((p) => {
    if (!p) return false;
    const key = `${p.leaveHomeAt}|${p.arriveAt}|${(p.legs ?? [])
      .filter((l) => l.type !== 'walk')
      .map((l) => `${l.type}:${l.lineNumber ?? ''}`)
      .join('>')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return null;
  const ranked = rankPlans(unique, arriveBy, opts);
  const best = ranked[0];
  return {
    plan: best,
    tier: tierOf(best),
    inTime: arrivesInTime(best, arriveBy),
    offered: [...new Set(ranked.map(tierOf))],
    slackMinutes: slackMinutes(best, arriveBy),
    /**
     * True when this plan was chosen for its margin over one that left later.
     * Rule 9: an earlier alarm with no stated reason reads as the app being
     * wrong, so the caller has something to say out loud.
     */
    chosenForMargin: Boolean(
      (opts.minBufferMinutes ?? 0) > 0
      && ranked.some((p) => p !== best
        && arrivesInTime(p, arriveBy)
        && p.leaveHomeAt > best.leaveHomeAt),
    ),
  };
}

/**
 * What to say when she did not get the direct train.
 *
 * Silence here is the known-open bug in reverse: a connection presented as
 * though it were the simple journey she asked for. Returns undefined when she
 * got the best tier there is.
 */
/**
 * Why she is leaving earlier than she strictly has to.
 *
 * Rule 9's other half: whatever answered is recorded, and when it is not the
 * obvious choice the plan carries the sentence that says so. An alarm two
 * hours earlier with no reason attached reads as the app being wrong, and the
 * next thing she does is stop trusting the alarm.
 */
export function marginNote(
  choice: RankedChoice,
  lang: AppLanguage,
): string | undefined {
  if (!choice.chosenForMargin) return undefined;
  const slack = choice.slackMinutes;
  if (slack === undefined || slack <= 0) return undefined;
  return lang === 'he'
    ? `יוצאת מוקדם בכוונה — ${slack} דק׳ מרווח`
    : `Leaving early on purpose — ${slack} min in hand`;
}

export function tierNote(
  choice: RankedChoice,
  destination: string,
  lang: AppLanguage,
): string | undefined {
  if (choice.tier === 'direct_rail') return undefined;
  const place = destination.split(',')[0].trim();
  const he = lang === 'he';
  const railWasOffered = choice.offered.includes('direct_rail');
  if (choice.tier === 'direct_bus') {
    // No direct train existed at all, or the ones that did arrive too late.
    return he
      ? `אין רכבת ישירה ל${place} — אוטובוס ישיר`
      : `No direct train to ${place} — direct bus`;
  }
  // Mixed. Say what it is made of, because "2 changes" is the thing she would
  // have wanted to know before agreeing to the plan.
  const changes = Math.max(0, rideCount(choice.plan) - 1);
  const changesLabel = he
    ? `${changes} ${changes === 1 ? 'החלפה' : 'החלפות'}`
    : `${changes} ${changes === 1 ? 'change' : 'changes'}`;
  if (railWasOffered) {
    return he
      ? `אין ישיר ל${place} בזמן — משולב, ${changesLabel}`
      : `Nothing direct to ${place} in time — mixed, ${changesLabel}`;
  }
  return he
    ? `אין רכבת ולא אוטובוס ישיר ל${place} — משולב, ${changesLabel}`
    : `No direct train or bus to ${place} — mixed, ${changesLabel}`;
}

/**
 * The ladder, but a preferred plan that misses the deadline yields to a
 * fallback that does not.
 *
 * Kept separate from `planWithFallback` because the two questions are
 * different: "is there a train" and "does that train get me there". Callers
 * that only have one plan still get the first.
 */
export async function bestPlanInTime(
  preferred: TransportType,
  arriveBy: string,
  ask: (mode: TransportType) => Promise<TransitPlan | null>,
): Promise<ChosenPlan | null> {
  const ladder = modeLadder(preferred);
  const rejected: TransportType[] = [];
  let late: ChosenPlan | null = null;
  for (const mode of ladder) {
    let plan: TransitPlan | null = null;
    try {
      plan = await ask(mode);
    } catch (e) {
      console.warn('[transitFallback] route request failed', mode, e);
    }
    if (!plan) { rejected.push(mode); continue; }
    const candidate: ChosenPlan = {
      plan, mode, preferred: mode === ladder[0], rejected: [...rejected],
    };
    if (arrivesInTime(plan, arriveBy)) return candidate;
    // Remember the late one: if nothing else answers, a late plan still tells
    // her when to leave, which beats an empty card that says nothing at all.
    if (!late) late = candidate;
    rejected.push(mode);
  }
  return late;
}
