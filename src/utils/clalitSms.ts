/**
 * clalitSms — a Clalit appointment confirmation, read ON THE PHONE.
 *
 * Koral, 27.10: "MCP for the health funds, to book an appointment". Clalit has
 * no public API and its login is ID + SMS code, so Meira does not book — she
 * opens the booking screen (app / site / *2700), and when the confirmation SMS
 * arrives Koral shares it to Meira (or pastes it in the chat). This file turns
 * that text into a date, an hour and a clinic.
 *
 * Why here and not the model: the text is health data (which doctor, which
 * specialty). Parsed on the device, the raw SMS never leaves the phone; only
 * the date, hour and clinic go on to the task. And shared text is untrusted —
 * it must never reach the tool-using agent (security review, 27.10).
 *
 * Every refusal carries its reason (silent-state rule 1): "not a Clalit
 * message", "it was cancelled", "no hour in it" and "already past" are four
 * different things to tell her.
 *
 * Pure: tests/run-clalit-sms.ts.
 */

export interface ClinicAppointment {
  date: string;          // YYYY-MM-DD
  time: string;          // HH:MM
  doctor?: string;       // device-only — never put into a synced task field
  specialty?: string;    // device-only
  clinic?: string;       // "מרפאת כללית רמת אביב, איינשטיין 40 תל אביב"
}

export type ClalitParseFail = 'not_clalit' | 'cancelled' | 'no_date' | 'no_time' | 'in_past';

export type ClalitParse =
  | { ok: true; appt: ClinicAppointment }
  | { ok: false; reason: ClalitParseFail };

const CLALIT_RE = /כללית|clalit/i;
// "בוטל" / "התבטל" / "ביטול התור בוצע" — but NOT "לביטול השב 1", which every
// confirmation carries ("לביטול" does not contain "בוטל").
const CANCELLED_RE = /בוטל|התבטל|ביטול\s+(?:ה)?תור\s+(?:בוצע|התקבל)|cancel+ed/i;
const DATE_RE = /(?<!\d)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?!\d)/;
const TIME_RE = /(?<![\d./-])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/;
// ד"ר / ד״ר / דר' / Dr. + up to three words, stopping at a comma, a dot or "ב<day>".
const DOCTOR_RE = /(?:ד["״׳']ר|דר['׳]|Dr\.?)\s+((?:(?!ביום|בתאריך|בשעה|ב-)[^\s,.;:\d]+\s*){1,3})/i;
const SPECIALTIES = [
  'רפואת משפחה', 'רופא משפחה', 'רופאת משפחה', 'רופא ילדים', 'רופאת ילדים', 'רפואת ילדים',
  'רפואת נשים', 'גינקולוג', 'עור ומין', 'רופא עור', 'רפואת עור', 'עיניים', 'אף אוזן גרון',
  'א.א.ג', 'אורתופד', 'קרדיולוג', 'נוירולוג', 'אנדוקרינולוג', 'גסטרו', 'פסיכיאטר', 'אורולוג',
  'רופא שיניים', 'שיננית', 'אחות', 'בדיקת דם', 'בדיקות דם', 'רנטגן', 'אולטרסאונד', 'ממוגרפיה',
  'פיזיותרפיה', 'דיאטנית', 'family medicine', 'dermatolog', 'pediatric', 'orthoped',
];
// Where: "במרפאת …" / "במרכז …" / "מרפאה: …", up to the sentence's end or the
// SMS boilerplate that follows it.
const CLINIC_RE = /(?:ב?מרפאת|ב?מרכז|מרפאה:|במרפאה|at\s+clinic|clinic:)\s*([^\n]+?)(?=\s*(?:\.\s|\.$|\n|לביטול|לאישור|להזכירך|לפרטים|לשינוי|נא\s|יש\s+להגיע|\*|$))/i;

const pad = (n: number) => String(n).padStart(2, '0');

/** dd/mm[/yy[yy]] → YYYY-MM-DD; a missing year is the next such day from today. */
function isoDate(d: number, m: number, y: number | undefined, today: Date): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  let year = y === undefined ? today.getFullYear() : y < 100 ? 2000 + y : y;
  const check = new Date(year, m - 1, d);
  if (check.getMonth() !== m - 1) return null;   // 31/02
  if (y === undefined) {
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (check < t0) year += 1;
  }
  return `${year}-${pad(m)}-${pad(d)}`;
}

export function parseClalitSms(raw: string, now: Date = new Date()): ClalitParse {
  const text = (raw || '').replace(/\s+/g, ' ').trim();
  if (!CLALIT_RE.test(text)) return { ok: false, reason: 'not_clalit' };
  if (CANCELLED_RE.test(text)) return { ok: false, reason: 'cancelled' };

  const dm = DATE_RE.exec(text);
  const date = dm ? isoDate(Number(dm[1]), Number(dm[2]), dm[3] ? Number(dm[3]) : undefined, now) : null;
  if (!date) return { ok: false, reason: 'no_date' };

  // The hour is searched AFTER the date, so a "09:40" is not confused with a
  // date's digits and a phone number before it is skipped.
  const tm = TIME_RE.exec(text.slice(dm!.index + dm![0].length)) ?? TIME_RE.exec(text);
  if (!tm) return { ok: false, reason: 'no_time' };
  const time = `${pad(Number(tm[1]))}:${tm[2]}`;

  const nowKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (`${date} ${time}` < nowKey) return { ok: false, reason: 'in_past' };

  const doctor = DOCTOR_RE.exec(text)?.[1]?.trim().replace(/[,.]$/, '');
  const lower = text.toLowerCase();
  const specialty = SPECIALTIES.find((s) => lower.includes(s.toLowerCase()));
  const clinicRaw = CLINIC_RE.exec(text)?.[1]?.trim().replace(/[,.]+$/, '');
  const clinic = clinicRaw && clinicRaw.length >= 2 ? clinicRaw : undefined;

  return {
    ok: true,
    appt: {
      date, time,
      ...(doctor ? { doctor: `ד"ר ${doctor}` } : {}),
      ...(specialty ? { specialty } : {}),
      ...(clinic ? { clinic } : {}),
    },
  };
}

/** What she is told when the text could not be used — in words naming what was missing. */
export function parseFailText(reason: ClalitParseFail, he: boolean): string {
  const t: Record<ClalitParseFail, [string, string]> = {
    not_clalit: ['זו לא נראית הודעה של כללית, אז לא שמרתי כלום.', "This doesn't look like a Clalit message, so nothing was saved."],
    cancelled: ['כתוב שהתור בוטל, אז לא הכנסתי אותו ליומן.', 'It says the appointment was cancelled, so it is not in your diary.'],
    no_date: ['לא מצאתי תאריך בהודעה. מה התאריך?', "I couldn't find a date in the message. What's the date?"],
    no_time: ['לא מצאתי שעה בהודעה. באיזו שעה התור?', "I couldn't find an hour in the message. What time is it?"],
    in_past: ['התור הזה כבר עבר, אז לא שמרתי אותו.', 'That appointment has already passed, so it was not saved.'],
  };
  return t[reason][he ? 0 : 1];
}

// ── "Book me a doctor's appointment" ───────────────────────────────────────

const BOOK_VERB_RE = /(?:לקבוע|תקבע[יו]?|קבע[יו]|קביעת|להזמין|תזמינ[יו]|לזמן|book|schedule|make)\s+(?:לי\s+|me\s+|an?\s+)?(?:\S+\s+){0,2}?(?:תור|appointment)/i;
// "עור" alone is not here on purpose: it is inside "שיעור" (a lesson).
const HEALTH_RE = /רופא|רופאה|ד["״׳']ר|כללית|קופ[הת]\s*(?:ה)?חולים|מרפאה|אחות|בדיק[הת]|רפואת|עיניים|אורתופד|גינקולוג|doctor|clinic|clalit|\bgp\b|nurse|blood test/i;

/** "תקבעי לי תור לרופא" / "book me a doctor appointment" — a booking ask, not a task. */
export function isClinicBookingRequest(text: string): boolean {
  const t = (text || '').trim();
  if (t.length > 160) return false;          // a pasted SMS is not a request
  return BOOK_VERB_RE.test(t) && HEALTH_RE.test(t);
}

/** Does this text look like a Clalit confirmation she pasted (rather than typed)? */
export function looksLikeClalitSms(text: string): boolean {
  const t = text || '';
  if (!CLALIT_RE.test(t) || isClinicBookingRequest(t)) return false;
  // Anything long that names Clalit is kept local too, even with other words
  // ("ביקור", a test result): a miss here would send health text to the agent.
  return t.length > 80 || (DATE_RE.test(t) && /תור|appointment|זימון/i.test(t));
}

/** A clinic name that itself says the specialty ("מרכז בריאות הנפש") — not sent to Places or the cloud. */
export function clinicNamesSpecialty(clinic: string): boolean {
  const c = clinic.toLowerCase();
  return SPECIALTIES.some((s) => c.includes(s.toLowerCase()))
    || /נפש|פסיכ|נשים|האישה|פוריות|הריון|אונקולוג|סרטן|התמכרו|mental|psych|women|fertility|oncolog/i.test(c);
}

// ── Where the booking card's buttons go ────────────────────────────────────

/** Clalit's Android app (package `clalit.android`, scheme seen on the device 27.10). */
export const CLALIT_APP_URL = 'clalitapp://';
export const CLALIT_STORE_URL = 'market://details?id=clalit.android';
export const CLALIT_WEB_URL = 'https://www.clalit.co.il/he/Pages/default.aspx';
export const CLALIT_PHONE_URL = 'tel:*2700';
