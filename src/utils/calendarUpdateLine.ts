/**
 * calendarUpdateLine — what "📅 Update calendars" in the menu says it did.
 *
 * 8.10, Koral: the 📅 left Today's header and became a menu button. A tap
 * reads every calendar now (past the throttle — she went looking, rule 7) and
 * then says what happened in one or two lines. It must be able to say "it
 * failed, and here is why" (rule 3): a calendar Google refused, phone
 * calendars without permission and an Outlook that needs signing in again
 * each name their fix — never a "✓ up to date" over a calendar nobody read.
 */
import { calendarErrorLine, classifyCalendarError } from './calendarErrorKind';
import { gmailOffLine } from './gmailAccess';

/** The parts of CalendarSyncResult this line reads (services/CalendarAutoSync). */
export interface CalendarUpdateResult {
  added: number;
  error: string | null;
  device?: { ok: boolean; error?: string };
  outlook?: { ok: boolean; error?: string };
}

export interface CalendarUpdateLine {
  title: string;
  body: string;
  /** Something could not be read; the body says what. */
  failed: boolean;
  /** No calendar is connected at all; offer "connect". */
  nothingConnected: boolean;
}

// Not a failure: the source simply isn't in use.
const DEVICE_UNUSED = new Set(['off', 'expo_go']);
const OUTLOOK_UNUSED = new Set(['not_configured', 'not_connected', 'cancelled']);

/**
 * `emailEvents` is how many events Gmail suggested, or `null` when this build does not
 * read Gmail (utils/gmailAccess) — said in words, never as "0 found in your email".
 */
export function calendarUpdateLine(r: CalendarUpdateResult, emailEvents: number | null, he: boolean): CalendarUpdateLine {
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const googleKind = classifyCalendarError(r.error);
  const googleUsed = googleKind !== 'not_connected';
  const deviceUsed = Boolean(r.device) && !DEVICE_UNUSED.has(String(r.device?.error ?? ''));
  const outlookUsed = Boolean(r.outlook) && !OUTLOOK_UNUSED.has(String(r.outlook?.error ?? ''));

  const problems: string[] = [];
  if (googleKind && googleKind !== 'not_connected') problems.push(calendarErrorLine(googleKind, he).text);
  if (deviceUsed && r.device && !r.device.ok && r.device.error) {
    problems.push(r.device.error === 'permission_denied'
      ? T('📱 Phone calendars: no permission', '📱 יומני הטלפון: אין הרשאה')
      : T(`📱 Phone calendars weren't read (${r.device.error})`, `📱 יומני הטלפון לא נקראו (${r.device.error})`));
  }
  if (r.outlook && !r.outlook.ok && r.outlook.error && !OUTLOOK_UNUSED.has(r.outlook.error)) {
    problems.push(r.outlook.error === 'reconnect'
      ? T('📧 Outlook: sign in again', '📧 Outlook: צריך להתחבר שוב')
      : T(`📧 Outlook wasn't read (${r.outlook.error})`, `📧 Outlook לא נקרא (${r.outlook.error})`));
  }

  const nothingConnected = !googleUsed && !deviceUsed && !outlookUsed && problems.length === 0;
  const lines: string[] = [];
  if (nothingConnected) {
    lines.push(T('No calendar is connected yet.', 'עוד לא חובר יומן.'));
  } else {
    if (problems.length) lines.push(...problems);
    const ok = r.added > 0
      ? T(`✓ ${r.added} new on your calendar`, `✓ ${r.added} חדשים ביומן`)
      : T('✓ Nothing new on your calendar', '✓ אין חדש ביומן');
    // With a failure, "nothing new" would be a claim about a calendar nobody
    // read — only the count of what DID arrive is said.
    if (!problems.length || r.added > 0) lines.push(ok);
  }
  if (emailEvents === null) {
    if (!nothingConnected) lines.push(gmailOffLine(he));
  } else if (emailEvents > 0) {
    lines.push(T(`📧 ${emailEvents} event${emailEvents === 1 ? '' : 's'} found in your email`,
      `📧 ${emailEvents} אירועים נמצאו במייל`));
  }
  return {
    title: T('Update calendars', 'עדכון יומנים'),
    body: lines.join('\n'),
    failed: problems.length > 0,
    nothingConnected,
  };
}
