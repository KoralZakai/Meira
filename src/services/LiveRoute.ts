/**
 * LiveRoute — re-plan the next trip from where the user ACTUALLY is.
 *
 * Every route in the app is planned from `profile.homeAddress` or the previous
 * planned stop. The user's real position is never an input, so a leave time
 * computed at home is still shown unchanged when she is across town — wrong by
 * exactly the distance she has moved. positionDrift.ts decides WHEN the plan is
 * stale enough to matter; this is the consumer it was written for and, until
 * now, never had.
 *
 * The split is deliberate and is the shape of the whole product's direction:
 * the phone is the SENSOR (only it can read GPS), the decision is PURE
 * (assessDrift, testable with no device), and the route comes from the same
 * Google planner every other path uses. Nothing here talks to the LLM.
 *
 * Called from HomeScreen's existing 2-minute foreground loop — no background
 * task, no extra battery. It only ever acts on the ONE next trip, and only
 * when the user has moved past the drift threshold, so a stationary phone does
 * nothing and costs nothing.
 */
import { AppLanguage, Task, TaskLocation, TransitPlan, TransportType, UserProfile } from '../types/index';
import { assessDrift, describeReplan } from '../utils/positionDrift';
import { pickCoords } from '../utils/placeCoords';
import { nextTrip, assumedOrigin, missedPlannedDeparture, nowHHMM } from '../utils/liveRoutePlan';
import { presenceFor, isUserAtLocation } from '../utils/presence';
import {
  decideLiveReplan, describeReplanReason, ReplanReason,
} from '../utils/liveReplanDecision';
import { profileFromPoint } from './RoutePlanner';
import { rankDepartureOptions, DepartureOption } from '../utils/departureOptions';
import { addMinutes, timeToMinutes } from '../utils/timeUtils';
import { normalizeProfile } from '../utils/profileShape';
import { locOf, addrOf, timeOf } from '../utils/dayPlanning';
import { GoogleService } from './GoogleService';
import { getCurrentLocation } from './LocationService';
import { updateTaskFields } from './TaskStorage';
import {
  cancelTaskNotifications, cancelLeaveNags, scheduleTransitNotifications, sendImmediate,
  withTaskAlertLock,
} from './NotificationService';

/**
 * When each trip was last re-planned, so the live loop cannot spend a routing
 * call every tick. Module-level on purpose: the screen that drives the loop
 * re-renders constantly, and a cooldown living in component state would reset
 * itself exactly when she is late and the loop is busiest.
 */
/** Trips already told "times updated" this session (see replanFromNextDeparture). */
const notifiedLate = new Set<string>();
const lastLiveReplanAt = new Map<string, number>();

export interface LiveReplanResult {
  replanned: boolean;
  reason: string;
  message?: string;
  metres?: number;
  /** The re-planned route, when one was found. */
  plan?: TransitPlan;
  /** The task with its new location — so a screen can render the new times at once. */
  task?: Task;
}

/** Every route this module saves, said once at warn (see RouteGateway's twin). */
function logSaved(where: string, trip: Task, plan: TransitPlan | undefined): void {
  console.warn(`[LiveRoute] ${where} saved ${plan?.leaveHomeAt ?? '-'}→${plan?.arriveAt ?? '-'}`
    + ` for "${trip.text.slice(0, 30)}" at ${trip.fixedTime || trip.scheduledTime || '-'} on ${trip.date}`);
}

/**
 * "I haven't left" → the NEXT departure, and what it does to the arrival.
 *
 * The one implementation of that question. It was written for the background
 * missed-departure check, but the same recompute is what the "🚏 עוד לא יצאתי"
 * button and the transport chips need — three copies of a Google call that
 * rewrites the same three fields is how they drift apart. Callers differ only
 * in what they do with the result: the loop notifies, the screens render it.
 *
 * The stored plan is anchored to an arrival deadline; once its leave time has
 * passed, that plan is fiction. This asks the opposite question — depart NOW —
 * so transit returns the next bus with Google's own arrival time, then rewrites
 * leaveHomeBy / travelMinutes / transitPlan and re-arms the alerts for the new
 * departure (otherwise "time to leave" still fires for the bus that has gone).
 */
export async function replanFromNextDeparture(
  trip: Task,
  storedProfile: any,
  opts: {
    /** Override the task's transport (a transport chip picks a different one). */
    mode?: TransportType;
    /** Send a notification when the leave time actually changed. */
    notify?: boolean;
    now?: Date;
    language?: AppLanguage;
  } = {},
): Promise<LiveReplanResult> {
  const profile = normalizeProfile(storedProfile) as UserProfile | null;
  if (!profile) return { replanned: false, reason: 'no-profile' };
  const dest = addrOf(trip);
  if (!dest) return { replanned: false, reason: 'no-destination' };

  const mode = opts.mode ?? locOf(trip)?.transportType ?? profile.transportType;
  const he = (opts.language ?? (profile as any).language) === 'he';
  const plan = await GoogleService.getDepartNowPlan(mode, dest, profile, trip.date, opts.now);
  if (!plan) return { replanned: false, reason: 'route-failed' };

  const oldLeave = locOf(trip)?.leaveHomeBy;
  const nextBase = locOf(trip) ?? { address: dest, lat: 0, lng: 0, confirmed: false };
  const nextLocation: TaskLocation = {
    ...nextBase,
    transportType: mode,
    transitPlan: plan,
    leaveHomeBy: plan.leaveHomeAt,
    travelMinutes: plan.totalDurationMinutes,
    // Google routed us to the door; its end point is where this place is.
    ...(pickCoords(nextBase, plan) ?? {}),
  } as TaskLocation;
  const updated = { ...trip, location: nextLocation } as Task;
  logSaved('next-departure', trip, plan);

  // The old alerts belong to a departure that has gone. Replace them under the
  // per-task lock, the same way the travel chain does, so a re-plan never
  // stacks a second "time to leave" on top of the stale one.
  await withTaskAlertLock(trip.id, async () => {
    await cancelTaskNotifications(trip).catch(() => {});
    const notifTask = { ...updated, notificationIds: [] } as Task;
    await scheduleTransitNotifications(notifTask, he ? 'he' : 'en', profile.defaultWakeTime)
      .catch(() => {});
    updated.notificationIds = notifTask.notificationIds;
    await updateTaskFields(trip.id, {
      location: nextLocation, notificationIds: notifTask.notificationIds,
    } as any);
  }).catch(async () => {
    // The route is the point; if alert bookkeeping fails the new times must
    // still be saved.
    await updateTaskFields(trip.id, { location: nextLocation } as any).catch(() => {});
  });

  const message = describeNextDeparture(plan, trip.fixedTime, he);

  // Still home and late, the loop re-plans every few minutes and "leave now"
  // is a new minute each time. Tell her once, and again only when the ARRIVAL
  // really moves (10+ min) — not a buzz every five minutes for the same news.
  const oldArrive = locOf(trip)?.transitPlan?.arriveAt;
  const arrivalShift = oldArrive && /^\d{1,2}:\d{2}$/.test(oldArrive)
    ? Math.abs(timeToMinutes(plan.arriveAt) - timeToMinutes(oldArrive)) : Infinity;
  const worthSaying = !notifiedLate.has(trip.id) || arrivalShift >= 10;
  if (opts.notify && oldLeave !== plan.leaveHomeAt && worthSaying) {
    notifiedLate.add(trip.id);
    await sendImmediate(
      he ? '🚏 הזמנים השתנו' : '🚏 Times updated', message,
      { taskId: trip.id, type: 'missed-departure' },
    ).catch(() => {});
  }
  return { replanned: true, reason: 'missed-departure', message, plan, task: updated };
}

/**
 * "So what ARE my choices?" — the next three departures, from where she is.
 *
 * replanFromNextDeparture answers with one plan and rewrites the task. That is
 * right when the app decides for her (the background missed-departure check),
 * and wrong when she is looking at the screen: at 09:00, having missed the
 * 08:30, being told "the 09:15" hides that the 09:45 also arrives in time.
 * This computes the options and changes NOTHING — applyDepartureOption is the
 * commit, and it only runs when she picks one.
 *
 * Origin is where she actually is, not where the plan assumed. If the GPS fix
 * puts her at the previous appointment's venue (the return leg of a round
 * trip: home → Nahariya → Tel Aviv), the options are timed from Nahariya. That
 * is the difference between a usable list and three departures from a house
 * she left four hours ago.
 */
export async function nextDepartureOptions(
  trip: Task,
  storedProfile: any,
  opts: {
    mode?: TransportType;
    now?: Date;
    count?: number;
    /** Skip the GPS read (a caller that already has a fix, or a test). */
    current?: { lat: number; lng: number } | null;
  } = {},
): Promise<{ options: DepartureOption[]; origin: 'home' | 'here'; reason?: string }> {
  const profile = normalizeProfile(storedProfile) as UserProfile | null;
  if (!profile) return { options: [], origin: 'home', reason: 'no-profile' };
  const dest = addrOf(trip);
  if (!dest) return { options: [], origin: 'home', reason: 'no-destination' };

  const now = opts.now ?? new Date();
  const mode = opts.mode ?? locOf(trip)?.transportType ?? profile.transportType;

  // Where is she really? A fix that is far from home is the whole reason this
  // exists; a denied permission simply falls back to the planned origin.
  const current = opts.current !== undefined ? opts.current : await getCurrentLocation().catch(() => null);
  const atHome = !current
    || isUserAtLocation(current, { lat: profile.homeLat, lng: profile.homeLng });
  const fromProfile = (current && !atHome)
    ? ({
      ...storedProfile,
      homeAddress: '',                // force the coordinate origin
      homeLat: current.lat,
      homeLng: current.lng,
      homeLatLng: { lat: current.lat, lng: current.lng },
    } as unknown as UserProfile)
    : profile;

  const plans = await GoogleService.getDepartNowOptions(
    mode, dest, fromProfile, trip.date, now, opts.count ?? 3,
  ).catch(() => [] as TransitPlan[]);

  const options = rankDepartureOptions(plans, {
    after: nowHHMM(now),
    appointment: trip.fixedTime || trip.scheduledTime,
    currentDeparture: locOf(trip)?.leaveHomeBy,
    max: opts.count ?? 3,
  });
  return {
    options,
    origin: current && !atHome ? 'here' : 'home',
    reason: options.length ? undefined : 'no-options',
  };
}

/**
 * Re-plan one trip from a DIFFERENT starting point.
 *
 * Every route in the app is planned from an origin the app chose: home for the
 * first trip of the day, the previous stop for the rest. That guess is right
 * most mornings and wrong the moment the day stops going to plan — she is at a
 * friend's, she came straight from somewhere else, the first thing was
 * cancelled. Until now there was no way to say so; the leave time on screen
 * was measured from a house she was not in, and nothing on the card even
 * admitted which house it meant.
 *
 * `origin` is what she chose:
 *   'auto'    — back to the chain's own answer (home, or the previous stop).
 *   'current' — a live GPS fix, so the route starts where she is standing.
 *   an address — anywhere she names.
 *
 * Returns the updated task and the origin actually used, so the card can SAY
 * where it measured from instead of leaving her to assume.
 */
export async function replanFromOrigin(
  trip: Task,
  storedProfile: any,
  origin: 'auto' | 'current' | { address: string; lat?: number; lng?: number },
  opts: { language?: AppLanguage; mode?: TransportType } = {},
): Promise<{ task?: Task; originLabel: string; reason?: string }> {
  const profile = normalizeProfile(storedProfile) as UserProfile | null;
  if (!profile) return { originLabel: '', reason: 'no-profile' };
  const dest = addrOf(trip);
  const arrival = timeOf(trip);
  if (!dest || !arrival) return { originLabel: '', reason: 'no-destination' };

  const he = (opts.language ?? (profile as any).language) === 'he';
  const mode = opts.mode ?? locOf(trip)?.transportType ?? profile.transportType;

  let fromProfile: UserProfile;
  let originLabel: string;
  let originAddress: string;

  if (origin === 'current') {
    const current = await getCurrentLocation().catch(() => null);
    if (!current) {
      return { originLabel: '', reason: 'no-fix' };
    }
    originAddress = `${current.lat},${current.lng}`;
    originLabel = he ? 'המיקום שלי עכשיו' : 'My location now';
    fromProfile = {
      ...storedProfile,
      homeAddress: '',                 // force the coordinate origin
      homeLat: current.lat,
      homeLng: current.lng,
      homeLatLng: { lat: current.lat, lng: current.lng },
    } as unknown as UserProfile;
  } else if (origin === 'auto') {
    // The chain's own answer. Whatever it planned from last is already stamped
    // on the plan; failing that, home.
    originAddress = locOf(trip)?.transitPlan?.originAddress || profile.homeAddress;
    originLabel = originAddress === profile.homeAddress
      ? (he ? 'הבית' : 'Home')
      : originAddress;
    fromProfile = { ...storedProfile, homeAddress: originAddress } as unknown as UserProfile;
  } else {
    originAddress = origin.address;
    originLabel = origin.address;
    fromProfile = {
      ...storedProfile,
      homeAddress: origin.lat && origin.lng ? '' : origin.address,
      homeLat: origin.lat,
      homeLng: origin.lng,
      homeLatLng: origin.lat && origin.lng ? { lat: origin.lat, lng: origin.lng } : undefined,
    } as unknown as UserProfile;
  }

  const plan = await GoogleService.getPlanForMode(
    mode, dest, arrival, fromProfile, trip.date,
  ).catch(() => null);
  if (!plan) return { originLabel, reason: 'route-failed' };

  const base = locOf(trip) ?? { address: dest, lat: 0, lng: 0, confirmed: false };
  logSaved(`from-origin(${typeof origin === 'string' ? origin : 'place'})`, trip, plan);
  const location: TaskLocation = {
    ...base,
    transitPlan: { ...plan, originAddress, originLabel },
    leaveHomeBy: plan.leaveHomeAt,
    travelMinutes: plan.totalDurationMinutes,
    noRouteForMode: undefined,
    ...(pickCoords(base, plan) ?? {}),
  } as TaskLocation;
  const updated = { ...trip, location } as Task;

  await withTaskAlertLock(trip.id, async () => {
    await cancelTaskNotifications(trip).catch(() => {});
    const notifTask = { ...updated, notificationIds: [] } as Task;
    await scheduleTransitNotifications(notifTask, he ? 'he' : 'en', profile.defaultWakeTime)
      .catch(() => {});
    updated.notificationIds = notifTask.notificationIds;
    await updateTaskFields(trip.id, {
      location, notificationIds: notifTask.notificationIds,
    } as any);
  }).catch(async () => {
    await updateTaskFields(trip.id, { location } as any).catch(() => {});
  });

  return { task: updated, originLabel };
}

/**
 * She picked one. Make it the task's route — times, alerts and all.
 *
 * The one commit path, shared by every screen that shows the option list, so
 * picking the 09:45 on Today and picking it on the Leave-now screen do exactly
 * the same three things: rewrite the location, replace the alerts that belong
 * to the departure she is abandoning, and hand the caller the updated task so
 * it can render without a reload.
 */
export async function applyDepartureOption(
  trip: Task,
  plan: TransitPlan,
  language: AppLanguage = 'en',
): Promise<Task> {
  logSaved('picked-option', trip, plan);
  const base = locOf(trip) ?? { address: addrOf(trip) || '', lat: 0, lng: 0, confirmed: false };
  const location: TaskLocation = {
    ...base,
    transitPlan: plan,
    leaveHomeBy: plan.leaveHomeAt,
    travelMinutes: plan.totalDurationMinutes,
    noRouteForMode: undefined,
    ...(pickCoords(base, plan) ?? {}),
  } as TaskLocation;
  const updated = { ...trip, location } as Task;

  await withTaskAlertLock(trip.id, async () => {
    await cancelTaskNotifications(trip).catch(() => {});
    const notifTask = { ...updated, notificationIds: [] } as Task;
    await scheduleTransitNotifications(notifTask, language, undefined).catch(() => {});
    updated.notificationIds = notifTask.notificationIds;
    await updateTaskFields(trip.id, {
      location, notificationIds: notifTask.notificationIds,
    } as any);
  }).catch(async () => {
    await updateTaskFields(trip.id, { location } as any).catch(() => {});
  });

  return updated;
}

/**
 * One short line: the next departure, the arrival it implies, and — stated
 * outright rather than left to infer from two clock times — whether that is
 * late for the appointment.
 */
export function describeNextDeparture(
  plan: TransitPlan, appointment: string | undefined, he: boolean,
): string {
  const late = appointment && plan.arriveAt > appointment;
  const ride = plan.firstBusStop && plan.legs.some((l) => l.type !== 'walk');
  const line = plan.legs.find((l) => l.type !== 'walk')?.lineNumber;
  const how = ride
    ? (he ? `${line ? line + ' ' : ''}מ${plan.firstBusStop} ב-${plan.firstBusDeparture}`
          : `${line ? line + ' ' : ''}from ${plan.firstBusStop} at ${plan.firstBusDeparture}`)
    : (he ? `יציאה ב-${plan.leaveHomeAt}` : `leave at ${plan.leaveHomeAt}`);
  return he
    ? `🚏 הבא: ${how} · הגעה ${plan.arriveAt}${late ? ` (אחרי ${appointment})` : ' ✓'}`
    : `🚏 Next: ${how} · arrive ${plan.arriveAt}${late ? ` (after ${appointment})` : ' ✓'}`;
}

/**
 * If the user has drifted from where the next trip's plan assumed she is,
 * re-route from her real position and update the task. Returns what happened so
 * the caller can decide whether to surface it; a no-op is the common case.
 *
 * `notify` sends a short "you've moved — new leave time" message only when the
 * leave time actually changed, because a silent leave time is not trustworthy
 * and a redundant one is noise.
 */
/**
 * Stamp the tasks she has actually reached.
 *
 * The gap this closes: nothing in the app ever asked whether she had ARRIVED.
 * A conference reached at 08:50 stayed "pending with a route", so the travel
 * card kept planning a journey to a building she was sitting in, and the trip
 * to the next thing was still measured from home rather than from where she
 * was. Presence was simply never an input.
 *
 * One fix per sweep, reused for every task — GPS is the expensive part, and
 * the loop that calls this already runs every two minutes.
 *
 * Marking arrival also cancels that task's alerts: a "time to leave" for a
 * trip already made is the most annoying possible notification.
 *
 * Deliberately one-way. Presence flickers — a fix indoors wanders, and she may
 * step out for coffee — so arrival is never UNSET here. Undoing it is a
 * decision for the user, not for a noisy sensor.
 */
export async function markArrivals(
  tasks: Task[],
  opts: { now?: Date; current?: { lat: number; lng: number } | null } = {},
): Promise<{ arrived: Task[] }> {
  const current = opts.current !== undefined ? opts.current : await getCurrentLocation();
  if (!current) return { arrived: [] };

  const now = opts.now ?? new Date();
  const hhmm = nowHHMM(now);
  const arrived: Task[] = [];

  for (const task of tasks) {
    if (task.status !== 'pending' || task.verifiedArrival) continue;
    const loc = locOf(task);
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue;

    const startsAt = timeOf(task) ?? undefined;
    const endsAt = startsAt
      ? addMinutes(startsAt, task.durationMinutes || 30)
      : undefined;

    const verdict = presenceFor(
      current, { lat: loc.lat as number, lng: loc.lng as number },
      { startsAt, endsAt, nowHHMM: hhmm },
    );
    if (verdict.presence !== 'arrived') continue;

    await withTaskAlertLock(task.id, async () => {
      await cancelTaskNotifications(task).catch(() => {});
      await updateTaskFields(task.id, {
        verifiedArrival: true, notificationIds: [],
      } as any).catch(() => {});
    });
    arrived.push({ ...task, verifiedArrival: true } as Task);
  }
  return { arrived };
}

/**
 * The live loop's one entry point: keep the NEXT trip true to where she is.
 *
 * Her spec, in her words: "if location changed — show current location — and
 * check the next task to occur; if location has changed and it's not the
 * requested next location, recalculate the travel route to the next location.
 * If user is late also need to recalculate (update time of bus, trains,
 * driving...)". Three triggers, and until now the Today screen wired only one
 * of them — and that one only while she was demonstrably still at home.
 *
 * The decision is pure and lives in liveReplanDecision (tests/run-live-replan
 * drives every branch). What is left here is the part that needs a device:
 * read the fix, then pick which of the two EXISTING re-planners answers the
 * question that actually fired. They ask different questions and the choice
 * matters:
 *
 *   moved, still in time  → keep the arrival deadline, move the origin. She
 *                           has somewhere to be at 10:00 and is now starting
 *                           from a different place; the deadline is the fixed
 *                           point and the departure moves.
 *   late (either kind)    → the deadline is already unachievable, so asking
 *                           Google to meet it returns nothing. Ask the only
 *                           answerable question instead — leave NOW, when do I
 *                           land — and re-arm the alerts for that departure.
 *
 * A move that is ALSO late takes the depart-now path from the live point: the
 * origin moves and the deadline is dropped, because both are true at once.
 *
 * `current` is injectable so the caller's tick spends ONE GPS fix on arrivals,
 * presence and this, rather than three.
 */
export async function keepNextTripLive(
  tasks: Task[],
  storedProfile: any,
  opts: {
    current?: { lat: number; lng: number } | null;
    now?: Date;
    notify?: boolean;
    language?: AppLanguage;
  } = {},
): Promise<{
  replanned: boolean;
  reason: ReplanReason;
  message?: string;
  task?: Task;
  metres?: number;
}> {
  const profile = normalizeProfile(storedProfile) as UserProfile | null;
  if (!profile) return { replanned: false, reason: 'no-trip' };

  const now = opts.now ?? new Date();
  const trip = nextTrip(tasks, now);
  if (!trip) return { replanned: false, reason: 'no-trip' };

  const current = opts.current !== undefined
    ? opts.current
    : await getCurrentLocation().catch(() => null);

  const loc = locOf(trip);
  const plan = loc?.transitPlan;
  const decision = decideLiveReplan({
    current,
    home: Number.isFinite(profile.homeLat) && Number.isFinite(profile.homeLng)
      ? { lat: profile.homeLat, lng: profile.homeLng } : null,
    trip: {
      destination: loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
        ? { lat: loc.lat as number, lng: loc.lng as number } : null,
      plannedFrom: assumedOrigin(trip),
      leaveHomeBy: loc?.leaveHomeBy,
      arriveAt: plan?.arriveAt,
      appointment: timeOf(trip) ?? undefined,
    },
    now,
    lastReplanAt: lastLiveReplanAt.get(trip.id),
  });
  if (!decision.replan) {
    return { replanned: false, reason: decision.reason, metres: decision.metres };
  }

  // Stamp BEFORE the call, not after: a routing round-trip is seconds long and
  // the loop ticks on its own clock, so stamping afterwards lets two ticks
  // start the same re-plan. The cooldown is a budget, and a call that fails
  // has already spent part of it.
  lastLiveReplanAt.set(trip.id, now.getTime());

  const he = (opts.language ?? (profile as any).language) === 'he';
  const why = describeReplanReason(decision.reason, he);
  const fromHere = current ? profileFromPoint(storedProfile, current) : storedProfile;

  // Late — by the clock or by the plan's own arithmetic. Only "when can I
  // leave now" has an answer.
  if (decision.reason !== 'moved-off-origin'
    || missedPlannedDeparture(loc?.leaveHomeBy, now)) {
    const result = await replanFromNextDeparture(trip, fromHere, {
      notify: opts.notify, now, language: opts.language,
    });
    return {
      replanned: result.replanned,
      reason: decision.reason,
      message: result.message ? `${why} · ${result.message}` : why,
      task: result.task,
      metres: decision.metres,
    };
  }

  // Moved, and still in time: the deadline holds, the origin moves.
  const { task, reason } = await replanFromOrigin(
    trip, storedProfile,
    { address: `${current!.lat},${current!.lng}`, lat: current!.lat, lng: current!.lng },
    { language: opts.language },
  );
  if (!task) return { replanned: false, reason: decision.reason, metres: decision.metres };

  const newPlan = locOf(task)?.transitPlan;
  const message = newPlan
    ? `${why} · ${describeNextDeparture(newPlan, timeOf(trip) ?? undefined, he)}`
    : why;
  if (opts.notify && newPlan && newPlan.leaveHomeAt !== loc?.leaveHomeBy) {
    await sendImmediate(
      he ? '📍 עדכנתי את זמן היציאה' : '📍 Updated your leave time',
      message, { taskId: trip.id, type: 'live-replan' },
    ).catch(() => {});
  }
  void reason;
  return {
    replanned: true, reason: decision.reason, message, task, metres: decision.metres,
  };
}

export async function replanNextTripFromPosition(
  tasks: Task[],
  storedProfile: any,
  opts: { notify?: boolean; now?: Date } = {},
): Promise<LiveReplanResult> {
  const profile = normalizeProfile(storedProfile) as UserProfile | null;
  if (!profile) return { replanned: false, reason: 'no-profile' };

  const trip = nextTrip(tasks, opts.now);
  if (!trip) return { replanned: false, reason: 'no-trip' };

  const current = await getCurrentLocation();
  const verdict = assessDrift(assumedOrigin(trip), current);
  if (!verdict.shouldReplan) {
    // Not moved — but has the planned departure already passed? If she is still
    // home at 17:19 for a 17:18 leave time, the bus she was going to catch is
    // gone. Recompute from the NEXT departure so the times on screen stop lying.
    const leaveBy = locOf(trip)?.leaveHomeBy;
    if (verdict.reason === 'at-assumed-origin' && missedPlannedDeparture(leaveBy, opts.now)) {
      return replanFromNextDeparture(trip, storedProfile, opts);
    }
    return { replanned: false, reason: verdict.reason, metres: verdict.metres };
  }

  // Re-plan from the real fix. The destination, arrival deadline and mode are
  // unchanged — only the origin moves to where she is.
  const dest = addrOf(trip)!;
  const arrival = timeOf(trip)!;
  const mode = locOf(trip)?.transportType ?? profile.transportType;
  const he = profile.language === 'he';

  // A profile whose home is overridden to the live position, so the shared
  // planner routes from there without a new API surface.
  const fromHere = {
    ...storedProfile,
    homeAddress: '',                 // force coordinate origin, not the stored address
    homeLat: current!.lat,
    homeLng: current!.lng,
    homeLatLng: { lat: current!.lat, lng: current!.lng },
  } as unknown as UserProfile;

  const plan = await GoogleService.getPlanForMode(
    mode, dest, arrival, fromHere, trip.date,
  );
  if (!plan) return { replanned: false, reason: 'route-failed', metres: verdict.metres };

  const oldLeave = locOf(trip)?.leaveHomeBy;
  const posBase = locOf(trip) ?? { address: dest, lat: 0, lng: 0, confirmed: false };
  const nextLocation = {
    ...posBase,
    transitPlan: { ...plan, startLat: current!.lat, startLng: current!.lng },
    leaveHomeBy: plan.leaveHomeAt,
    travelMinutes: plan.totalDurationMinutes,
    // startLat/startLng above are where SHE is; the destination's own
    // coordinates are a different thing and must not be overwritten by them.
    ...(pickCoords(posBase, plan) ?? {}),
  };
  logSaved('from-position', trip, plan);
  await updateTaskFields(trip.id, { location: nextLocation as any });

  const changed = oldLeave !== plan.leaveHomeAt;
  const message = describeReplan({
    he,
    metres: verdict.metres,
    oldLeave,
    newLeave: plan.leaveHomeAt,
    newArrive: plan.arriveAt,
    appointment: trip.fixedTime,
  });

  if (opts.notify && changed) {
    await sendImmediate(
      he ? '📍 עדכנתי את זמן היציאה' : '📍 Updated your leave time',
      message,
      { taskId: trip.id, type: 'live-replan' },
    ).catch(() => {});
  }

  return { replanned: true, reason: 'moved', message, metres: verdict.metres };
}

/**
 * "I left ✓" — the one implementation, for the button AND the notification action.
 *
 * Tapping it used to stamp `lastDepartureDetectedAt` and close the screen. That
 * is invisible: the "🚪 עדיין בבית?" nags at +4 and +8 minutes still fired, so
 * confirming you had left produced two more notifications asking whether you
 * had left. Three pings for one departure, and a button that looked broken
 * because the only thing it changed was a field nobody sees.
 *
 * What it must actually do:
 *   1. silence the leave alert and every nag behind it — the visible effect;
 *   2. take a REAL GPS fix and record where she left from. Every route in this
 *      app is planned from `profile.homeAddress`; the moment she is out the
 *      door that assumption is stale, and markArrivals / travel-time learning
 *      both measure from a departure point that until now was never recorded.
 *
 * Deliberately does NOT re-plan the route. Re-planning re-arms the alerts,
 * which would resurrect the very nags this just cancelled.
 *
 * Never throws: a denied location permission still gets the nags cancelled and
 * the departure stamped. `position` is null when there was no fix, so a caller
 * can say what actually happened instead of claiming a location it lacks.
 */
export async function confirmDeparture(
  taskId: string,
  opts: { now?: number } = {},
): Promise<{ at: number; position: { lat: number; lng: number } | null }> {
  const at = opts.now ?? Date.now();
  // First, and independent of everything else — this is what the user asked for.
  await cancelLeaveNags(taskId).catch(() => {});

  const position = await getCurrentLocation().catch(() => null);

  await updateTaskFields(taskId, {
    lastDepartureDetectedAt: at,
    ...(position
      ? { departedFromLat: position.lat, departedFromLng: position.lng }
      : {}),
  } as any).catch(() => {});

  return { at, position };
}
