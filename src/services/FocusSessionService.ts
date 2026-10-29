/**
 * FocusSessionService — the learning-session blocker, from the app's side.
 *
 * Koral, 17.10: a session where she defines a learning time and cannot enter WhatsApp, Instagram
 * or any app she decides to block. Starts BOTH on its own at a study task's hour AND by hand
 * ("Start learning"), ends early only after a visible 10-second wait.
 *
 * WHAT RUNS THIS, AND WHEN (rule 7 — a capability with no trigger is not a feature):
 *
 *   automatic start  an AlarmManager alarm per study task, set by `scheduleStudySessions`, which
 *                    CalendarAutoSync.runCalendarSync calls on EVERY sync path: app launch, every
 *                    return to the foreground, the 10-minute heartbeat, pull-to-refresh and the
 *                    closed-app WorkManager job (~15 min). The alarm itself needs no JS.
 *   by hand          "Start learning" on FocusNowScreen and in the Menu's chooser sheet.
 *   she went looking Menu › Helpers › "Learning sessions — blocked apps".
 *
 * EVERY FAILURE SAYS WHY (rule 3). A start that cannot block is refused with a typed reason and
 * `failureText` words that name the fix ("Usage access is off", with the button to switch it on) —
 * it is never a session that quietly blocks nothing.
 *
 * The Kotlin lives in modules/focus-guard; the pure rules in utils/focusSession.ts.
 */
import AsyncStorage from './EncryptedStorage';
import { FocusGuard, type FocusFailReason, type SessionSnapshot } from '../../modules/focus-guard';
import { sendImmediate } from './NotificationService';
import {
  DEFAULT_SESSION_MINUTES, MAX_SESSION_MINUTES, MIN_SESSION_MINUTES, appOf, failureText, focusStrings,
  joinNames, namesOf, normaliseChoice, packagesFor, planDiff, plannedStudySessions,
  type FailureText, type PermissionFix,
} from '../utils/focusSession';
import type { AppLanguage, Task } from '../types/index';

const CHOICE_KEY = 'meira.focus.apps.v1';
const SETUP_ASKED_KEY = 'meira.focus.setup.asked.v1';
const SETUP_PENDING_KEY = 'meira.focus.setup.pending.v1';
/** She read the prominent disclosure (utils/focusSession `focusDisclosure`) and tapped on. */
const DISCLOSURE_KEY = 'meira.focus.disclosure.v1';

/** After a setup nudge, wait this long before the next one. */
const SETUP_NUDGE_EVERY_MS = 3 * 24 * 3_600_000;

// ── Her choice of apps ──────────────────────────────────────────────────────

/** The apps she blocks while learning. Never chosen: the presets (Instagram, WhatsApp, TikTok). */
export async function loadChoice(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(CHOICE_KEY);
    return normaliseChoice(raw == null ? undefined : JSON.parse(raw));
  } catch (e) {
    console.warn('[Focus] saved app choice unreadable, using the presets', e);
    return normaliseChoice(undefined);
  }
}

export async function saveChoice(ids: string[]): Promise<void> {
  const clean = normaliseChoice(ids);
  await AsyncStorage.setItem(CHOICE_KEY, JSON.stringify(clean));
}

// ── Permissions ─────────────────────────────────────────────────────────────

export interface Readiness {
  /** The native module is in this build at all. */
  native: boolean;
  usageAccess: boolean;
  overlay: boolean;
  notifications: boolean;
  /** Blocking can work: native present and both special accesses on. */
  ready: boolean;
  missing: Array<'usage' | 'overlay'>;
  reason?: FocusFailReason;
}

/** Synchronous and cheap: call it on mount and again whenever the app returns to the front. */
export function getReadiness(): Readiness {
  const p = FocusGuard.permissions();
  const missing: Array<'usage' | 'overlay'> = [];
  if (p.native && !p.usageAccess) missing.push('usage');
  if (p.native && !p.overlay) missing.push('overlay');
  return {
    native: p.native,
    usageAccess: p.usageAccess,
    overlay: p.overlay,
    notifications: p.notifications,
    ready: p.native && missing.length === 0,
    missing,
    reason: p.reason,
  };
}

// ── The prominent disclosure (Play) ─────────────────────────────────────────

let disclosureSeen = false;

/** True once she has read the disclosure and tapped on. Unreadable storage counts as "not yet". */
export async function disclosureAccepted(): Promise<boolean> {
  if (disclosureSeen) return true;
  try {
    disclosureSeen = Boolean(await AsyncStorage.getItem(DISCLOSURE_KEY));
  } catch (e) {
    console.warn('[Focus] disclosure flag unreadable — showing it again', e);
  }
  return disclosureSeen;
}

/** She tapped "Got it". Held in memory even if the write fails, so she is not asked twice now. */
export async function acceptDisclosure(now = Date.now()): Promise<void> {
  disclosureSeen = true;
  try {
    await AsyncStorage.setItem(DISCLOSURE_KEY, String(now));
  } catch (e) {
    console.warn('[Focus] could not remember the disclosure — it will show again next launch', e);
  }
}

/**
 * Opens the Settings page for one permission. The failure, if any, is returned — not swallowed.
 *
 * Refuses with `disclosure_needed` until she has read the disclosure: Play requires it BEFORE the
 * request, and checking here means no caller can open Settings without it.
 */
export async function requestPermission(
  which: 'usage' | 'overlay', lang: AppLanguage = 'en',
): Promise<{ ok: true } | { ok: false; failure: FailureText; reason: string }> {
  if (!(await disclosureAccepted())) {
    return { ok: false, reason: 'disclosure_needed', failure: failureText('disclosure_needed', lang) };
  }
  const r = which === 'usage' ? FocusGuard.openUsageAccessSettings() : FocusGuard.openOverlaySettings();
  if (r.ok) return { ok: true };
  console.warn('[Focus] could not open the permission page', which, r.reason);
  return { ok: false, reason: r.reason, failure: failureText(r.reason, lang) };
}

/** Which of the catalogue's apps are installed. `installed: null` means it could not be asked. */
export function installedAppIds(ids: string[]): { installed: string[] | null; reason?: string } {
  const packages = ids.flatMap((id) => appOf(id)?.packages ?? []);
  const r = FocusGuard.installedPackages(packages);
  if (!r.ok) return { installed: null, reason: r.reason };
  return {
    installed: ids.filter((id) => (appOf(id)?.packages ?? []).some((p) => r.installed.includes(p))),
  };
}

// ── Starting and stopping ───────────────────────────────────────────────────

export type StartOutcome =
  | { ok: true; id: string; endsAtMs: number }
  | { ok: false; reason: string; failure: FailureText; fix: PermissionFix };

function refuse(reason: string, lang: AppLanguage): StartOutcome {
  const failure = failureText(reason, lang);
  return { ok: false, reason, failure, fix: failure.fix };
}

/** The permission that is missing, as a typed reason — before the native side has to say so. */
function gate(): FocusFailReason | null {
  const r = getReadiness();
  if (!r.native) return 'native_unavailable';
  if (!r.usageAccess) return 'no_usage_access';
  if (!r.overlay) return 'no_overlay';
  return null;
}

/**
 * Start blocking now, for `minutes` (or until `endsAtMs`). `ids` defaults to her saved choice;
 * `packages` overrides it (resuming a session keeps exactly the list it had).
 */
export async function startLearning(opts: {
  minutes?: number;
  endsAtMs?: number;
  title?: string;
  taskId?: string | null;
  lang: AppLanguage;
  ids?: string[];
  packages?: string[];
  sessionId?: string | null;
  now?: number;
}): Promise<StartOutcome> {
  const now = opts.now ?? Date.now();
  const blocked = opts.packages ?? packagesFor(opts.ids ?? await loadChoice());
  if (!blocked.length) return refuse('nothing_to_block', opts.lang);
  const blockedReason = gate();
  if (blockedReason) return refuse(blockedReason, opts.lang);

  const minutes = Math.max(MIN_SESSION_MINUTES, Math.min(MAX_SESSION_MINUTES, Math.round(opts.minutes ?? DEFAULT_SESSION_MINUTES)));
  const endsAtMs = opts.endsAtMs ?? now + minutes * 60_000;
  const r = FocusGuard.startSession({
    endsAtMs, blocked, title: opts.title ?? '', lang: opts.lang,
    taskId: opts.taskId ?? null, sessionId: opts.sessionId ?? null,
  });
  if (!r.ok) {
    console.warn('[Focus] start refused:', r.reason);
    return refuse(r.reason, opts.lang);
  }
  return { ok: true, id: r.id, endsAtMs: r.endsAtMs };
}

export interface RunningView {
  session: SessionSnapshot;
  minutesLeft: number;
  /** Switched off while running: the block is NOT working right now. */
  warn: 'usage' | 'overlay' | 'block_failed' | null;
  /** The service had stopped and was just restarted by looking at it. */
  restarted: boolean;
}

/**
 * The session running right now, or null when there is none — and an error when it could not be
 * asked (the caller must not draw "no session" for "I could not tell").
 */
export function getRunning(now = Date.now()): { running: RunningView | null; error?: string } {
  let info = FocusGuard.getSession();
  if (!info.ok) return { running: null, error: info.reason === 'native_unavailable' ? undefined : info.reason };
  let restarted = false;
  if (info.active && info.session && info.serviceRunning === false) {
    // A session inside its window that nothing is running: put it back (the gap is recorded
    // natively as service_killed, and the lecture picks it up).
    const rec = FocusGuard.reconcile();
    if (!rec.ok) console.warn('[Focus] could not resume a stopped session:', rec.reason);
    else if (rec.error) console.warn('[Focus] resume refused:', rec.error);
    restarted = rec.ok && !rec.error;
    info = FocusGuard.getSession();
    if (!info.ok) return { running: null, error: info.reason };
  }
  if (!info.active || !info.session) return { running: null };
  return {
    running: {
      session: info.session,
      minutesLeft: Math.max(0, Math.ceil((info.session.endsAtMs - now) / 60_000)),
      warn: info.warn ?? null,
      restarted,
    },
  };
}

/** The user has waited the 10 seconds: end the session. Recorded as ended_early. */
export function endEarly(): { ok: true } | { ok: false; reason: string } {
  const r = FocusGuard.endSessionEarly();
  if (!r.ok) console.warn('[Focus] end early failed:', r.reason);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

// ── Study tasks → alarms ────────────────────────────────────────────────────

export interface ScheduleReport {
  /** 'ok' = in step; the others say why nothing was (or could be) done. */
  state: 'ok' | 'unavailable' | 'needs_permission' | 'failed';
  planned: number;
  scheduled: number;
  cancelled: number;
  unchanged: number;
  missing?: Array<'usage' | 'overlay'>;
  errors: Array<{ id: string; reason: string }>;
}

/**
 * Put the alarms in step with the schedule: one per study task of today and tomorrow, those that
 * were moved or done cancelled. Idempotent — the same task and the same sig is a no-op, so every
 * calendar sync can call it.
 *
 * Without the two permissions nothing is scheduled (a session that cannot block would only report
 * "you turned the block off" to someone who never turned it on). Instead, when there IS a study
 * task and the answer would have been yes, she is told once every few days.
 */
export async function scheduleStudySessions(
  tasks: Task[], lang: AppLanguage, now = Date.now(),
): Promise<ScheduleReport> {
  const report: ScheduleReport = { state: 'ok', planned: 0, scheduled: 0, cancelled: 0, unchanged: 0, errors: [] };
  const readiness = getReadiness();
  if (!readiness.native) return { ...report, state: 'unavailable' };

  const ids = await loadChoice();
  const planned = plannedStudySessions(tasks, now, ids, lang);
  report.planned = planned.length;

  const existing = FocusGuard.listScheduled();
  if (!existing.ok) {
    console.warn('[Focus] could not read the scheduled sessions:', existing.reason);
    return { ...report, state: 'failed', errors: [{ id: '*', reason: existing.reason }] };
  }
  const { toSchedule, toCancel } = planDiff(planned, existing.entries);

  for (const id of toCancel) {
    const c = FocusGuard.cancelScheduled(id);
    if (c.ok) report.cancelled += 1;
    else report.errors.push({ id, reason: c.reason });
  }

  if (!readiness.ready) {
    if (planned.length) await nudgeSetup(planned.length, now, lang);
    return { ...report, state: 'needs_permission', missing: readiness.missing };
  }

  for (const p of toSchedule) {
    const r = FocusGuard.scheduleSession({
      id: p.id, startAtMs: p.startAtMs, endsAtMs: p.endsAtMs, blocked: p.blocked, title: p.title,
      lang, startTitle: p.startTitle, startBody: p.startBody, sig: p.sig, taskId: p.taskIds[0] ?? null,
    });
    if (r.ok) report.scheduled += 1;
    else {
      console.warn('[Focus] could not schedule', p.id, r.reason);
      report.errors.push({ id: p.id, reason: r.reason });
    }
  }
  report.unchanged = planned.length - toSchedule.length;
  if (report.errors.length) report.state = 'failed';
  return report;
}

/**
 * A scheduled session whose alarm fired but whose service Android would not start: since
 * Android 12 a foreground service may not be started from the background, and an inexact alarm
 * (no exact-alarm permission) is not an exemption. The native side wrote the typed reason onto the
 * entry and posted "tap to start". Now that the app is open — the one moment Android allows it —
 * start the session for the rest of its window, so the failure costs her minutes, not the session.
 */
export async function recoverFailedStarts(
  lang: AppLanguage, now = Date.now(),
): Promise<{ started: number; errors: string[] }> {
  const out = { started: 0, errors: [] as string[] };
  const list = FocusGuard.listScheduled();
  if (!list.ok) {
    if (list.reason !== 'native_unavailable') out.errors.push(list.reason);
    return out;
  }
  for (const e of list.entries) {
    if (!e.fired || !e.error || !e.error.startsWith('service_start_refused')) continue;
    if (e.endsAtMs - now < MIN_SESSION_MINUTES * 60_000) continue;
    const r = await startLearning({
      endsAtMs: e.endsAtMs, title: e.title, taskId: e.taskId ?? null, lang,
      packages: e.blocked, sessionId: e.id, now,
    });
    if (r.ok) {
      out.started += 1;
      // Dealt with; drop the failure record (the window is open, so a re-plan cannot restart it).
      FocusGuard.cancelScheduled(e.id);
    } else {
      console.warn('[Focus] could not recover the session that failed to start:', e.id, r.reason);
      out.errors.push(`${e.id}:${r.reason}`);
    }
  }
  return out;
}

/**
 * A study task is on her schedule but blocking is not set up. Say so, once per few days, with a
 * notification — and arm the sheet to open the next time she opens Meira.
 */
async function nudgeSetup(count: number, now: number, lang: AppLanguage): Promise<void> {
  try {
    const last = Number(await AsyncStorage.getItem(SETUP_ASKED_KEY)) || 0;
    if (now - last < SETUP_NUDGE_EVERY_MS) return;
    await AsyncStorage.setItem(SETUP_ASKED_KEY, String(now));
    await AsyncStorage.setItem(SETUP_PENDING_KEY, String(now));
    const he = lang === 'he';
    await sendImmediate(
      he ? '📚 משימת לימוד בלוח' : '📚 A study task is coming up',
      he
        ? 'כדי שאחסום לך אינסטגרם ווואטסאפ בזמן הלימוד, צריך לאשר שתי הרשאות. הקישי כאן.'
        : 'To block Instagram and WhatsApp while you study, two permissions are needed. Tap here.',
      { type: 'focus_setup', count },
    );
  } catch (e) {
    console.warn('[Focus] setup nudge failed', e);
  }
}

/** True once after a setup nudge: the host opens the chooser sheet, then it is cleared. */
export async function takeSetupPrompt(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(SETUP_PENDING_KEY);
    if (!v) return false;
    await AsyncStorage.removeItem(SETUP_PENDING_KEY);
    return true;
  } catch (e) {
    console.warn('[Focus] setup prompt unreadable', e);
    return false;
  }
}

/** One line for the Menu row: "Instagram, WhatsApp and TikTok · ready". */
export async function menuLine(lang: AppLanguage): Promise<string> {
  const ids = await loadChoice();
  const names = ids.length ? joinNames(namesOf(ids, lang), lang) : focusStrings(lang).pickOne;
  const r = getReadiness();
  if (!r.native) return lang === 'he' ? `${names} · לא זמין בגרסה הזו` : `${names} · not in this build`;
  return focusStrings(lang).menuLine(names, r.ready);
}
