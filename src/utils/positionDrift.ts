/**
 * positionDrift — has the user moved far enough that the plan is wrong?
 *
 * Every route in the app is planned from `profile.homeAddress`, or from the
 * previous *planned* stop. The user's real position is never an input, so a
 * leave time computed at home is still shown unchanged when they are across
 * town — wrong by exactly the distance they have moved. This is the check that
 * decides when to re-plan.
 *
 * Pure, so it imports without react-native and can be tested. The position
 * reading and the re-planning live in services/LiveRoute.
 */

/** Beyond this, the plan's assumed origin is no longer where the user is. */
export const DRIFT_THRESHOLD_METRES = 300;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a flat approximation: at Israeli latitudes the cosine
 * correction is ~20%, which at a 300 m threshold is the difference between
 * re-planning and not.
 */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface DriftVerdict {
  /** True when the plan should be recomputed from the real position. */
  shouldReplan: boolean;
  metres: number;
  reason: 'at-assumed-origin' | 'moved' | 'no-fix' | 'no-origin';
}

/**
 * Compare where the plan assumed the user is against where they are.
 *
 * A missing fix is NOT treated as "moved": re-planning from a position we do
 * not have would replace a correct plan with a guess. When the location is
 * unknown the existing plan stands.
 */
export function assessDrift(
  assumedOrigin: LatLng | null | undefined,
  current: LatLng | null | undefined,
  thresholdMetres: number = DRIFT_THRESHOLD_METRES,
): DriftVerdict {
  if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lng)) {
    return { shouldReplan: false, metres: 0, reason: 'no-fix' };
  }
  if (!assumedOrigin || !Number.isFinite(assumedOrigin.lat) || !Number.isFinite(assumedOrigin.lng)) {
    // No recorded origin but a real fix: planning from the real position is
    // strictly better than planning from nothing.
    return { shouldReplan: true, metres: 0, reason: 'no-origin' };
  }
  const metres = Math.round(distanceMetres(assumedOrigin, current));
  return metres > thresholdMetres
    ? { shouldReplan: true, metres, reason: 'moved' }
    : { shouldReplan: false, metres, reason: 'at-assumed-origin' };
}

/**
 * One line saying what changed and why, so a different number is explainable.
 *
 * A leave time that silently changes is not trustworthy. "You're 2 km from
 * home — leave in 4 min instead of 20" is.
 */
export function describeReplan(opts: {
  he: boolean;
  metres: number;
  placeLabel?: string;
  oldLeave?: string;
  newLeave: string;
  newArrive?: string;
  appointment?: string;
}): string {
  const { he, metres, placeLabel, oldLeave, newLeave, newArrive, appointment } = opts;
  const where = placeLabel
    ? (he ? `את ב${placeLabel}` : `You're at ${placeLabel}`)
    : (he ? `זזת ${metres < 1000 ? `${metres} מ'` : `${(metres / 1000).toFixed(1)} ק"מ`}`
          : `You've moved ${metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`}`);

  const change = oldLeave
    ? (he ? `לצאת ב-${newLeave} במקום ${oldLeave}` : `leave at ${newLeave}, not ${oldLeave}`)
    : (he ? `לצאת ב-${newLeave}` : `leave at ${newLeave}`);

  // Being late is the fact that matters most, so it is said outright rather
  // than left for the reader to work out from two timestamps.
  const late =
    newArrive && appointment && newArrive > appointment
      ? (he ? ` — הגעה ${newArrive}, אחרי ${appointment}` : ` — arriving ${newArrive}, after ${appointment}`)
      : newArrive
        ? (he ? ` — הגעה ${newArrive}` : ` — arriving ${newArrive}`)
        : '';

  return `${where} — ${change}${late}`;
}
