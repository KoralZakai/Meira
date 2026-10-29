/**
 * calendarErrorKind — what went wrong with the calendar, in words that name
 * the fix.
 *
 * 30.9, 09:02: the Today screen opened with a red card reading
 *   "⚠️ Calendar not read — Google said: network: fetch failed:
 *    java.net.UnknownHostException: Unable to resolve host
 *    "www.googleapis.com": No address associated with hostname
 *    New events cannot arrive until this is fixed. Tap to reconnect Google"
 * The phone had dropped its connection for a moment. Nothing about Google was
 * broken, reconnecting would have done nothing, and the raw exception filled
 * the top of the screen at the exact minute she had to leave for the dentist.
 *
 * Rule 3 of the silent-state rule: "sign in again" and "enable the API" are
 * different fixes and must read differently — and "you are offline" is a
 * third one, which fixes itself.
 *
 * Pure. The error strings are GoogleService.fetchCalendarEvents':
 * `network: …`, `http_<status>: <Google's message>`, or `not_connected`.
 */

export type CalendarErrorKind =
  | 'offline'       // the phone could not reach Google — retry, nothing to do
  | 'signed_out'    // the token is dead or lacks the calendar scope — sign in again
  | 'api_off'       // the Calendar API is disabled for the project — a setup fix
  | 'busy'          // Google said "later" (429 / 5xx) — retry
  | 'not_connected' // no Google account connected at all
  | 'other';

export function classifyCalendarError(error: string | null | undefined): CalendarErrorKind | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e === 'not_connected') return 'not_connected';
  if (e.startsWith('network:')) return 'offline';
  const status = Number(/^http_(\d{3})/.exec(e)?.[1]);
  if (status === 403 && /has not been used|is disabled|accessnotconfigured|api has not/.test(e)) return 'api_off';
  if (status === 401 || /invalid_grant|invalid authentication|insufficient authentication scopes/.test(e)) {
    return 'signed_out';
  }
  if (status === 429 || (status >= 500 && status < 600)) return 'busy';
  return 'other';
}

/** One short line for the Today header, and what tapping it should do. */
export function calendarErrorLine(
  kind: CalendarErrorKind, he: boolean,
): { text: string; action: 'retry' | 'reconnect' | 'details' } {
  switch (kind) {
    case 'offline':
      return { text: he ? '📡 אין חיבור · מנסה שוב' : '📡 Offline · retrying', action: 'retry' };
    case 'busy':
      return { text: he ? '📅 גוגל עמוס · מנסה שוב' : '📅 Google busy · retrying', action: 'retry' };
    case 'signed_out':
      return { text: he ? '📅 להתחבר שוב לגוגל' : '📅 Reconnect Google', action: 'reconnect' };
    case 'api_off':
      return { text: he ? '📅 היומן כבוי בגוגל' : '📅 Calendar is off in Google', action: 'details' };
    case 'not_connected':
      return { text: he ? '📅 לחבר יומן' : '📅 Connect a calendar', action: 'reconnect' };
    default:
      return { text: he ? '📅 היומן לא נקרא' : "📅 Calendar didn't load", action: 'details' };
  }
}
