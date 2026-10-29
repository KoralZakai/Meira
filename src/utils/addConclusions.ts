/**
 * addConclusions — what the app does with Meira's conclusions on the Add screen.
 *
 * The server (server/add_understand.py) says WHAT follows from a sentence:
 * "a greeting for Dad", "remind her about a gift the day before". It never says
 * HOW — it holds no phone number, no clock hour and no link. Those are built
 * here, from what only the phone knows:
 *
 *   waLink          the contact's number + the greeting → a wa.me link. She
 *                   sends it herself, in WhatsApp; nothing here sends anything.
 *   reminderSlot    "the day before" / "noon" → an actual date and hour, from
 *                   the event's own date and time.
 *   shouldAsk       WHEN to spend a server call: after a pause, when the sense
 *                   of the sentence changed, at most twice per add flow.
 *
 * Pure: the clock is passed in, nothing is read or written.
 */
import { addMinutes, minutesToTime, timeToMinutes } from './timeUtils';
import { localKey } from './dateExpression';
import { parseSignature, type LiveParse } from './liveParse';

// ── WhatsApp ────────────────────────────────────────────────────────────────

/**
 * A phone number as wa.me wants it: country code, digits only, no plus.
 * An Israeli local number ("050-123-4567", "0501234567", "501234567") gets 972.
 * Returns null for anything that cannot be a phone number — a link built from
 * junk opens a chat with a stranger.
 */
export function whatsappDigits(phone?: string | null): string | null {
  if (!phone) return null;
  const raw = String(phone).trim();
  let digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return null;
  if (raw.startsWith('+')) return digits.length <= 15 ? digits : null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `972${digits.slice(1)}`;
  else if (digits.length <= 9) digits = `972${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

/** https://wa.me/<number>?text=<greeting>, or null when there is no usable number. */
export function waLink(phone: string | undefined | null, text: string): string | null {
  const digits = whatsappDigits(phone);
  if (!digits) return null;
  const body = String(text || '').trim();
  return `https://wa.me/${digits}${body ? `?text=${encodeURIComponent(body)}` : ''}`;
}

// ── reminders ───────────────────────────────────────────────────────────────

export type ConclusionWhen =
  'one_hour_before' | 'morning_of' | 'noon_of' | 'evening_before' | 'day_before';

export interface ReminderSlot {
  date: string;
  time: string;
  /** True when the natural hour had already passed and was moved to soon. */
  moved?: boolean;
}

function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return localKey(new Date(y, m - 1, d + delta));
}

const ceil5 = (hhmm: string): string => minutesToTime(Math.ceil(timeToMinutes(hhmm) / 5) * 5);

/**
 * The date and hour a reminder lands on.
 *
 * "noon of the event" is 12:00 — unless the event is at 11:00, when a noon
 * reminder is a reminder for something already over, so it moves to an hour
 * before the event. And a slot already in the past (a gift reminder for "the
 * morning of" a party that is tonight) becomes the next five minutes, flagged
 * `moved`, rather than silently vanishing; if the EVENT itself has passed there
 * is nothing to remind about and the answer is null — the caller says so.
 */
export function reminderSlot(
  when: ConclusionWhen,
  event: { date: string; time?: string },
  now: Date,
): ReminderSlot | null {
  const today = localKey(now);
  const nowHHMM = minutesToTime(now.getHours() * 60 + now.getMinutes());
  const hourBefore = event.time ? addMinutes(event.time, -60) : undefined;
  // An hour-before that wraps past midnight is not "before" at all.
  const usableHourBefore = hourBefore && timeToMinutes(hourBefore) < timeToMinutes(event.time!)
    ? hourBefore : undefined;

  const earlier = (preferred: string): string =>
    usableHourBefore && timeToMinutes(preferred) >= timeToMinutes(event.time!)
      ? usableHourBefore : preferred;

  let slot: ReminderSlot;
  switch (when) {
    case 'one_hour_before':
      slot = { date: event.date, time: usableHourBefore ?? '09:00' };
      break;
    case 'morning_of':
      slot = { date: event.date, time: earlier('09:00') };
      break;
    case 'noon_of':
      slot = { date: event.date, time: earlier('12:00') };
      break;
    case 'evening_before':
      slot = { date: shiftDay(event.date, -1), time: '19:00' };
      break;
    case 'day_before':
    default:
      slot = { date: shiftDay(event.date, -1), time: '17:00' };
      break;
  }

  const eventOver = event.date < today
    || (event.date === today && event.time !== undefined && timeToMinutes(event.time) <= timeToMinutes(nowHHMM));
  if (eventOver) return null;

  const past = slot.date < today || (slot.date === today && timeToMinutes(slot.time) <= timeToMinutes(nowHHMM));
  if (past) {
    // The natural moment is gone but the event is not: soon, today.
    const soon = ceil5(addMinutes(nowHHMM, 5));
    if (timeToMinutes(soon) < timeToMinutes(nowHHMM)) return null;      // wrapped past midnight
    if (event.date === today && event.time && timeToMinutes(soon) >= timeToMinutes(event.time)) return null;
    return { date: today, time: soon, moved: true };
  }
  return slot;
}

// ── when to ask the server ──────────────────────────────────────────────────

export const ASK_PAUSE_MS = 1500;
export const ASK_MIN_CHARS = 8;
export const ASK_MAX_CALLS = 2;

export interface AskState {
  calls: number;
  lastText: string;
  lastSignature: string;
  /** Set once the server said the allowance is used up: no more tries this flow. */
  blocked?: string;
}

export const freshAskState = (): AskState => ({ calls: 0, lastText: '', lastSignature: '' });

/**
 * Is this pause worth a server call?
 *
 * Every call is one of her fifteen AI requests today, so the gate is strict:
 * at least 8 characters, different from what was last asked about, a sentence
 * whose SENSE moved (a person, an occasion, a day — not another letter), at
 * most two per flow, and only for what the server can add to: an occasion
 * (greeting, gift) or an interview. Everything else the chips already say.
 */
export function shouldAsk(text: string, parse: LiveParse, state: AskState): { ask: boolean; why: string } {
  const t = String(text || '').trim();
  if (state.blocked) return { ask: false, why: `blocked:${state.blocked}` };
  if (state.calls >= ASK_MAX_CALLS) return { ask: false, why: 'max_calls' };
  if (t.length < ASK_MIN_CHARS) return { ask: false, why: 'too_short' };
  if (t === state.lastText) return { ask: false, why: 'unchanged' };
  // A bare "gift" is already the errand; a celebration is what earns a greeting.
  const worthIt = (parse.occasion && parse.occasion !== 'gift') || parse.category === 'interview';
  if (!worthIt) return { ask: false, why: 'nothing_to_add' };
  if (parseSignature(parse) === state.lastSignature) return { ask: false, why: 'same_sense' };
  return { ask: true, why: 'ok' };
}

// ── what the server says ────────────────────────────────────────────────────

export type ConclusionKind = 'greeting' | 'whatsapp_send' | 'reminder' | 'interview' | 'prep';

export interface Conclusion {
  kind: ConclusionKind;
  text_he: string;
  text_en: string;
  action: { type: 'show_greeting' | 'open_whatsapp' | 'add_reminder' | 'add_prep' | 'none';
    when?: ConclusionWhen; needs_contact?: boolean };
}

export interface UnderstandResult {
  ok: boolean;
  reason?: 'ai_limit' | 'model_unavailable' | 'bad_output' | 'too_short' | 'rate_limited' | 'no_server';
  conclusions?: Conclusion[];
  greeting?: { to: string; text_he: string; text_en: string };
  model_used?: boolean;
}

const KINDS: ConclusionKind[] = ['greeting', 'whatsapp_send', 'reminder', 'interview', 'prep'];
const ACTIONS = ['show_greeting', 'open_whatsapp', 'add_reminder', 'add_prep', 'none'];
const WHENS: ConclusionWhen[] = ['one_hour_before', 'morning_of', 'noon_of', 'evening_before', 'day_before'];

/**
 * Trust the server's shape, not its word: a conclusion this build does not
 * know how to act on is dropped, not rendered as a button that does nothing.
 */
export function sanitizeConclusions(list: unknown): Conclusion[] {
  if (!Array.isArray(list)) return [];
  const out: Conclusion[] = [];
  for (const c of list as any[]) {
    if (!c || !KINDS.includes(c.kind) || typeof c.text_he !== 'string' || typeof c.text_en !== 'string') continue;
    const type = c.action?.type;
    if (!ACTIONS.includes(type)) continue;
    const when = WHENS.includes(c.action?.when) ? c.action.when : undefined;
    if ((type === 'add_reminder' || type === 'add_prep') && !when) continue;
    out.push({
      kind: c.kind, text_he: c.text_he, text_en: c.text_en,
      action: { type, ...(when ? { when } : {}), ...(c.action?.needs_contact ? { needs_contact: true } : {}) },
    });
  }
  return out;
}

/** One short line for every reason the server could not think — never silence. */
export function understandFailureLine(reason: string | undefined, he: boolean): string {
  switch (reason) {
    case 'ai_limit':
      return he ? 'מאירה סיימה להיום את החשיבה — אפשר להוסיף כרגיל' : "Meira's done thinking for today — add as usual";
    default:
      return he ? 'לא הספקתי לחשוב על זה — אפשר להוסיף כרגיל' : "Couldn't think that through — add as usual";
  }
}
