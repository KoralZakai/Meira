/**
 * stillHere — the closed-app "you haven't left" question, decided on the phone.
 *
 * Koral, 28.10: location × calendar — she is still here and the meeting is
 * elsewhere. With the app open, LiveRoute re-plans from where she stands (her
 * position goes to our server and Google for the route, as the privacy policy
 * says for the open app). With the app CLOSED her background position never
 * leaves the phone — that is what she was told when she allowed it — so this
 * decides from the clock and the distance alone, with no route: the leave
 * time has passed and she is still at the place the trip starts from.
 * The exact next train is worked out when she opens the app.
 */
import { decideLiveReplan } from './liveReplanDecision';
import { assumedOrigin } from './liveRoutePlan';
import { locOf, timeOf } from './dayPlanning';
import { QUIET_FROM, QUIET_TO } from './geofencePick';
import type { Task } from '../types/index';

type LatLng = { lat: number; lng: number };

export function stillHereAlert(
  trip: Task, current: LatLng | null, home: LatLng | null, now: Date, he: boolean,
): { title: string; body: string } | null {
  // "Never at night" — the promise on the card covers this question too.
  const m = now.getHours() * 60 + now.getMinutes();
  if (m >= QUIET_FROM || m < QUIET_TO) return null;
  const loc = locOf(trip);
  const leave = loc?.leaveHomeBy || loc?.transitPlan?.leaveHomeAt;
  const decision = decideLiveReplan({
    current,
    home,
    trip: {
      destination: loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && (loc.lat || loc.lng)
        ? { lat: loc.lat as number, lng: loc.lng as number } : null,
      plannedFrom: assumedOrigin(trip),
      leaveHomeBy: leave,
      appointment: timeOf(trip) ?? undefined,
    },
    now,
    cooldownMs: 0,
  });
  // Only "the leave time went by and she is still where the trip starts". Moving
  // elsewhere needs a route, which needs the app open.
  if (!decision.replan || decision.reason !== 'departure-missed') return null;
  const at = timeOf(trip) ?? '';
  return he
    ? { title: `🚏 עוד לא יצאת ל${trip.text}`, body: `היציאה הייתה ב-${leave}, וזה ב-${at}. עדיין הולכת? פתחי את מאירה לזמן הבא.` }
    : { title: `🚏 You haven't left for ${trip.text}`, body: `You were due to leave at ${leave}; it starts at ${at}. Still going? Open Meira for the next departure.` };
}
