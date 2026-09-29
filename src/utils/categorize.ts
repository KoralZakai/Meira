/**
 * categorize — a task's words → its category, priority and default length.
 *
 * The client port of `server/categorize.py`. Same table, same order, same
 * override words, so a task labelled on the server and the same task labelled
 * on the phone cannot disagree. Parity is asserted by
 * `tests/run-categorize-parity.ts`, which reads the Python table directly.
 *
 * WHY THIS EXISTS ON THE PHONE TOO
 *
 * The calendar import never labelled anything. It ran:
 *
 *     category: e.meetingUrl ? 'zoom' : 'meeting'
 *
 * — the title was not consulted at all. So "Your in-person interview with
 * Ceva" arrived as a generic `meeting` with `have_to` priority and a 45-minute
 * default, and everything keyed to `interview` never fired for it: the 🎯
 * badge, the `must` priority that puts it at the top of the day, the 90-minute
 * block, the longer notification lead, and the preparation days.
 *
 * Deciding that "ראיון" is an interview does not need a model. It needs a
 * list, and a list costs nothing, so it can run on EVERY imported event.
 */
import { TaskCategory, TaskPriority } from '../types/index';

/** Minutes a category takes when nothing has been learned yet. */
export const DEFAULT_DURATIONS: Record<TaskCategory, number> = {
  interview: 90, course: 60, conference: 120, class: 90, work: 60,
  meeting: 45, call: 15, doctor: 60, gym: 60, aspiration: 30,
  leisure: 60, general: 30, zoom: 45, hobby_class: 90,
};

/**
 * Order matters: the FIRST rule that matches wins, so the specific ones
 * ('interview') sit above the general ones ('meeting', 'work'). An interview
 * invitation says "interview" AND, further down, "meeting" — reordering this
 * table silently re-labels her calendar.
 */
const RULES: Array<[TaskCategory, string[], TaskPriority, number]> = [
  ['interview', ['interview', 'ראיון', 'ראיונות'], 'must', 90],
  ['doctor', ['doctor', 'dentist', 'clinic', 'medical', 'pharmacy',
    'רופא', 'רופאה', 'שיניים', 'מרפאה', 'תור לרופא', 'בדיקה'], 'must', 60],
  ['zoom', ['zoom', 'teams', 'google meet', 'video call', 'webinar',
    'זום', 'מיטס', 'וידאו'], 'have_to', 45],
  ['conference', ['conference', 'summit', 'convention', 'כנס', 'כנסים'], 'have_to', 120],
  ['gym', ['gym', 'workout', 'training', 'fitness', 'run', 'running',
    'yoga', 'pilates', 'swim', 'אימון', 'חדר כושר', 'כושר',
    'ריצה', 'יוגה', 'שחייה', 'פילאטיס', 'קיקבוקס'], 'need_to', 60],
  ['course', ['course', 'study', 'studying', 'lecture', 'homework',
    'exam', 'assignment', 'קורס', 'ללמוד', 'לימודים',
    'הרצאה', 'שיעורי בית', 'מבחן', 'תרגיל', 'הגשה'], 'have_to', 60],
  ['class', ['class', 'lesson', 'seminar', 'שיעור', 'סדנה'], 'have_to', 90],
  ['hobby_class', ['hobby', 'workshop', 'חוג', 'חוגים'], 'nice_to_do', 90],
  ['meeting', ['meeting', 'appointment', '1:1', 'standup', 'sync',
    'פגישה', 'פגישות', 'מפגש', 'תור'], 'have_to', 45],
  ['call', ['call', 'phone', 'ring', 'voicemail',
    'להתקשר', 'שיחה', 'טלפון', 'לחזור אליו', 'לחזור אליה'], 'need_to', 15],
  // Job hunting is work: "לשלוח קורות חיים ל-Checkpoint" matched nothing and
  // was filed under 💪 Gym on 22.9. Same words as server/categorize.py.
  ['work', ['work', 'office', 'project', 'deploy', 'shift', 'client',
    'cv', 'resume', 'job application', 'reserve duty', 'miluim',
    'עבודה', 'לעבוד', 'משרד', 'פרויקט', 'משמרת', 'לקוח',
    'קורות חיים', 'קו״ח', 'מועמדות', 'מילואים'], 'have_to', 60],
  ['leisure', ['movie', 'cinema', 'relax', 'party', 'dinner out', 'beach',
    'karaoke', 'concert',
    'סרט', 'קולנוע', 'מסיבה', 'לנוח', 'חוף', 'בילוי',
    'קריוקי', 'הופעה'], 'nice_to_do', 60],
  ['aspiration', ['goal', 'dream', 'someday', 'שאיפה', 'חלום', 'מתישהו'], 'nice_to_do', 30],
];

/** Preparing FOR an interview is study. Same pattern as categorize.py _STUDY_FOR. */
const STUDY_FOR_RE = /ללמוד|להתכונן|הכנה ל|לתרגל|study|prepare|prep for|practice/i;

/**
 * Categories a real conferencing link overrides.
 *
 * These describe WHO you are with, not WHAT it is: a meeting, a call, a work
 * block or an unlabelled event held over video is a video call, and treating
 * it as a place would have Lumi plan a bus and set an alarm for the sofa.
 * Everything NOT in this set — an interview, a doctor, a class, a conference —
 * keeps its own label, because those survive being held remotely.
 */
const GENERIC_WHEN_REMOTE = new Set<TaskCategory>(['meeting', 'call', 'work', 'general']);

/**
 * Categories that say WHO rather than WHAT, and so lose to a better signal.
 *
 * A title of "Meeting" or "Ceva — Dana" tells us almost nothing. When the
 * body says "An in-person interview has been scheduled for you", the body is
 * right and the title is noise. Only these weak labels step aside; a title
 * that already said "interview" or "doctor" is not overruled by prose.
 */
const WEAK = new Set<TaskCategory>(['meeting', 'call', 'work', 'general']);

/**
 * Applicant-tracking systems. An invitation whose ORGANISER is one of these
 * is a recruiting appointment — that is the only thing they send calendar
 * invites for.
 *
 * The Ceva invitation came from `scheduler@comeet-notifications.com`, which is
 * nearly proof on its own, and was the one signal in the payload that needed
 * no language understanding at all. It was not read.
 */
const RECRUITING_HOSTS = [
  'comeet-notifications.com', 'comeet.co', 'comeet.com',
  'greenhouse.io', 'sparkhire.com', 'lever.co', 'hire.lever.co',
  'workable.com', 'smartrecruiters.com', 'myworkday.com', 'workday.com',
  'ashbyhq.com', 'teamtailor.com', 'recruitee.com', 'breezy.hr',
  'jobvite.com', 'icims.com', 'taleo.net', 'hire.google.com',
  'goodtime.io', 'modernloop.io',
];

/** Is this invitation from an applicant-tracking system? */
export function isRecruitingOrganizer(organizer?: string | null): boolean {
  const at = String(organizer || '').toLowerCase();
  if (!at.includes('@')) return false;
  const domain = at.split('@').pop() as string;
  return RECRUITING_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`));
}

/**
 * How much of a description is worth reading.
 *
 * The signal in an invitation body is at the top — "An in-person interview has
 * been scheduled for you" is within the first 300 characters of the Ceva one.
 * What is at the BOTTOM is unsubscribe text, legal boilerplate and quoted
 * email threads, all of which are someone else's words and none of which
 * describe this appointment. Reading the whole blob is how a footer decides
 * what her morning is.
 */
const DESCRIPTION_SCAN_CHARS = 1500;

/** Urgency she stated out loud, which overrides the rule's own priority. */
const MUST_RE = /urgent|asap|critical|must|deadline|due today|דחוף|חייב|חייבת|קריטי|היום חייב|דדליין/i;
const NICE_RE = /maybe|if i have time|whenever|sometime|nice to|אולי|אם יהיה זמן|מתישהו|לא דחוף|בכיף/i;

export interface Inferred {
  category: TaskCategory;
  priority: TaskPriority;
  durationMinutes: number;
  /** False when nothing in the table fired — the caller's own guess may be better. */
  matched: boolean;
}

/**
 * Label one task from its words alone. No I/O, no model, no network.
 *
 * `learned` is LearningService's rolling per-category average; it wins over
 * the static default once it exists, because how long SHE takes beats how long
 * the table thinks anyone takes.
 */
export function inferFromText(
  text: string,
  learned?: Partial<Record<TaskCategory, number>>,
): Inferred {
  // A phone keyboard types קו"ח with an ASCII quote; the table spells it ״.
  const lowered = (text || '').toLowerCase().replace(/"/g, '״');
  let category: TaskCategory = 'general';
  let priority: TaskPriority = 'need_to';
  let durationMinutes = 30;
  let matched = false;

  for (const [cat, keywords, pri, dur] of RULES) {
    if (keywords.some((kw) => lowered.includes(kw))) {
      category = cat; priority = pri; durationMinutes = dur; matched = true;
      break;
    }
  }
  // "ללמוד לראיון עבודה" is studying, not the interview — it was filed as 🎯
  // interview / must and spawned prep blocks of its own. Mirrors categorize.py.
  if (category === 'interview' && STUDY_FOR_RE.test(lowered)) {
    category = 'course'; priority = 'have_to'; durationMinutes = 60;
  }

  if (MUST_RE.test(lowered)) priority = 'must';
  else if (NICE_RE.test(lowered) && priority !== 'must') priority = 'nice_to_do';

  const learnedMinutes = learned?.[category];
  if (Number.isFinite(learnedMinutes as number) && (learnedMinutes as number) > 0) {
    durationMinutes = Math.round(learnedMinutes as number);
  }

  return { category, priority, durationMinutes, matched };
}

/** Everything about an event that says what KIND of thing it is. */
export interface EventSignals {
  title: string;
  /** The invitation body. Only its opening is read — see DESCRIPTION_SCAN_CHARS. */
  description?: string | null;
  /** Who sent the invite. An applicant-tracking system is decisive. */
  organizer?: string | null;
  /** True only for a REAL conferencing host — see meetingUrlFromEvent. */
  hasMeetingUrl?: boolean;
}

/**
 * What kind of thing a calendar event is.
 *
 * WHY IT READS MORE THAN THE TITLE
 *
 * It used to read only the title, and the title is the one field nobody
 * controls. "Your in-person interview with Ceva" happened to contain the word;
 * an invitation titled "Ceva — Dana Levi" would have been missed
 * completely, while its body said "An in-person interview has been scheduled
 * for you" and its organiser was `scheduler@comeet-notifications.com`. Both
 * signals were sitting in the payload, unread.
 *
 * The order is by how much each signal can be trusted:
 *
 *   1. A SPECIFIC title       — she wrote it, or the organiser meant it.
 *   2. A SPECIFIC body        — the invitation says what it is, in prose.
 *   3. A recruiting organiser — an ATS sends invites for one reason only.
 *   4. A weak title           — "meeting", "call", "work": better than nothing.
 *   5. A real video link      — attended from anywhere.
 *   6. `meeting`              — the honest shrug.
 *
 * Steps 1 and 2 are the same keyword table, so this is still a lookup and not
 * a model call: the calendar stays on the phone, and this runs on every event
 * because it costs nothing.
 */
export function categoryForCalendarEvent(
  signals: EventSignals | string,
  hasMeetingUrlLegacy?: boolean,
  learned?: Partial<Record<TaskCategory, number>>,
): Inferred {
  // Called with a bare title by older call sites and by tests.
  const ev: EventSignals = typeof signals === 'string'
    ? { title: signals, hasMeetingUrl: hasMeetingUrlLegacy }
    : signals;
  const hasMeetingUrl = Boolean(ev.hasMeetingUrl);

  // 1. A specific title wins outright. An interview held over video is still
  //    an interview — it still deserves the 🎯, the `must` and the prep days.
  const fromTitle = inferFromText(ev.title, learned);
  if (fromTitle.matched && !WEAK.has(fromTitle.category)) return fromTitle;

  // 2. The body, but only its opening: the bottom of an invitation is
  //    unsubscribe text and quoted threads, which describe nobody's morning.
  const body = String(ev.description ?? '').slice(0, DESCRIPTION_SCAN_CHARS);
  if (body) {
    const fromBody = inferFromText(body, learned);
    if (fromBody.matched && !WEAK.has(fromBody.category)) return fromBody;
  }

  // 3. Who sent it. An applicant-tracking system books one kind of thing.
  if (isRecruitingOrganizer(ev.organizer)) {
    return {
      category: 'interview',
      priority: 'must',
      durationMinutes: learned?.interview ?? DEFAULT_DURATIONS.interview,
      matched: true,
    };
  }

  // 4. A weak title is still a label — unless it is held over video, in which
  //    case "weekly sync" is just a video call and planning a journey to it
  //    would be wrong. "Call Dana" with no link stays a 15-minute `call`.
  if (fromTitle.matched && !(hasMeetingUrl && GENERIC_WHEN_REMOTE.has(fromTitle.category))) {
    return fromTitle;
  }

  // 5 & 6.
  if (hasMeetingUrl) {
    return {
      category: 'zoom',
      priority: 'have_to',
      durationMinutes: learned?.zoom ?? DEFAULT_DURATIONS.zoom,
      matched: false,
    };
  }
  return {
    category: 'meeting',
    priority: 'have_to',
    durationMinutes: learned?.meeting ?? DEFAULT_DURATIONS.meeting,
    matched: false,
  };
}
