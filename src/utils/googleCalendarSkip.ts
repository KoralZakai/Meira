/**
 * googleCalendarSkip — which phone calendar Meira already reads through Google.
 *
 * When Google is connected directly, GoogleSync reads that account's primary
 * calendar by API, so the same calendar on the phone is skipped (otherwise
 * every event arrives twice). The bug (6.10): the skip asked only "is SOME
 * Google token stored?" and then dropped EVERY Google account's primary
 * calendar. With a private and a work Gmail on the phone, and one of them
 * connected, the other's main calendar was silently never read. The switch
 * was greyed with "read through Google above", which was untrue.
 *
 * Now only the connected account's primary is skipped. When the connected
 * account's email is not known yet (a token from an older build), the old skip
 * stays, but as 'unsure', so the row can say it cannot tell rather than claim
 * something it does not know (CLAUDE.md silent-state rule 3).
 *
 * Pure: DeviceCalendarSync passes what expo-calendar and GoogleService know.
 * Tested by tests/run-device-calendar-google.ts.
 */

export interface GoogleLink {
  connected: boolean;
  /** One directly connected account, e.g. "koral@gmail.com"; unknown on old tokens. */
  email?: string;
  /** Every account whose calendar Meira reads by API (several Gmails, 6.10). */
  emails?: string[];
  /** A connected account whose address is not known yet. */
  unknown?: boolean;
}

export interface PhoneCalendarFacts {
  /** Android account type: com.google, com.microsoft.office.outlook, LOCAL … */
  accountType: string;
  /** The account name Android shows: the Gmail address for a Google account. */
  account: string;
  isPrimary?: boolean;
}

export type GoogleSkip = 'no' | 'yes' | 'unsure';

const norm = (s?: string) => String(s || '').trim().toLowerCase();

export function readByGoogleApi(cal: PhoneCalendarFacts, link: GoogleLink): GoogleSkip {
  if (!link.connected) return 'no';
  if (cal.accountType !== 'com.google' || !cal.isPrimary) return 'no';
  const emails = [...(link.emails ?? []), ...(link.email ? [link.email] : [])].map(norm);
  if (emails.includes(norm(cal.account))) return 'yes';
  // An account we cannot name yet might be this one: skip, and say so.
  if (link.unknown || !emails.length) return 'unsure';
  return 'no';
}
