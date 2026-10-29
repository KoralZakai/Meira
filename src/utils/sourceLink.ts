/**
 * Where a task came from, as a link she can tap: the calendar event or the
 * email behind it.
 *
 * DERIVED, never stored. Every id needed is already on the task (`calendarEventId`,
 * `gmailThreadId`, the `ocal-` id), so this adds no column, no sealed field and
 * no sync path. A Google event link carries the account e-mail inside its
 * `eid` — one more reason not to write it to the cloud next to the task.
 *
 * Pure: no storage, no network. Node-testable (tests/run-source-link.ts).
 */
import type { Task } from '../types/index';

export type SourceLinkKind = 'gmail' | 'google-event' | 'google-day' | 'outlook-event';

export interface SourceLink {
  url: string;
  kind: SourceLinkKind;
  labelEn: string;
  labelHe: string;
}

// btoa (Hermes, Node 16+) — Buffer does not exist on the phone. Account e-mails
// and Google event ids are ASCII, which is all btoa accepts.
const b64url = (s: string): string =>
  btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * `googleEmail` is the account the event was read from. Without it the exact
 * event cannot be addressed, so the link opens that DAY in Google Calendar
 * (kind 'google-day') — and says so, instead of pretending to be the event.
 */
export function sourceLinkOf(task: Partial<Task>, googleEmail?: string): SourceLink | null {
  const id = String(task.id || '');
  if (task.gmailThreadId) {
    return {
      url: `https://mail.google.com/mail/u/${googleEmail ? `?authuser=${encodeURIComponent(googleEmail)}` : '0/'}#all/${encodeURIComponent(task.gmailThreadId)}`,
      kind: 'gmail', labelEn: 'Open the email', labelHe: 'פתחי את המייל',
    };
  }
  if (id.startsWith('ocal-')) {
    const raw = id.slice(5).replace(/@\d{4}-\d{2}-\d{2}$/, '');
    return {
      url: `https://outlook.office.com/calendar/item/${encodeURIComponent(raw)}`,
      kind: 'outlook-event', labelEn: 'Open in Outlook', labelHe: 'פתחי ב-Outlook',
    };
  }
  const gid = task.calendarEventId && !String(task.calendarEventId).includes(':') ? String(task.calendarEventId) : '';
  if (gid && id.startsWith('gcal-')) {
    if (googleEmail) {
      return {
        url: `https://calendar.google.com/calendar/event?eid=${b64url(`${gid} ${googleEmail}`)}`,
        kind: 'google-event', labelEn: 'Open the event', labelHe: 'פתחי את האירוע',
      };
    }
    const d = String(task.date || '').split('-');
    if (d.length === 3) {
      return {
        url: `https://calendar.google.com/calendar/r/day/${Number(d[0])}/${Number(d[1])}/${Number(d[2])}`,
        kind: 'google-day', labelEn: 'Open that day in Google Calendar', labelHe: 'פתחי את היום ביומן גוגל',
      };
    }
  }
  return null;
}
