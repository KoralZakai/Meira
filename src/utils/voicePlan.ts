/**
 * voicePlan — the pure half of "say it, and see your day".
 *
 *   "I must work today on Meira for the hackathon, also study for the next
 *    interview in Ceva (the second interview)."
 *
 * After the agent has saved the tasks, two decisions are arithmetic, not
 * language, so they live here where they can be tested:
 *
 *   1. linkPrepTasks — "study for the next interview in Ceva" is preparation
 *      FOR an appointment she already has. Tie it to that appointment, so the
 *      planner ends it before she has to leave (day_planner reads
 *      prepForTaskId) and the card can say what it is for. Matched on the
 *      appointment's distinctive words ("Ceva"), never on "interview" alone
 *      unless there is exactly one interview coming.
 *   2. describePlan — the one line she reads (and hears) afterwards, plus a
 *      line for anything that went wrong on the way: the calendar was not
 *      checked, her location was unknown, a task did not fit. Rule 1: each of
 *      those is said, never swallowed into "done".
 *
 * Dependencies: types only. Consumed by services/VoicePlanFlow.
 */
import { Task } from '../types/index';

/** Words that make a task preparation for something else. */
const PREP_WORDS = /(study|learn|prepare|prep\b|practi[cs]e|review|revise|ללמוד|ללמד|להתכונן|הכנה|להכין|לחזור על|תרגול|לתרגל)/i;

/** Appointments worth preparing for. */
const PREPARABLE: Task['category'][] = ['interview', 'meeting', 'conference', 'class', 'course', 'doctor', 'zoom'];

/** Words that say WHAT KIND of thing it is, not WHICH one — useless for matching. */
const GENERIC = new Set([
  'interview', 'interviews', 'meeting', 'exam', 'test', 'second', 'next', 'first', 'the', 'for',
  'and', 'with', 'at', 'in', 'on', 'to', 'of', 'a', 'an', 'my', 'job', 'call', 'phone', 'study',
  'learn', 'prepare', 'prep', 'review', 'today', 'tomorrow', 'also', 'must', 'work',
  'ראיון', 'ראיונות', 'פגישה', 'מבחן', 'שני', 'השני', 'הבא', 'הבאה', 'ראשון', 'עבודה', 'ללמוד',
  'להתכונן', 'הכנה', 'היום', 'מחר', 'גם', 'של', 'עם', 'את', 'על', 'אני', 'חייבת', 'חייב', 'צריכה',
  'צריך', 'טלפוני', 'טלפונית', 'בזום',
]);

/** Hebrew attaches prepositions to the word: "לראיון", "בCeva", "והכנה". */
function stripHebrewPrefix(word: string): string {
  // A Hebrew prefix glued to a Latin name: "בCeva" → "Ceva".
  if (/^[ובלכמשה]+[a-z]/i.test(word)) return word.replace(/^[ובלכמשה]+/, '');
  if (/^[א-ת]/.test(word) && word.length > 3) {
    return word.replace(/^(?:[ובלכמשה]|וה|שה|וב|ול|כש|מה)(?=[א-ת]{2})/, '');
  }
  return word;
}

export function distinctiveWords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9א-ת]+/i)
    // Judge the word as said AND without its prefix: "ללמוד" is generic as
    // said, and stripping it would leave "למוד", which is not a name either.
    .filter((raw) => !GENERIC.has(raw))
    .map(stripHebrewPrefix)
    .filter((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
}

export function looksLikePrep(task: Pick<Task, 'text'>): boolean {
  return PREP_WORDS.test(task.text || '');
}

export interface PrepLink {
  taskId: string;
  eventId: string;
  eventText: string;
  patch: Partial<Task> & { prepForTaskId: string };
}

/**
 * Tie preparation tasks to the appointment they prepare for.
 *
 * `upcoming` is what she has from today on (calendar imports included). The
 * SOONEST appointment sharing a distinctive word wins — "the next interview in
 * Ceva" means the next one. With no shared word, an interview-shaped task
 * links only when exactly one interview is coming, because guessing between
 * two is how prep ends up attached to the wrong company.
 */
export function linkPrepTasks(created: Task[], upcoming: Task[], today: string): PrepLink[] {
  const events = upcoming
    .filter((t) => t.date >= today && Boolean(t.fixedTime) && PREPARABLE.includes(t.category))
    .filter((t) => t.status !== 'complete')
    .sort((a, b) => `${a.date} ${a.fixedTime}`.localeCompare(`${b.date} ${b.fixedTime}`));

  const links: PrepLink[] = [];
  for (const task of created) {
    if (!looksLikePrep(task)) continue;
    if ((task as { prepForTaskId?: string }).prepForTaskId) continue;
    const words = new Set(distinctiveWords(task.text));
    let match = events.find((e) => e.id !== task.id
      && distinctiveWords(e.text).some((w) => words.has(w)));
    if (!match && /interview|ראיון/i.test(task.text)) {
      const interviews = events.filter((e) => e.category === 'interview' && e.id !== task.id);
      if (interviews.length === 1) match = interviews[0];
    }
    if (!match) continue;
    links.push({
      taskId: task.id,
      eventId: match.id,
      eventText: match.text,
      patch: {
        prepForTaskId: match.id,
        deadline: match.date,
        deadlineTime: match.fixedTime,
      },
    });
  }
  return links;
}

export interface PlacedSlot { id: string; text: string; start: string; end: string; why: string; shortened_from?: number }
export interface UnplacedSlot { id: string; text: string; why: string; need: number; largest: number }

export interface VoicePlanReport {
  /** Tasks the turn saved. */
  created: Task[];
  placed: PlacedSlot[];
  unplaced: UnplacedSlot[];
  prepLinks: PrepLink[];
  /** Google's own words if the calendar check failed, else null. */
  calendarError: string | null;
  /** How many events the pre-plan calendar check imported. */
  calendarAdded: number;
  location: 'here' | 'denied' | 'unavailable';
  /** Set when the planner could not be reached at all. */
  plannerOffline: boolean;
}

const short = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "Meira 08:15 · Ceva prep 11:25" — what landed where, in one glance. */
function slotList(placed: PlacedSlot[]): string {
  return placed.slice(0, 3).map((p) => `${short(p.text)} ${p.start}`).join(' · ');
}

function unplacedLine(u: UnplacedSlot, he: boolean): string {
  switch (u.why) {
    case 'past_deadline':
      return he ? `"${short(u.text)}" — המועד כבר עבר` : `"${short(u.text)}" — its deadline has passed`;
    case 'day_over':
      return he ? `"${short(u.text)}" — היום נגמר, למחר?` : `"${short(u.text)}" — the day is over, tomorrow?`;
    default:
      return he
        ? `"${short(u.text)}" — אין היום ${u.need} דק׳ פנויות ברצף`
        : `"${short(u.text)}" — no free ${u.need} min today`;
  }
}

/** "היום" / "מחר" / "8.10" — the day a task landed on, always said (rule 4). */
function dayLabel(date: string | undefined, today: string, he: boolean): string {
  if (!date) return '';
  if (date === today) return he ? 'היום' : 'today';
  const t = new Date(`${today}T12:00:00`);
  t.setDate(t.getDate() + 1);
  const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (date === tomorrow) return he ? 'מחר' : 'tomorrow';
  const [, m, d] = date.split('-').map(Number);
  return `${d}.${m}`;
}

function endOf(start: string, minutes: number): string {
  const total = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + (minutes || 0);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function placeOf(t: Task): string {
  const loc: any = t.location;
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  return loc.displayName || loc.address || '';
}

/** One saved task, as the outcome she asked for: what, when, where, what next. */
export function outcomeLines(t: Task, today: string, he: boolean, slot?: PlacedSlot): string[] {
  const place = placeOf(t);
  const lines: string[] = [];
  if (!t.fixedTime && slot) {
    // A flexible task the planner just placed: that slot IS the outcome.
    lines.push(`📅 ${he ? 'שובץ' : 'Planned'}: ${t.text} · ${dayLabel(t.date, today, he)} ${slot.start}–${slot.end}`);
  } else if (t.fixedTime) {
    const when = `${dayLabel(t.date, today, he)} ${t.fixedTime}–${endOf(t.fixedTime, t.durationMinutes)}`.trim();
    lines.push(`📅 ${he ? 'נקבע' : 'Set'}: ${t.text} · ${when}${place ? ` · 📍 ${place}` : ''}`);
    if (place) {
      // Honest about timing: the route, the leave time and the wake alarm are
      // built by the travel chain a moment after the save, not by this sheet.
      lines.push(he ? '🚆 מסלול, שעת יציאה ושעון מעורר — מחושבים עכשיו ויופיעו בכרטיס'
        : '🚆 Route, leave time and wake alarm — being worked out, they will show on the card');
    }
  } else {
    lines.push(he ? `📌 נשמר במשימות הגמישות: ${t.text}${t.date && t.date !== today ? ` · ${dayLabel(t.date, today, he)}` : ''}`
      : `📌 Saved to flexible tasks: ${t.text}${t.date && t.date !== today ? ` · ${dayLabel(t.date, today, he)}` : ''}`);
  }
  return lines;
}

/**
 * The OUTCOME of what she just said — not a report on her whole day.
 *
 * Koral, 28.9, after recording reserve duty: the sheet listed "no free 90 min
 * — למידה לראיון", "no free 15 min — לשלוח קורות חיים"… "What has studying
 * got to do with it? What is it trying to say?" It was the planner's verdict
 * on every flexible task of the day. The screen after a recording answers
 * ONE question — what happened to what I asked — in one of three shapes:
 *
 *   saved     → what, which day, from–to, where, and what follows (route/alarm)
 *   unclear   → Meira's question ("on which date?")
 *   clash     → what it collides with, and what should move
 *
 * The planner's lines survive only for the tasks created now; the rest of the
 * day is the timeline's business. Meira's reply is shown whenever it asks or
 * warns — before, it was shown only when nothing was saved, so a clash she
 * found never reached the screen.
 */
export function describePlan(r: VoicePlanReport, he: boolean, reply = '', today = ''):
{ headline: string; problems: string[] } {
  const day = today || new Date().toISOString().slice(0, 10);
  const mine = new Set(r.created.map((t) => t.id));
  const problems: string[] = [];

  // Meira's own words, when they ASK or WARN — a question or a clash.
  const asks = (reply || '').split('\n').map((l) => l.trim())
    .filter((l) => l && (l.includes('⚠️') || /[?？]\s*$/.test(l)));

  const slotOf = (id: string) => r.placed.find((p) => p.id === id);
  // Checks the plan itself relied on: said, because a plan built without
  // them may be wrong (rule 3). Only the ones that touch THIS request.
  if (r.calendarError) {
    problems.push(he ? `📅 לא בדקתי את היומן: ${r.calendarError}` : `📅 Calendar not checked: ${r.calendarError}`);
  }
  if (r.created.some((t) => placeOf(t))) {
    if (r.location === 'denied') {
      problems.push(he ? '📍 אין הרשאת מיקום — חישבתי מהבית' : '📍 No location permission — timed from home');
    } else if (r.location === 'unavailable') {
      problems.push(he ? '📍 לא מצאתי מיקום — חישבתי מהבית' : '📍 No GPS fix — timed from home');
    }
  }
  for (const t of r.created) problems.push(...outcomeLines(t, day, he, slotOf(t.id)).slice(1));
  for (const p of r.placed) {
    if (!mine.has(p.id)) continue;
    if (p.why === 'shortened' && p.shortened_from) {
      const len = minutesBetween(p.start, p.end);
      problems.push(he
        ? `⏳ "${short(p.text)}" קוצרה ל-${len} דק׳ (במקום ${p.shortened_from})`
        : `⏳ "${short(p.text)}" shortened to ${len} min (was ${p.shortened_from})`);
    }
  }
  for (const u of r.unplaced) if (mine.has(u.id)) problems.push(`⚠️ ${unplacedLine(u, he)}`);
  if (r.plannerOffline && r.created.some((t) => !t.fixedTime)) {
    problems.push(he ? '🗓️ לא הצלחתי לשבץ שעות — המשימות נשמרו בלי שעה' : "🗓️ Couldn't plan times — tasks saved without one");
  }
  problems.push(...asks);

  let headline: string;
  if (r.created.length) {
    headline = r.created.map((t) => outcomeLines(t, day, he, slotOf(t.id))[0]).join('\n');
  } else if (asks.length) {
    headline = he ? 'צריכה עוד פרט אחד 👇' : 'One more detail 👇';
  } else {
    headline = (reply || '').trim().split('\n')[0]
      || (he ? 'לא הבנתי מה להוסיף — נסי לומר שוב' : "I didn't catch what to add — try saying it again");
  }
  return { headline, problems };
}

/** The sentence Meira says out loud — the headline without the list. */
export function spokenLine(r: VoicePlanReport, he: boolean, reply = '', today = ''): string {
  // What she asked for, said back — not a count of the day's tasks ("שיבצתי 4
  // משימות" counted things she never mentioned).
  const day = today || new Date().toISOString().slice(0, 10);
  const question = (reply || '').split('\n').map((l) => l.trim()).find((l) => /[?？]\s*$/.test(l));
  if (!r.created.length) {
    return question || (he ? 'לא הבנתי מה להוסיף. נסי שוב.' : "I didn't catch what to add. Try again.");
  }
  const first = r.created[0];
  const at = first.fixedTime || r.placed.find((p) => p.id === first.id)?.start;
  const when = at ? `${dayLabel(first.date, day, he)} ב-${at}`.trim() : '';
  const said = he
    ? `נקבע: ${first.text}${when ? `, ${when}` : ''}`
    : `Set: ${first.text}${when ? `, ${when.replace('ב-', 'at ')}` : ''}`;
  const more = r.created.length > 1 ? (he ? ` ועוד ${r.created.length - 1}` : ` and ${r.created.length - 1} more`) : '';
  return `${said}${more}.${question ? ` ${question}` : ''}`;
}

function minutesBetween(a: string, b: string): number {
  const toM = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return toM(b) - toM(a);
}
