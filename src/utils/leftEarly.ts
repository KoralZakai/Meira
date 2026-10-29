/**
 * leftEarly — she is somewhere else while a task at a place is still "on".
 *
 * 8.10, Koral: מילואים in Ramla, 09:00–18:00. She was home in Tel Aviv long
 * before 18:00; Today said "🏠 בבית" and still showed the whole day at the
 * base. "Meira must understand I arrived home earlier, say so, and edit the
 * task and shorten it — it should have changed when I reached Tel Aviv."
 *
 * presence.ts answers "is she THERE?"; markArrivals records the arrival. Nothing
 * asked the reverse: a task in progress whose place is far behind her. This
 * does, and nothing more. Pure — the fix, home and the clock are passed in;
 * tests/run-left-early.ts drives every branch.
 *
 * The radius is far wider than arrival's 400 m on purpose: stepping out for
 * lunch, a large base, GPS drift indoors are not "left". Kilometres away is.
 */
import { LatLng, distanceMetres } from './positionDrift';
import { isUserAtLocation } from './presence';
import { minutesToTime, timeToMinutes } from './timeUtils';

/** Farther than this from the place, mid-task, she has left it. */
export const LEFT_RADIUS_METRES = 3000;
/** Without a stored trip time: minutes per km on the way back (≈ 30 km/h door to door). */
const MIN_PER_KM = 2;

export interface LeftEarlyTask {
  id: string;
  status?: string;
  fixedTime?: string;
  scheduledTime?: string;
  durationMinutes?: number;
  verifiedArrival?: boolean;
  /** Already shortened, or she said "no" — never asked twice. */
  leftEarlyHandled?: boolean;
  location?: { lat?: number; lng?: number; travelMinutes?: number; displayName?: string; address?: string } | string;
}

export interface LeftEarlyVerdict {
  taskId: string;
  /** HH:MM — when she most likely left: now minus the trip back, never before the start. */
  endAt: string;
  /** The task's new length, start → endAt. */
  durationMinutes: number;
  /** She is at home (vs. just far away, e.g. in Tel Aviv on the way). */
  atHome: boolean;
  /** She was seen there (markArrivals) — shorten it; otherwise ASK. */
  wasThere: boolean;
  placeName?: string;
}

export function leftEarly(
  tasks: LeftEarlyTask[],
  current: LatLng | null | undefined,
  home: LatLng | null | undefined,
  nowHHMM: string,
): LeftEarlyVerdict[] {
  if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lng)) return [];
  const now = timeToMinutes(nowHHMM);
  const out: LeftEarlyVerdict[] = [];
  for (const t of tasks) {
    if ((t.status ?? 'pending') !== 'pending' || t.leftEarlyHandled) continue;
    const start = t.fixedTime || t.scheduledTime;
    const len = Number(t.durationMinutes) || 0;
    const loc = typeof t.location === 'object' ? t.location : undefined;
    if (!start || len <= 0 || !loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue;
    const s = timeToMinutes(start);
    const e = s + len;
    // In progress only: before the start she is on her way or late (another
    // question), after the end it simply ended. A task past midnight is left alone.
    if (e > 1440 || now <= s || now >= e) continue;
    const place = { lat: loc.lat as number, lng: loc.lng as number };
    const metres = distanceMetres(current, place);
    if (metres <= LEFT_RADIUS_METRES) continue;
    const back = Number.isFinite(loc.travelMinutes) && (loc.travelMinutes as number) > 0
      ? (loc.travelMinutes as number)
      : Math.round((metres / 1000) * MIN_PER_KM);
    const end = Math.max(s, now - back);
    out.push({
      taskId: t.id,
      endAt: minutesToTime(end),
      durationMinutes: Math.max(0, end - s),
      atHome: isUserAtLocation(current, home),
      wasThere: Boolean(t.verifiedArrival),
      placeName: loc.displayName || loc.address,
    });
  }
  return out;
}

/** The line Today shows, in her language. */
export function leftEarlyLine(v: LeftEarlyVerdict, title: string, he: boolean): string {
  const where = v.atHome ? (he ? 'חזרת הביתה' : "You're home") : (he ? 'יצאת' : 'You left');
  if (v.wasThere) {
    return he
      ? `🏠 ${where} מוקדם — ${title} הסתיים בערך ב-${v.endAt}, קיצרתי אותו`
      : `🏠 ${where} early — ${title} ended around ${v.endAt}, I shortened it`;
  }
  // Never seen there: she did not GO (13.10, Koral, on an interview she never
  // reached: "you asked many times 'finish earlier?' — not good. Ask: is it
  // cancelled? Does it need another time?").
  return he
    ? `❓ לא הגעת ל${title} — בוטל? צריך לקבוע מועד חדש?`
    : `❓ You didn't make it to ${title} — cancelled? Need a new time?`;
}

/**
 * What she hears and reads once a task ended early: the conclusion, not the
 * fact (8.10, Koral: "wow, you arrived earlier — it is a good time to study
 * now!"). `until` is when the freed window closes; `idea` the best thing for it.
 */
export function freedTimeLine(until: string, idea: string | undefined, atHome: boolean, he: boolean): string {
  const back = atHome ? (he ? 'וואו, חזרת מוקדם!' : "Wow, you're back early!") : (he ? 'סיימת מוקדם!' : 'You finished early!');
  if (!idea) return he ? `${back} יש לך זמן פנוי עד ${until}.` : `${back} You're free until ${until}.`;
  return he
    ? `${back} יש לך עד ${until} — זמן טוב ל${idea}.`
    : `${back} You have until ${until} — a good time for ${idea}.`;
}
