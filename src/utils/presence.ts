/**
 * presence — is she ALREADY there?
 *
 * Every route in the app answers "how do I get to X". Nothing asked whether
 * she is standing in X already. So a conference she reached at 08:50 kept its
 * travel card all day: Lumi went on planning a journey to a building she was
 * inside, and — because the chain hangs each leg off the one before it — the
 * trip to the NEXT thing was still measured from home.
 *
 * Two questions, kept apart on purpose:
 *
 *   isUserAtLocation — pure geometry. Within `radius` of the place, yes.
 *   presenceFor      — geometry PLUS the clock, because being near a place at
 *                      the wrong hour is not the same as attending it. Walking
 *                      past the university at 22:00 is not arriving at a
 *                      conference that ended at 18:00.
 *
 * The radius is deliberately generous. A GPS fix indoors drifts by 50-150 m,
 * and a campus, a hospital or a conference centre is itself hundreds of metres
 * across — the pin is one door of many. Being wrong in the "she's here"
 * direction costs a suppressed travel card; being wrong the other way sends
 * her a journey to where she is standing, which is the bug being fixed. The
 * threshold is larger than positionDrift's 300 m re-plan trigger for the same
 * reason: arriving is a coarser question than having moved.
 *
 * Pure — no GPS, no storage, no clock of its own. The fix and `now` are passed
 * in, so tests/run-presence.ts drives every branch without a device.
 */
import { LatLng, distanceMetres } from './positionDrift';

/** Inside this, treat her as present at the place. */
export const ARRIVAL_RADIUS_METRES = 400;

/**
 * How long after a task's end she still counts as "there".
 *
 * A conference does not eject everyone at the closing minute, and the phone
 * may only get a fix some time later.
 */
export const LINGER_MINUTES = 30;

export type Presence =
  /** She is at the place, within its hours: the journey there is done. */
  | 'arrived'
  /** She is somewhere else and the task is still ahead: a real trip remains. */
  | 'travelling'
  /** No fix, or no coordinates on the task — decide nothing. */
  | 'unknown';

export interface PresenceVerdict {
  presence: Presence;
  /** Distance to the place, when both points were known. */
  metres?: number;
}

const toMinutes = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Pure geometry: is this fix within `radius` of that place? */
export function isUserAtLocation(
  current: LatLng | null | undefined,
  place: LatLng | null | undefined,
  radiusMetres: number = ARRIVAL_RADIUS_METRES,
): boolean {
  if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lng)) return false;
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return false;
  return distanceMetres(current, place) <= radiusMetres;
}

/**
 * Presence at one task's place, given where she is and what time it is.
 *
 * `startsAt`/`endsAt` are HH:MM. Without them the clock is not consulted and
 * the answer is geometry alone — which is the honest fallback for a task that
 * never had a time.
 */
export function presenceFor(
  current: LatLng | null | undefined,
  place: LatLng | null | undefined,
  window: { startsAt?: string; endsAt?: string; nowHHMM?: string } = {},
  radiusMetres: number = ARRIVAL_RADIUS_METRES,
): PresenceVerdict {
  if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lng)) {
    return { presence: 'unknown' };
  }
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
    return { presence: 'unknown' };
  }
  const metres = Math.round(distanceMetres(current, place));
  if (metres > radiusMetres) return { presence: 'travelling', metres };

  // She is at the place. Does the clock agree she is attending it?
  const { startsAt, endsAt, nowHHMM } = window;
  if (nowHHMM && endsAt && toMinutes(nowHHMM) > toMinutes(endsAt) + LINGER_MINUTES) {
    // Long after it finished — she is simply somewhere that happens to be here.
    return { presence: 'travelling', metres };
  }
  void startsAt;   // arriving EARLY is still arriving; the start time is not a gate
  return { presence: 'arrived', metres };
}

/**
 * Where she is, in the three states the day actually has.
 *
 * presenceFor answers about ONE place. The schedule needs the other question:
 * of everywhere today, which — if any — is she standing in? That is what turns
 * "leave home at 09:05" into either a real instruction or a stale one, and it
 * is what decides whether the next leg is measured from the house or from
 * Nahariya.
 *
 * Deliberately three states and no more:
 *   at-home    — the origin every plan assumes. Departure advice is live.
 *   at-venue   — inside one of today's places. The trip there is done; the
 *                NEXT leg starts here, not at home.
 *   in-transit — somewhere that is neither. Between two places is a real state,
 *                not an error, and it is the one where "you'll be late" means
 *                something different from the other two.
 *   unknown    — no fix. Say nothing rather than guess.
 *
 * Pure: the fix, the places and the clock are all passed in.
 */
export type DayPresence = 'at-home' | 'at-venue' | 'in-transit' | 'unknown';

export interface DayPresenceVerdict {
  state: DayPresence;
  /** The task she is at, when the state is 'at-venue'. */
  atTaskId?: string;
  /** Its display name, for the chip. */
  placeName?: string;
  metres?: number;
}

export function dayPresence(
  current: LatLng | null | undefined,
  places: Array<{
    id: string;
    lat?: number;
    lng?: number;
    name?: string;
    startsAt?: string;
    endsAt?: string;
  }>,
  home: LatLng | null | undefined,
  nowHHMM?: string,
  radiusMetres: number = ARRIVAL_RADIUS_METRES,
): DayPresenceVerdict {
  if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lng)) {
    return { state: 'unknown' };
  }

  // A venue wins over home when both match — a meeting held at her own address
  // is somewhere she is attending, not somewhere she is waiting to leave.
  let best: DayPresenceVerdict | null = null;
  for (const p of places) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const verdict = presenceFor(
      current, { lat: p.lat as number, lng: p.lng as number },
      { startsAt: p.startsAt, endsAt: p.endsAt, nowHHMM }, radiusMetres,
    );
    if (verdict.presence !== 'arrived') continue;
    if (!best || (verdict.metres ?? Infinity) < (best.metres ?? Infinity)) {
      best = {
        state: 'at-venue', atTaskId: p.id, placeName: p.name, metres: verdict.metres,
      };
    }
  }
  if (best) return best;

  if (isUserAtLocation(current, home, radiusMetres)) {
    return { state: 'at-home', metres: Math.round(distanceMetres(current, home!)) };
  }

  // "In transit" means NOT at home and NOT at a venue — which is only knowable
  // when we know where home is. A profile with no home coordinates (a restore,
  // an onboarding that skipped the address) made every fix fail the home test
  // and be reported as travelling, so a woman sitting in her kitchen was told
  // she was on her way. Saying nothing is the honest answer.
  const knowHome = Boolean(home && Number.isFinite(home.lat) && Number.isFinite(home.lng));
  if (!knowHome) return { state: 'unknown' };
  return { state: 'in-transit' };
}

/** The chip text: "📍 At home" / "🚆 In transit" / "📍 At Tel Aviv University". */
export function describeDayPresence(v: DayPresenceVerdict, he: boolean): string {
  switch (v.state) {
    case 'at-home':
      return he ? '🏠 בבית' : '🏠 At home';
    case 'at-venue':
      return v.placeName
        ? (he ? `📍 ב${v.placeName}` : `📍 At ${v.placeName}`)
        : (he ? '📍 במקום' : '📍 At the venue');
    case 'in-transit':
      return he ? '🚆 בדרך' : '🚆 In transit';
    default:
      return he ? '📍 מיקום לא ידוע' : '📍 Location unknown';
  }
}

/**
 * Can being here count as ARRIVING at this task? Only on the day it is on.
 *
 * 20.10, 21:02: she was at home, and tomorrow's "מפגש קמפ" at 21:00 (and two more
 * tasks at her home address) were marked arrived — one of them done — because the
 * check compared the CLOCK with the task's hour and never its DATE. A task on another
 * day cannot be arrived at; being at its address tonight is not being at it tomorrow.
 */
export function canArriveToday(task: { date?: string }, now: Date): boolean {
  if (!task.date) return true;               // undated: nothing to contradict
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return task.date === key;
}
