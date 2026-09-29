/**
 * taskRequirements — everything a task needs in order to actually HAPPEN,
 * derived from the task itself.
 *
 * Koral's standing rule, in her words: "גזור את כל המשימות שנלוות למשימה בכדי
 * לבצע אותה — התרעות חכמות, חישוב מסלול נסיעה, גזירת זמנים לאחור, התרעה
 * להתכונן לקראת, להיזכר מול מי הפגישה... תעשה שחלק מהדברים יהיו דטרמיניסטים:
 * אם יש מיקום אז תכנון נסיעה, אם זה פגישה או ראיון אז למידה לפני."
 *
 * WHY IT IS ONE TABLE AND NOT SEVEN SERVICES
 *
 * Every one of these consequences already existed, and each one lived
 * somewhere different with its own trigger: the route in ensureTravelChain,
 * the alerts in alertPlan, the wake time in alarmPlan, the prep days in
 * interviewPrep, the "who am I meeting" in MeetingBriefService. Nothing
 * anywhere could answer the only question that matters the night before —
 * **is this task ready to be done, and if not, what is missing?**
 *
 * That is why the same class of bug kept coming back. An interview with no
 * route and an interview with a route look identical to code that never asks.
 * A list of requirements, each either met or not, makes the gap a value you
 * can render, test and act on instead of an absence nobody computed.
 *
 * DETERMINISTIC ON PURPOSE
 *
 * No model, no network, no clock beyond `today`. The same task always yields
 * the same requirements, which is what lets this be unit-tested against the
 * real Ceva interview and what stops "smart" from meaning "different every
 * time she looks".
 *
 * Consumers: the day screen (what is missing), GoogleSync (what to go and
 * compute), and tests.
 */
import { Task, TaskCategory, AppLanguage } from '../types/index';
import { locOf, addrOf } from './dayPlanning';
import { isInterview } from './interviewPrep';
import { isRemoteTask } from './meetingLink';

/** The kinds of thing a task can need. */
export type RequirementKind =
  /** A start time. Without one, almost nothing else can be derived. */
  | 'time'
  /** Somewhere to be. Only for tasks whose kind implies going somewhere. */
  | 'place'
  /** A computed journey: leave-home time, vehicle, arrival. */
  | 'route'
  /** The hour to start getting ready, worked back from the journey. */
  | 'prep_window'
  /** Study blocks before an interview. */
  | 'study'
  /** Who she is meeting, recalled before she walks in. */
  | 'who'
  /** A reminder before it starts. */
  | 'reminder';

export interface Requirement {
  kind: RequirementKind;
  /** Met already, or still outstanding. */
  met: boolean;
  /**
   * Why this task needs it — the deterministic rule that fired, in words.
   * Kept because "you are missing a route" is not actionable and "this has an
   * address and an hour, so there is a journey to plan" is.
   */
  because: string;
  /** What would satisfy it, when she is the one who has to act. */
  action?: { he: string; en: string };
  /** True when Lumi can satisfy this itself and simply has not yet. */
  automatic: boolean;
}

/** Categories that mean being somewhere, in person, at an hour. */
const GOES_SOMEWHERE: TaskCategory[] = [
  'interview', 'doctor', 'conference', 'class', 'gym', 'hobby_class', 'meeting', 'course',
];

/** Categories where WHO it is with is part of being ready for it. */
const HAS_A_PERSON: TaskCategory[] = ['interview', 'meeting', 'call', 'zoom', 'doctor'];

export interface RequirementContext {
  /** YYYY-MM-DD. Used only to ignore what is already in the past. */
  today: string;
  /** Tasks that exist, so 'study' can be judged met by its generated ids. */
  existing?: Task[];
}

/**
 * Everything this task needs, and which of it is already there.
 *
 * Returns [] for a task in the past or already complete — a finished thing
 * needs nothing, and a requirement on a past task is a reproach, not a plan.
 */
export function requirementsFor(task: Task, ctx: RequirementContext): Requirement[] {
  if (!task || task.status === 'complete') return [];
  if (task.date && task.date < ctx.today) return [];

  const out: Requirement[] = [];
  const time = task.fixedTime || task.scheduledTime;
  const address = addrOf(task);
  const loc = locOf(task);
  const remote = isRemoteTask(task);
  const category = (task.category ?? 'general') as TaskCategory;

  // ── an hour ──────────────────────────────────────────────────────────────
  // First, because everything below is worked backwards from it. A task with a
  // place and no hour can never be routed, however long anyone waits.
  out.push({
    kind: 'time',
    met: Boolean(time),
    because: address
      ? 'it has a place to be, and a journey can only be worked back from an hour'
      : 'a task with no hour cannot be placed on the day',
    action: { he: 'קבעי שעה', en: 'Set a time' },
    automatic: false,
  });

  // ── somewhere to be ──────────────────────────────────────────────────────
  // Only where the KIND of thing implies it. A video call needs no address,
  // and asking for one is how a Zoom link ended up being geocoded.
  const needsPlace = !remote && GOES_SOMEWHERE.includes(category);
  if (needsPlace || address) {
    out.push({
      kind: 'place',
      met: Boolean(address),
      because: remote
        ? 'it is attended from anywhere'
        : `a ${category} is somewhere you have to be`,
      action: { he: 'הוסיפי כתובת', en: 'Add an address' },
      automatic: false,
    });
  }

  // ── the journey ──────────────────────────────────────────────────────────
  // THE deterministic rule she named: if there is a location, plan the trip.
  if (address && !remote) {
    const routed = Boolean(loc?.transitPlan || loc?.leaveHomeBy);
    out.push({
      kind: 'route',
      met: routed,
      because: 'it has an address, so there is a journey to plan',
      action: { he: 'חשבי מסלול', en: 'Work out the route' },
      // Lumi does this itself — it needs no decision from her, only an hour.
      automatic: Boolean(time),
    });

    // Working the times backwards is a SEPARATE requirement from the route,
    // because a route with no leave-home time is exactly what she was looking
    // at on Tuesday night: the address was on the card and the hour to walk
    // out was nowhere.
    out.push({
      kind: 'prep_window',
      met: Boolean(loc?.leaveHomeBy || loc?.wakeUpBy),
      because: 'knowing the journey is not knowing when to start getting ready',
      automatic: true,
    });
  }

  // ── study before ─────────────────────────────────────────────────────────
  // The other deterministic rule: an interview means preparing for it.
  if (isInterview(task)) {
    const ids = new Set((ctx.existing ?? []).map((t) => t.id));
    const hasPrep = [1, 2].some((d) => ids.has(`prep-${d}d-${task.id}`));
    out.push({
      kind: 'study',
      met: hasPrep,
      because: 'it is an interview, and an interview is prepared for',
      automatic: true,
    });
  }

  // ── who ──────────────────────────────────────────────────────────────────
  if (HAS_A_PERSON.includes(category)) {
    const who = task.contact?.name
      || (task.attendees && task.attendees.length > 0)
      || task.contactName;
    out.push({
      kind: 'who',
      met: Boolean(who),
      because: 'walking in knowing whose name it is, is part of being ready',
      action: { he: 'מי הפגישה?', en: 'Who is it with?' },
      automatic: false,
    });
  }

  // ── a reminder ───────────────────────────────────────────────────────────
  if (time) {
    out.push({
      kind: 'reminder',
      met: Boolean(task.notificationIds && task.notificationIds.length > 0),
      because: 'a plan that does not interrupt her is a plan she has to remember herself',
      automatic: true,
    });
  }

  return out;
}

/** The outstanding ones. */
export function missingRequirements(task: Task, ctx: RequirementContext): Requirement[] {
  return requirementsFor(task, ctx).filter((r) => !r.met);
}

/**
 * Is this task actually ready to be done?
 *
 * The question nothing in the app could answer before. "Ready" means every
 * derived requirement is met — not that the row exists.
 */
export function isReady(task: Task, ctx: RequirementContext): boolean {
  return missingRequirements(task, ctx).length === 0;
}

/**
 * The one thing most worth fixing first, or null when nothing is outstanding.
 *
 * Ordered by what blocks the most: without an hour nothing can be derived at
 * all; without a place there is no journey; and so on down. Showing her six
 * problems is showing her none.
 */
const BLOCKING_ORDER: RequirementKind[] = [
  'time', 'place', 'route', 'prep_window', 'study', 'who', 'reminder',
];

export function nextGap(task: Task, ctx: RequirementContext): Requirement | null {
  const missing = missingRequirements(task, ctx);
  if (!missing.length) return null;
  return [...missing].sort(
    (a, b) => BLOCKING_ORDER.indexOf(a.kind) - BLOCKING_ORDER.indexOf(b.kind),
  )[0];
}

const LABELS: Record<RequirementKind, { he: string; en: string }> = {
  time: { he: 'שעה', en: 'a time' },
  place: { he: 'מקום', en: 'a place' },
  route: { he: 'מסלול', en: 'a route' },
  prep_window: { he: 'שעת יציאה', en: 'a leave time' },
  study: { he: 'למידה לפני', en: 'study before' },
  who: { he: 'מול מי', en: 'who it is with' },
  reminder: { he: 'התראה', en: 'a reminder' },
};

/** One short line: what is missing, in her language. */
export function describeGap(req: Requirement, lang: AppLanguage): string {
  const he = lang === 'he';
  const label = he ? LABELS[req.kind].he : LABELS[req.kind].en;
  if (req.automatic) {
    return he ? `חסר ${label} — מחשבת` : `Missing ${label} — working it out`;
  }
  const action = he ? req.action?.he : req.action?.en;
  return action ?? (he ? `חסר ${label}` : `Missing ${label}`);
}
