/**
 * gmailAccess — whether this build reads Gmail at all, and how that is said.
 *
 * 19.10, before Google Play (Koral: "כן, להוציא"): `gmail.readonly` is a RESTRICTED
 * scope. Keeping it means a paid CASA security review every 12 months, an
 * "unverified app" screen and a lifetime cap of 100 users. The store build asks
 * for Calendar only. The calendar, its import, routes and briefs work without it.
 *
 * Off is an ANSWER, not an empty result (silent-state rule 1): every surface that
 * used to show what Gmail found now says Gmail is off, in words, instead of
 * showing nothing — "0 events in your email" would be a claim about a mailbox
 * nobody read. Turning it back on is this one constant (plus the Data safety
 * "Emails" row and the privacy page).
 *
 * Pure: no expo imports, so the tests read it directly.
 */

export const GMAIL_ENABLED = false;

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** What Meira asks Google for on sign-in. */
export function googleScopes(gmail: boolean = GMAIL_ENABLED): string[] {
  return [
    ...(gmail ? [GMAIL_SCOPE] : []),
    'https://www.googleapis.com/auth/calendar.readonly',
    // Write scope: accepting an appointment puts it on the real calendar
    // (createCalendarEvent). Tokens granted before this scope existed keep working
    // for reads and simply fail the insert — the local task is created either way.
    'https://www.googleapis.com/auth/calendar.events',
  ];
}

/** One short line for wherever email events used to appear. */
export function gmailOffLine(he: boolean): string {
  return he
    ? '✉️ קריאת Gmail כבויה בגרסה הזו. מאירה קוראת רק את היומן.'
    : '✉️ Reading Gmail is off in this version. Meira reads your calendar only.';
}

/** The per-account mail switch, when there is nothing to switch. */
export function gmailOffShort(he: boolean): string {
  return he ? 'מייל: כבוי' : 'Mail: off';
}
