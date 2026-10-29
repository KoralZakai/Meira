/**
 * AnswerActions — what the answer card's buttons DO (components/AnswerCard).
 *
 * "יוצאת עכשיו" puts the trip on today with her chosen way of going, so the
 * existing machinery takes over: ArrivedTaskPlanner routes it, the leave alert
 * fires, and Today shows it with "I left". Nothing new to trigger (rule 7).
 * Every action says whether it worked — a button that cannot fail is not a
 * button (rule 3).
 */
import { Linking } from 'react-native';
import { Task } from '../types/index';
import { addTask, toDateKey } from './TaskStorage';
import { planArrivedTasks } from './ArrivedTaskPlanner';
import { CardOption, GETT_STORE, LookupAnswer, gettLink, travelModeOf } from '../utils/answerCard';

/** Open a link; a missing app falls back to `fallback`. -> did anything open. */
export async function openLink(url: string, fallback?: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch (e) {
    console.warn('[AnswerActions] could not open', url.slice(0, 60), e);
    if (!fallback) return false;
    try {
      await Linking.openURL(fallback);
      return true;
    } catch (e2) {
      console.warn('[AnswerActions] fallback failed too', e2);
      return false;
    }
  }
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export type TripResult = { ok: true; task: Task; arriveAt: string } | { ok: false; reason: string };

/**
 * The trip, on today, leaving now: arrival = now + the door-to-door minutes
 * (or the bus's own arrival). Taxi also opens Gett with the drop-off filled in.
 */
export async function startTripNow(a: LookupAnswer, opt: CardOption, he: boolean): Promise<TripResult> {
  const lat = opt.lat ?? a.destination?.lat;
  const lng = opt.lng ?? a.destination?.lng;
  if (lat == null || lng == null) {
    return { ok: false, reason: he ? 'אין לי מיקום מדויק של היעד' : 'no exact position for the destination' };
  }
  const route = a.kind === 'route';
  const destName = route
    ? (a.to_home ? (he ? 'הבית' : 'home') : (a.destination?.name ?? ''))
    : opt.title;
  const address = route ? (a.destination?.address ?? destName) : (a.results.find((r) => r.name === opt.title)?.address ?? opt.title);
  const leg = route ? a.results[0].by_mode?.[opt.mode] : a.results.find((r) => r.name === opt.title)?.best;
  const arriveAt = leg?.arrive_at ?? hhmm(new Date(Date.now() + opt.minutes * 60000));

  if (opt.mode === 'taxi') void openLink(gettLink({ lat, lng }, destName), GETT_STORE);

  try {
    const task = await addTask({
      text: route && a.to_home ? (he ? 'חזרה הביתה' : 'Going home') : (he ? `נסיעה ל${destName}` : `Trip to ${destName}`),
      category: 'general',
      priority: 'have_to',
      isFixed: true,
      fixedTime: arriveAt,
      durationMinutes: route && a.to_home ? 15 : 60,
      date: toDateKey(),
      status: 'pending',
      historicalDurations: [],
      source: 'chat',
      location: {
        address, displayName: destName, lat, lng, confirmed: true,
        transportType: travelModeOf(opt.mode), transportTypeBy: 'her',
      },
    });
    // Route it now — the leave alert and "I left" come from the plan.
    planArrivedTasks([task]).catch((e) => console.warn('[AnswerActions] routing the trip failed', e));
    return { ok: true, task, arriveAt };
  } catch (e) {
    console.warn('[AnswerActions] could not add the trip', e);
    return { ok: false, reason: String(e).slice(0, 120) };
  }
}
