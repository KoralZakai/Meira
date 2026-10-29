/**
 * focusSession — the rules of a learning session, with no phone in them.
 *
 * Koral, 17.10: "a session where the user defines a learning time and cannot enter WhatsApp,
 * Instagram or any social app she decides to block while learning."
 *
 * WHAT IS DECIDED HERE (pure, so tests/run-focus-session.ts drives every branch):
 *   - which tasks are study sessions (`isLearningTask`: a study task, or a prep block for an
 *     interview) and the window each one occupies;
 *   - which apps can be blocked, which preset is on by default, which can NEVER be blocked;
 *   - what to schedule, what to cancel (idempotent — calendar sync calls this every run);
 *   - the words, in both languages, including why a start failed and which switch fixes it.
 *
 * WHAT IS NOT: starting a service, an alarm, a permission page. That is
 * services/FocusSessionService.ts over modules/focus-guard (Kotlin).
 *
 * The 10-second rule lives in two places that must agree: END_EARLY_SECONDS here (the sheet) and
 * END_EARLY_COUNTDOWN_SECONDS in FocusBlockActivity.kt (the block screen). The test reads both.
 */
import type { AppLanguage, Task } from '../types/index';
import { isStudyTask } from './taskShape';
import { isPrepBlock } from './interviewPrep';
import { timeToMinutes } from './timeUtils';

// ── The numbers ─────────────────────────────────────────────────────────────

/** The visible wait before a session can be ended early. */
export const END_EARLY_SECONDS = 10;
/** A session shorter than this is not worth the machinery. */
export const MIN_SESSION_MINUTES = 5;
/**
 * A study task longer than this is still blocked only for this long. A mis-estimated task
 * ("study" for 9 hours) must not lock WhatsApp for a whole day.
 */
export const MAX_SESSION_MINUTES = 240;
export const DEFAULT_SESSION_MINUTES = 45;
/**
 * How late an automatic start may be. A sync that runs at 10:07 for a 10:00 study block still
 * starts it; at 10:40 it does not (she can press Start). Without a bound, opening the app at the
 * end of a block would start a session with five minutes in it.
 */
export const START_GRACE_MINUTES = 10;

// ── The apps ────────────────────────────────────────────────────────────────

export interface FocusApp {
  id: string;
  /** Android package names; TikTok ships under two. */
  packages: string[];
  en: string;
  he: string;
  /** "in Instagram" — the Hebrew locative, for "12 דק׳ באינסטגרם". */
  heIn: string;
  /** On by default. */
  preset: boolean;
}

export const FOCUS_APPS: FocusApp[] = [
  { id: 'instagram', packages: ['com.instagram.android'], en: 'Instagram', he: 'אינסטגרם', heIn: 'באינסטגרם', preset: true },
  { id: 'whatsapp', packages: ['com.whatsapp'], en: 'WhatsApp', he: 'וואטסאפ', heIn: 'בוואטסאפ', preset: true },
  { id: 'tiktok', packages: ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'], en: 'TikTok', he: 'טיקטוק', heIn: 'בטיקטוק', preset: true },
  { id: 'youtube', packages: ['com.google.android.youtube'], en: 'YouTube', he: 'יוטיוב', heIn: 'ביוטיוב', preset: false },
  { id: 'facebook', packages: ['com.facebook.katana'], en: 'Facebook', he: 'פייסבוק', heIn: 'בפייסבוק', preset: false },
  { id: 'x', packages: ['com.twitter.android'], en: 'X', he: 'X', heIn: 'ב-X', preset: false },
  { id: 'telegram', packages: ['org.telegram.messenger'], en: 'Telegram', he: 'טלגרם', heIn: 'בטלגרם', preset: false },
  { id: 'snapchat', packages: ['com.snapchat.android'], en: 'Snapchat', he: "סנאפצ'אט", heIn: "בסנאפצ'אט", preset: false },
  { id: 'whatsapp_business', packages: ['com.whatsapp.w4b'], en: 'WhatsApp Business', he: 'וואטסאפ ביזנס', heIn: 'בוואטסאפ ביזנס', preset: false },
];

/** What is blocked until she changes it: the three presets. */
export const DEFAULT_APP_IDS: string[] = FOCUS_APPS.filter((a) => a.preset).map((a) => a.id);

/**
 * Never blocked, whatever list reaches the native side: the phone dialer and the emergency screens,
 * system UI and Settings (she must always be able to switch the block off there), Meira herself.
 * FocusService.NEVER_BLOCK (Kotlin) says the same; tests/run-focus-session.ts compares them.
 */
export const NEVER_BLOCK_PACKAGES: string[] = [
  'com.android.dialer', 'com.google.android.dialer', 'com.samsung.android.dialer',
  'com.android.phone', 'com.android.server.telecom', 'com.android.emergency',
  'com.android.systemui', 'com.android.settings', 'com.google.android.apps.safetyhub',
  'com.android.incallui', 'com.samsung.android.incallui',
  'meira.secretary',
];

const BY_ID = new Map(FOCUS_APPS.map((a) => [a.id, a]));

/**
 * Her saved choice → a clean list of known ids. `undefined` (never chosen) is the presets;
 * an empty array is a real choice ("block nothing") and stays empty — the UI then asks for one.
 */
export function normaliseChoice(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [...DEFAULT_APP_IDS];
  const out: string[] = [];
  for (const v of saved) {
    if (typeof v === 'string' && BY_ID.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Android package names for a choice, without anything that must never be blocked. */
export function packagesFor(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    for (const p of BY_ID.get(id)?.packages ?? []) {
      if (!NEVER_BLOCK_PACKAGES.includes(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

export function appOf(id: string): FocusApp | undefined {
  return BY_ID.get(id);
}

/** The app a package belongs to, or undefined (browsers, anything not in the catalogue). */
export function appOfPackage(pkg: string): FocusApp | undefined {
  return FOCUS_APPS.find((a) => a.packages.includes(pkg));
}

export const appName = (a: FocusApp, lang: AppLanguage): string => (lang === 'he' ? a.he : a.en);

/** "אינסטגרם, וואטסאפ וטיקטוק" / "Instagram, WhatsApp and TikTok" — at most three, then "+N". */
export function joinNames(names: string[], lang: AppLanguage): string {
  const he = lang === 'he';
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  if (shown.length === 0) return '';
  if (shown.length === 1 && extra === 0) return shown[0];
  const last = shown[shown.length - 1];
  const head = shown.slice(0, -1);
  // Hebrew "and" is a prefix: וטיקטוק. Before a vowel-letter ו or a Latin name it takes a hyphen.
  const and = he ? (/^[ו\w]/.test(last) ? 'ו-' : 'ו') : ' and ';
  if (extra > 0) {
    const tail = he ? `ועוד ${extra}` : `and ${extra} more`;
    return `${shown.join(', ')} ${tail}`;
  }
  return he ? `${head.join(', ')} ${and}${last}` : `${head.join(', ')}${and}${last}`;
}

export function namesOf(ids: string[], lang: AppLanguage): string[] {
  return ids.map((id) => BY_ID.get(id)).filter((a): a is FocusApp => Boolean(a)).map((a) => appName(a, lang));
}

// ── Which tasks are study sessions, and when ───────────────────────────────

/**
 * A study session: the task is a study task ("study for…", "ללמוד…", homework) or the preparation
 * for an interview ("Prep for…", "Final review for…", "Morning study for…") — and still to do.
 */
export function isLearningTask(task: Task): boolean {
  if (task.status && task.status !== 'pending' && task.status !== 'partial') return false;
  return isStudyTask(task) || isPrepBlock(task);
}

const HHMM = /^\d{1,2}:\d{2}$/;

/** YYYY-MM-DD in the phone's local calendar. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** HH:MM in the phone's local clock. */
export function hhmmOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A local date + HH:MM as epoch milliseconds; null when either is malformed. */
export function parseLocalMs(date: string, hhmm: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !HHMM.test(hhmm)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  if (h > 23 || mi > 59) return null;
  return new Date(y, m - 1, d, h, mi, 0, 0).getTime();
}

export interface SessionWindow { startAtMs: number; endsAtMs: number; minutes: number }

/**
 * The window a study task occupies: its hour, for its length. A from→to range (`endTime`) wins
 * over the estimate; the length is clamped to MIN..MAX so a typo cannot blank her phone for a day.
 * null when the task has no usable hour.
 */
export function sessionWindow(task: Task): SessionWindow | null {
  const at = task.fixedTime || task.scheduledTime;
  if (!at || !HHMM.test(at)) return null;
  const startAtMs = parseLocalMs(task.date, at);
  if (startAtMs === null) return null;
  let minutes = task.durationMinutes > 0 ? task.durationMinutes : DEFAULT_SESSION_MINUTES;
  if (task.endTime && HHMM.test(task.endTime)) {
    const span = timeToMinutes(task.endTime) - timeToMinutes(at);
    if (span > 0) minutes = span;
  }
  minutes = Math.max(MIN_SESSION_MINUTES, Math.min(MAX_SESSION_MINUTES, Math.round(minutes)));
  return { startAtMs, endsAtMs: startAtMs + minutes * 60_000, minutes };
}

/** A short title for the session: the task's own words. */
export function sessionTitleFor(task: Task): string {
  const t = (task.text || '').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

// ── What to schedule ────────────────────────────────────────────────────────

export interface PlannedSession {
  /** `study-<task id>` — stable, so the same task is the same alarm on every sync. */
  id: string;
  taskIds: string[];
  title: string;
  startAtMs: number;
  endsAtMs: number;
  minutes: number;
  /** Android package names. */
  blocked: string[];
  /** Fingerprint of everything that makes this session what it is. */
  sig: string;
  startTitle: string;
  startBody: string;
  /** The hour has just passed (inside the grace): start now instead of waiting for an alarm. */
  startNow: boolean;
}

/** djb2 → base36. Short and stable; it only has to tell "changed" from "same". */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function sessionSig(p: { startAtMs: number; endsAtMs: number; blocked: string[]; title: string; lang: AppLanguage }): string {
  return shortHash([p.startAtMs, p.endsAtMs, [...p.blocked].sort().join(','), p.title, p.lang].join('|'));
}

/** "📚 מתחילים ללמוד" + "חסמתי את אינסטגרם, וואטסאפ וטיקטוק · עד 19:45". */
export function startNotice(ids: string[], endsAtMs: number, lang: AppLanguage): { title: string; body: string } {
  const names = joinNames(namesOf(ids, lang), lang);
  const until = hhmmOf(endsAtMs);
  return lang === 'he'
    ? { title: '📚 מתחילים ללמוד', body: `חסמתי את ${names} · עד ${until}` }
    : { title: '📚 Study time', body: `I blocked ${names} · until ${until}` };
}

/**
 * The study sessions to have scheduled, from today's and tomorrow's tasks.
 *
 * Two study tasks that overlap become ONE session (the later end wins) — a service can only block
 * one window at a time. A task whose start is more than the grace behind `nowMs`, or whose window
 * is over, is not planned.
 */
export function plannedStudySessions(
  tasks: Task[], nowMs: number, ids: string[], lang: AppLanguage,
): PlannedSession[] {
  const blocked = packagesFor(ids);
  if (!blocked.length) return [];
  const days = [localDateKey(nowMs), localDateKey(nowMs + 24 * 3_600_000)];
  const graceMs = START_GRACE_MINUTES * 60_000;

  const wins: Array<{ task: Task; w: SessionWindow }> = [];
  for (const task of tasks) {
    if (!days.includes(task.date) || !isLearningTask(task)) continue;
    const w = sessionWindow(task);
    if (!w || w.endsAtMs <= nowMs || nowMs > w.startAtMs + graceMs) continue;
    wins.push({ task, w });
  }
  wins.sort((a, b) => a.w.startAtMs - b.w.startAtMs || a.task.id.localeCompare(b.task.id));

  const merged: Array<{ ids: string[]; title: string; startAtMs: number; endsAtMs: number }> = [];
  for (const { task, w } of wins) {
    const prev = merged[merged.length - 1];
    if (prev && w.startAtMs < prev.endsAtMs) {
      prev.endsAtMs = Math.max(prev.endsAtMs, w.endsAtMs);
      prev.ids.push(task.id);
    } else {
      merged.push({ ids: [task.id], title: sessionTitleFor(task), startAtMs: w.startAtMs, endsAtMs: w.endsAtMs });
    }
  }

  return merged.map((m) => {
    const notice = startNotice(ids, m.endsAtMs, lang);
    return {
      id: `study-${m.ids[0]}`,
      taskIds: m.ids,
      title: m.title,
      startAtMs: m.startAtMs,
      endsAtMs: m.endsAtMs,
      minutes: Math.round((m.endsAtMs - m.startAtMs) / 60_000),
      blocked,
      sig: sessionSig({ startAtMs: m.startAtMs, endsAtMs: m.endsAtMs, blocked, title: m.title, lang }),
      startTitle: notice.title,
      startBody: notice.body,
      startNow: m.startAtMs <= nowMs,
    };
  });
}

/** An entry as the native side reports it. */
export interface ExistingEntry { id: string; sig: string }

/**
 * Compare what should be scheduled with what is. Only `study-` entries are ours to cancel: a
 * "resume after the break" entry is the lecture's, and expires by itself.
 */
export function planDiff(
  planned: PlannedSession[], existing: ExistingEntry[],
): { toSchedule: PlannedSession[]; toCancel: string[] } {
  const have = new Map(existing.map((e) => [e.id, e.sig]));
  const want = new Set(planned.map((p) => p.id));
  return {
    toSchedule: planned.filter((p) => have.get(p.id) !== p.sig),
    toCancel: existing.filter((e) => e.id.startsWith('study-') && !want.has(e.id)).map((e) => e.id),
  };
}

// ── Words ───────────────────────────────────────────────────────────────────

export type PermissionFix = 'usage' | 'overlay' | 'none';

export interface FailureText { title: string; body: string; fix: PermissionFix }

/**
 * Why a start (or a schedule) did not happen, in words that name the fix (rule 3). The reasons are
 * the typed strings of modules/focus-guard.
 */
export function failureText(reason: string, lang: AppLanguage): FailureText {
  const he = lang === 'he';
  const kind = reason.split(':')[0];
  switch (kind) {
    case 'native_unavailable':
      return he
        ? { title: 'החסימה לא זמינה כאן', body: 'היא עובדת רק באפליקציה המותקנת (לא ב-Expo Go) ובגרסה חדשה מספיק.', fix: 'none' }
        : { title: "Blocking isn't available here", body: 'It works only in the installed app (not Expo Go), in a build that includes it.', fix: 'none' };
    case 'no_usage_access':
      return he
        ? { title: 'חסרה גישת שימוש', body: 'בלעדיה אני לא יודעת איזו אפליקציה פתוחה.', fix: 'usage' }
        : { title: 'Usage access is off', body: "Without it I can't tell which app is open.", fix: 'usage' };
    case 'no_overlay':
      return he
        ? { title: 'חסרה הצגה מעל אפליקציות', body: 'בלעדיה אני לא יכולה להציב את מסך הלמידה מעל אפליקציה חסומה.', fix: 'overlay' }
        : { title: 'Display over other apps is off', body: "Without it I can't put the learning screen over a blocked app.", fix: 'overlay' };
    case 'nothing_to_block':
      return he
        ? { title: 'לא נבחרה אפליקציה', body: 'בחרי לפחות אפליקציה אחת לחסימה.', fix: 'none' }
        : { title: 'No app chosen', body: 'Pick at least one app to block.', fix: 'none' };
    case 'bad_window':
    case 'window_over':
      return he
        ? { title: 'הזמן קצר מדי', body: 'בחרי זמן למידה ארוך יותר.', fix: 'none' }
        : { title: 'That time is too short', body: 'Choose a longer learning time.', fix: 'none' };
    case 'service_start_refused':
      return he
        ? { title: 'אנדרואיד לא נתן להתחיל', body: 'פתחי את מאירה ונסי שוב. אם זה חוזר — הגדרות › אפליקציות › מאירה › סוללה › ללא הגבלה.', fix: 'none' }
        : { title: "Android wouldn't start it", body: 'Open Meira and try again. If it repeats: Settings › Apps › Meira › Battery › Unrestricted.', fix: 'none' };
    case 'alarm_refused':
      return he
        ? { title: 'לא הצלחתי לקבוע התחלה אוטומטית', body: 'אפשר להתחיל ידנית בכל רגע.', fix: 'none' }
        : { title: "Couldn't set the automatic start", body: 'You can still start it by hand any time.', fix: 'none' };
    case 'disclosure_needed':
      return he
        ? { title: 'קודם לקרוא מה זה מאפשר', body: 'לפני ההגדרות מאירה מסבירה מה כל הרשאה רואה.', fix: 'none' }
        : { title: 'First, what this allows', body: 'Before Settings, Meira explains what each permission sees.', fix: 'none' };
    case 'settings_refused':
      return he
        ? { title: 'לא הצלחתי לפתוח את ההגדרות', body: 'פתחי ידנית: הגדרות › אפליקציות › גישה מיוחדת › מאירה.', fix: 'none' }
        : { title: "Couldn't open Settings", body: 'Open it by hand: Settings › Apps › Special access › Meira.', fix: 'none' };
    default:
      return he
        ? { title: 'משהו השתבש', body: `לא הצלחתי להתחיל (${reason.slice(0, 80)}).`, fix: 'none' }
        : { title: 'Something went wrong', body: `Couldn't start (${reason.slice(0, 80)}).`, fix: 'none' };
  }
}

/**
 * The prominent disclosure (Google Play User Data policy) shown BEFORE Meira sends her to grant
 * Usage access or Display over other apps. Both are special accesses with no runtime dialog, so
 * this card is the only place she is told, in the app, what they see and where it goes. It must
 * say: what is accessed, what for, that it stays on the phone, and how to turn it off — and it
 * needs her tap to go on. Bump the storage key in FocusSessionService if these words change in
 * substance, so she sees the new version once.
 */
export function focusDisclosure(lang: AppLanguage) {
  const he = lang === 'he';
  return {
    title: he ? 'לפני שמאשרים' : 'Before you allow',
    lines: he
      ? [
          'גישת שימוש: מאירה רואה איזו אפליקציה פתוחה על המסך — רק בזמן סשן לימוד.',
          'הצגה מעל אפליקציות: כך היא מציגה את מסך "את בלמידה" מעל האפליקציות שבחרת לחסום.',
          'המידע נשאר בטלפון. הוא לא נשלח לשרת של מאירה ולא לאף אחד אחר.',
          'אפשר לכבות את שתיהן בכל רגע בהגדרות של אנדרואיד.',
        ]
      : [
          'Usage access: Meira sees which app is on screen — only during a learning session.',
          "Display over other apps: that is how she puts the \"You're learning\" screen over the apps you chose to block.",
          "This stays on your phone. It is not sent to Meira's server or anyone else.",
          'You can turn both off any time in Android Settings.',
        ],
    accept: he ? 'הבנתי, להגדרות ›' : 'Got it, open Settings ›',
    decline: he ? 'לא עכשיו' : 'Not now',
  };
}

/** The strings of the chooser / running panel / menu row. */
export function focusStrings(lang: AppLanguage) {
  const he = lang === 'he';
  return {
    menuRow: he ? '📚 למידה ממוקדת — אפליקציות חסומות' : '📚 Learning sessions — blocked apps',
    sheetTitle: he ? 'למידה בלי הסחות' : 'Learn without distractions',
    sectionTitle: he ? 'לחסום בזמן למידה' : 'Block during learning',
    blockedHint: he ? 'האפליקציות שייחסמו בזמן הלימוד' : 'Apps blocked while you learn',
    callsNote: he ? 'וואטסאפ נחסם לגמרי, כולל שיחות. הטלפון ושיחות חירום לעולם לא.' : 'WhatsApp is blocked completely, calls included. The phone and emergency calls never are.',
    notInstalled: he ? 'לא מותקנת' : 'not installed',
    start: (minutes: number) => (he ? `להתחיל ללמוד · ${minutes} דק׳` : `Start learning · ${minutes} min`),
    pickOne: he ? 'בחרי לפחות אפליקציה אחת' : 'Pick at least one app',
    permHeader: he ? 'כדי לחסום אפליקציות מאירה צריכה:' : 'To block apps Meira needs:',
    stepUsage: he ? '1. גישת שימוש' : '1. Usage access',
    stepOverlay: he ? '2. הצגה מעל אפליקציות אחרות' : '2. Display over other apps',
    allow: he ? 'לאפשר ›' : 'Allow ›',
    allowed: he ? '✓ מאופשר' : '✓ Allowed',
    permFooter: he ? 'אחרי שמאפשרים, חוזרים לכאן.' : 'After allowing, come back here.',
    running: (minutesLeft: number) => (he ? `📚 לומדים · עוד ${minutesLeft} דק׳` : `📚 Learning · ${minutesLeft} min left`),
    runningTitle: (t: string) => t,
    endEarly: he ? `סיום מוקדם (${END_EARLY_SECONDS} ש׳)` : `End early (${END_EARLY_SECONDS} s)`,
    endCountdown: (s: number) => (he ? `אפשר לסיים בעוד ${s}…` : `You can end in ${s}…`),
    endNow: he ? 'לסיים עכשיו' : 'End now',
    keepGoing: he ? 'להמשיך ללמוד' : 'Keep learning',
    notificationsOff: he ? 'ההתראות כבויות — לא תראי את תזכורת הלימוד.' : "Notifications are off — you won't see the learning reminder.",
    autoOn: he ? 'מתחיל לבד בזמן משימות לימוד' : 'Starts by itself at your study tasks',
    warnUsage: he ? 'כיבית את גישת השימוש — החסימה לא עובדת.' : 'Usage access was turned off — the block is not working.',
    warnOverlay: he ? 'כיבית הצגה מעל אפליקציות — החסימה לא עובדת.' : 'Display over other apps was turned off — the block is not working.',
    warnFailed: he ? 'לא מצליחה להציב את מסך הלמידה.' : "I can't put the learning screen up.",
    notRunning: he ? 'החסימה לא פועלת כרגע — מנסה להתחיל מחדש.' : 'The block is not running — restarting it.',
    menuLine: (names: string, ready: boolean) =>
      he ? `${names} · ${ready ? 'מוכן' : 'דורש הרשאה'}` : `${names} · ${ready ? 'ready' : 'needs permission'}`,
    close: he ? 'סגירה' : 'Close',
  };
}
