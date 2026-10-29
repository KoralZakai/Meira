/**
 * ClinicAppointmentService — a Clalit appointment onto her day (27.10).
 *
 * The SMS was already parsed on the phone (utils/clalitSms). Saving keeps the
 * health detail on the phone too: the synced task says only "doctor
 * appointment – Clalit", its hour and the clinic's address — routing, the
 * leave alert and the wake alarm need nothing more. The doctor and specialty
 * are shown on the card she saves from and are NOT kept: task rows sit in the
 * cloud unsealed until SEAL_APP_ROWS is on, and a device-only copy nothing
 * reads would be health data with no reader and no delete (security review,
 * 27.10). Keep them once sealed rows are live and the task card can show them.
 *
 * The route is planned right away (ensureTravelChain for that day), so the
 * leave time can be said in the same sentence as "saved"; the usual triggers
 * (CalendarAutoSync → ensureTravelChainAhead) keep it fresh afterwards.
 * Every outcome says what happened, including "saved, but I couldn't find the
 * clinic" (silent-state rules 1 and 3).
 */
import { Task } from '../types/index';
import { ClinicAppointment, clinicNamesSpecialty, CLALIT_APP_URL, CLALIT_PHONE_URL, CLALIT_STORE_URL, CLALIT_WEB_URL } from '../utils/clalitSms';
import { addTask, getTasksForDate } from './TaskStorage';
import { searchPlaces } from './RoutePlanner';
import { ensureTravelChain } from './GoogleSync';
import { openLink } from './AnswerActions';

export type ClinicSaveResult =
  | { ok: true; task: Task; leaveAt?: string; noPlace?: boolean; already?: boolean }
  | { ok: false; reason: string };

/** The clinic as Google Places can find it: Clalit's name in front, once. */
export function clinicQuery(clinic: string): string {
  return /כללית|clalit/i.test(clinic) ? clinic : `כללית ${clinic}`;
}

/**
 * The synced title. The hour is in it on purpose: dedupeTasks merges active
 * rows with the same text on the same day, so two Clalit appointments on one
 * day (a doctor at 09:00, blood test at 11:00) would otherwise become one.
 */
export function clinicTaskText(time: string, he: boolean): string {
  return he ? `תור לרופא – כללית ${time}` : `Doctor appointment – Clalit ${time}`;
}

export async function saveClinicAppointment(appt: ClinicAppointment, he: boolean): Promise<ClinicSaveResult> {
  const text = clinicTaskText(appt.time, he);
  // The same SMS shared twice, or shared and then pasted: say so, and spend
  // no second Places / Directions call on it.
  try {
    const existing = (await getTasksForDate(appt.date)).find((t) => t.category === 'doctor'
      && t.fixedTime === appt.time && t.status !== 'complete' && /כללית|clalit/i.test(t.text));
    if (existing) return { ok: true, task: existing, already: true };
  } catch (e) {
    console.warn('[ClinicAppt] could not check for an existing appointment', String(e).slice(0, 80));
  }
  // A clinic whose name says the specialty is not searched: it would reach
  // Places and the unsealed task row. She adds the address on the card.
  const place = appt.clinic && !clinicNamesSpecialty(appt.clinic)
    ? (await searchPlaces(clinicQuery(appt.clinic)))[0] : undefined;
  let task: Task;
  try {
    task = await addTask({
      text,
      category: 'doctor',
      priority: 'must',
      isFixed: true,
      fixedTime: appt.time,
      durationMinutes: 60,
      date: appt.date,
      status: 'pending',
      historicalDurations: [],
      source: 'chat',
      ...(place ? {
        location: {
          // The address only: Google's place name can be "… women's health centre".
          address: place.address, lat: place.lat, lng: place.lng, confirmed: true,
        },
      } : {}),
    });
  } catch (e) {
    console.warn('[ClinicAppt] could not save the appointment', String(e).slice(0, 120));
    return { ok: false, reason: String(e).slice(0, 120) };
  }

  let leaveAt: string | undefined;
  if (place) {
    try {
      await ensureTravelChain(appt.date, he ? 'he' : 'en');
      const fresh = (await getTasksForDate(appt.date)).find((t) => t.id === task.id);
      const loc = fresh?.location;
      leaveAt = loc && typeof loc === 'object' ? loc.leaveHomeBy : undefined;
      if (fresh) task = fresh;
    } catch (e) {
      console.warn('[ClinicAppt] route not planned yet', String(e).slice(0, 80));
    }
  }
  return { ok: true, task, ...(leaveAt ? { leaveAt } : {}), ...(place ? {} : { noPlace: true }) };
}

/** The booking card's buttons. -> did it open; the app falls back to the Play Store. */
export const openClalitApp = () => openLink(CLALIT_APP_URL, CLALIT_STORE_URL);
export const openClalitWeb = () => openLink(CLALIT_WEB_URL);
export const dialClalit = () => openLink(CLALIT_PHONE_URL);
