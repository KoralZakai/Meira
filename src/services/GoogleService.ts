/**
 * GoogleService — Google OAuth (expo-auth-session), Calendar events, and
 * Directions plans (transit + car) used for "when do I leave" calculations.
 *
 * Dependencies: expo-auth-session/secure-store/web-browser, RoutePlanner
 * (all Directions routing lives there — no expo deps, node-testable).
 *
 * IMPORTANT for AI agents: getTransitPlan / getCarDriveTime route FROM
 * userProfile.homeAddress — callers that need a different origin swap the
 * confirmed origin into that field for the call (see LLMService
 * get_transit_plan and LumiCoachEngine.planAndNotify). Never call these
 * without a user-confirmed origin. Consumers: LLMService, LumiCoachEngine,
 * WakeCalculator screen.
 */
import { endFromExclusive } from '../utils/allDay';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { UserProfile, CalendarEvent, TransitPlan, TransportType } from '../types/index';
import * as RoutePlanner from './RoutePlanner';
import { GMAIL_ENABLED, googleScopes } from '../utils/gmailAccess';
import { meetingUrlFromEvent } from '../utils/meetingLink';
import { eventDetailsFromGoogle, type EventDetails } from '../utils/eventDetails';
import { addressFromDescription, addressFromTitle } from '../utils/eventAddress';
import { localClockOf } from '../utils/calendarTime';

WebBrowser.maybeCompleteAuthSession();

/**
 * A day's calendar events, or the reason there are none.
 * `error` is undefined ONLY when Google actually answered.
 */
export interface CalendarFetchResult {
  events: CalendarEvent[];
  /** Whole-day events, apart: `events` stays timed-only for the brief and the alarm (29.10). */
  allDay?: CalendarEvent[];
  error?: string;
}

// Calendar only since 19.10: gmail.readonly is a restricted scope (paid CASA review,
// 100-user cap). utils/gmailAccess owns the switch; every Gmail reader below checks it,
// so a token granted by an older build that still carries the scope reads no mail either.
const GOOGLE_SCOPES = googleScopes();

// OAuth client id: the Android-specific id when present (EAS env), else the generic one.
const OAUTH_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_ANDROID ||
  process.env.EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || '';

// ── Her Google accounts (6.10: "several accounts of the same kind — private
// and work Gmail") ────────────────────────────────────────────────────────────
// One token per account, each under its own SecureStore key, listed in an
// index. A second sign-in used to OVERWRITE the first account silently; now
// the same address replaces its own token and a new address is added. Each
// account says whether Meira reads its calendar and its mail.
//
// Migration: older builds kept ONE token under `google_tokens`; it becomes the
// first account in place (its key does not move), and its address is looked
// up once from Calendar's own answer.

/** {accessToken, refreshToken?, expiresAt, email?} as JSON, per account. */
const LEGACY_TOKEN_KEY = 'google_tokens';
const ACCOUNTS_KEY = 'google_accounts';

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  /** The account's address ("koral@gmail.com"). */
  email?: string;
}

/** One Google account she connected directly. */
export interface GoogleAccount {
  /** "" until known (a token from an older build, before its first lookup). */
  email: string;
  /** SecureStore key of its tokens. */
  key: string;
  /** Read this account's calendar by API. */
  calendar: boolean;
  /** Read this account's Gmail for events. */
  mail: boolean;
  addedAt: number;
}

/** A failed account lookup is not retried for this long (it runs on every sync). */
const ACCOUNT_LOOKUP_RETRY_MS = 10 * 60_000;
let accountLookupFailedAt = 0;
/** Why the last "add an account" did not finish, in words for the Calendars screen. */
let lastSignInError: string | null = null;

const sameEmail = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
/** SecureStore keys allow letters, digits, ".", "-" and "_" only. */
const keyForEmail = (email: string) => `google_tokens.${email.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`;

async function readTokens(key: string): Promise<StoredTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch (e) {
    console.warn('[Google] token unreadable', key, e);
    return null;
  }
}

async function writeTokens(key: string, t: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(t));
}

async function saveAccounts(accounts: GoogleAccount[]): Promise<void> {
  await SecureStore.setItemAsync(ACCOUNTS_KEY, JSON.stringify({ accounts }));
}

async function loadAccounts(): Promise<GoogleAccount[]> {
  try {
    const raw = await SecureStore.getItemAsync(ACCOUNTS_KEY);
    if (raw) return (JSON.parse(raw).accounts ?? []) as GoogleAccount[];
  } catch (e) {
    console.warn('[Google] accounts list unreadable', e);
  }
  const legacy = await readTokens(LEGACY_TOKEN_KEY);
  if (!legacy) return [];
  const migrated: GoogleAccount = {
    email: legacy.email || '', key: LEGACY_TOKEN_KEY, calendar: true, mail: true, addedAt: Date.now(),
  };
  await saveAccounts([migrated]).catch((e) => console.warn('[Google] accounts list not saved', e));
  return [migrated];
}

/** The account for this address, or the first one when no address is given. */
async function accountFor(email?: string): Promise<GoogleAccount | null> {
  const accounts = await loadAccounts();
  if (!email) return accounts[0] ?? null;
  return accounts.find((a) => sameEmail(a.email, email)) ?? null;
}

/** calendars/primary → id IS the account's address; no new scope needed. */
async function emailForAccessToken(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary?fields=id', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      console.warn('[Google] account lookup failed: HTTP', r.status);
      return null;
    }
    const id = String((await r.json())?.id || '').trim();
    return id.includes('@') ? id : null;
  } catch (e) {
    console.warn('[Google] account lookup failed:', String((e as Error)?.message || e).slice(0, 120));
    return null;
  }
}

/** Google OAuth + Calendar + Directions facade. Transit/car planners route FROM userProfile.homeAddress — pass a profile with the CONFIRMED origin swapped in when the trip doesn't start at home. */
/**
 * The redirect Google will accept for THIS client id.
 *
 * This used to be `lumi://` unconditionally, which Google rejects outright:
 * a custom scheme is only permitted for OAuth clients of type **Android** or
 * **iOS**, never for a Web client. Sending it with a Web client id produces
 * "Error 400: invalid_request — this app doesn't comply with Google's OAuth
 * 2.0 policy", which is exactly what the sign-in was failing with.
 *
 * An Android client's redirect is its own id, reversed:
 *   433828308700-abc.apps.googleusercontent.com
 *   → com.googleusercontent.apps.433828308700-abc:/oauth2redirect
 *
 * Derived from the id rather than hardcoded, so swapping the client id is the
 * only change needed. Falls back to the app scheme when the id does not look
 * like a Google one, which keeps a dev build working.
 */
function googleRedirectUri(): string {
  const match = OAUTH_CLIENT_ID.match(/^(.+)\.apps\.googleusercontent\.com$/);
  if (!match) return AuthSession.makeRedirectUri({ scheme: 'lumi' });
  return `com.googleusercontent.apps.${match[1]}:/oauth2redirect`;
}

/** Which Google account last answered for an event id (in memory, per session). */
const eventAnsweredBy = new Map<string, string>();
/** Event details by event id, ten minutes: an edited description shows soon, a closed card reopens at once. */
const EVENT_TTL_MS = 10 * 60 * 1000;
const eventCache = new Map<string, { details: EventDetails; at: number }>();

export const GoogleService = {
  async signInWithGoogle(): Promise<boolean> {
    try {
      const redirectUri = googleRedirectUri();
      const discovery = await AuthSession.fetchDiscoveryAsync('https://accounts.google.com');
      const request = new AuthSession.AuthRequest({
        clientId: OAUTH_CLIENT_ID,
        scopes: GOOGLE_SCOPES,
        redirectUri,
        // offline access → Google returns a refresh_token on the code exchange.
        // select_account: she picks WHICH Google account — private or work.
        extraParams: { access_type: 'offline', prompt: 'select_account consent' },
      });
      lastSignInError = null;
      const result = await request.promptAsync(discovery);
      if (result.type !== 'success' || !result.params?.code) {
        const err = (result as any)?.params?.error || (result as any)?.error?.code || result.type;
        // A work account whose admin blocks unverified apps comes back as this;
        // its calendar can still come through the phone (rule 9: a rung below).
        lastSignInError = /admin_policy|access_denied|org_internal|disallowed/i.test(String(err))
          ? 'admin_blocked' : String(err || 'cancelled');
        console.warn('[Google] sign-in did not finish:', err);
        return false;
      }
      // PKCE authorization-code flow: the code MUST be exchanged for tokens
      // (result.authentication is null in this flow — the old code stored '').
      const tokens = await AuthSession.exchangeCodeAsync(
        {
          clientId: OAUTH_CLIENT_ID,
          code: result.params.code,
          redirectUri,
          extraParams: { code_verifier: request.codeVerifier || '' },
        },
        discovery,
      );
      const fresh: StoredTokens = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      };
      const email = await emailForAccessToken(fresh.accessToken);
      const accounts = await loadAccounts();
      // The same address replaces its own token; a new address is a new account.
      let account = email ? accounts.find((a) => sameEmail(a.email, email)) : undefined;
      if (!account && !email && accounts.length === 1 && !accounts[0].email) account = accounts[0];
      if (account) {
        await writeTokens(account.key, { ...fresh, email: email || account.email || undefined });
        if (email) account.email = email;
      } else {
        account = {
          email: email || '', key: email ? keyForEmail(email) : `google_tokens.added_${Date.now()}`,
          calendar: true, mail: true, addedAt: Date.now(),
        };
        await writeTokens(account.key, { ...fresh, email: email || undefined });
        accounts.push(account);
      }
      await saveAccounts(accounts);
      accountLookupFailedAt = 0;
      return true;
    } catch (e) {
      lastSignInError = String((e as Error)?.message || e).slice(0, 160);
      console.warn('[Google] Auth error:', e);
      return false;
    }
  },

  /** Why the last "add an account" did not finish: 'admin_blocked', 'cancelled', or Google's words. */
  lastSignInError(): string | null {
    return lastSignInError;
  },

  /** Every Google account she connected, with what Meira reads from each. Unknown addresses are looked up. */
  async listGoogleAccounts(): Promise<GoogleAccount[]> {
    const accounts = await loadAccounts();
    if (accounts.some((a) => !a.email)) {
      for (const a of accounts.filter((x) => !x.email)) await this.identifyGoogleAccount(false, a.key);
      return loadAccounts();
    }
    return accounts;
  },

  /** Read this account's calendar / mail, or not. */
  async setGoogleAccountUse(email: string, use: { calendar?: boolean; mail?: boolean }): Promise<void> {
    const accounts = await loadAccounts();
    const a = accounts.find((x) => sameEmail(x.email, email));
    if (!a) return;
    if (use.calendar !== undefined) a.calendar = use.calendar;
    if (use.mail !== undefined) a.mail = use.mail;
    await saveAccounts(accounts);
  },

  /** Disconnect one account: its token is deleted from this phone. */
  async disconnectGoogleAccount(email: string): Promise<boolean> {
    const accounts = await loadAccounts();
    const a = accounts.find((x) => sameEmail(x.email, email) || (!email && !x.email));
    if (!a) return false;
    await SecureStore.deleteItemAsync(a.key).catch((e) => console.warn('[Google] token not deleted', e));
    await saveAccounts(accounts.filter((x) => x !== a));
    // Guests, descriptions and dial-in PINs of that account must not outlive it.
    eventCache.clear(); eventAnsweredBy.clear();
    return true;
  },

  /** Addresses whose calendar Meira reads by API; `unknown` = a connected account not identified yet. */
  async googleCalendarEmails(): Promise<{ emails: string[]; unknown: boolean }> {
    const accounts = (await loadAccounts()).filter((a) => a.calendar);
    return { emails: accounts.map((a) => a.email).filter(Boolean), unknown: accounts.some((a) => !a.email) };
  },

  /** True when a Google token is stored (i.e. the user connected their account). */
  /**
   * Is there a Google token on this device?
   *
   * NOTE WHAT THIS DOES NOT ANSWER. A revoked grant, a refresh token Google
   * has retired, and a grant made before the calendar scope existed all leave
   * the blob in SecureStore untouched, so all three answer `true` here. This
   * is "have we ever connected", not "does it work" — use
   * `verifyGoogleConnection` for the second question, which is the one every
   * user-facing check is actually asking.
   */
  async isGoogleConnected(): Promise<boolean> {
    if ((await loadAccounts()).length) return true;
    // Legacy single-token storage from older builds.
    return Boolean(await SecureStore.getItemAsync('google_access_token'));
  },

  /**
   * Does the stored grant still WORK — asked by using it.
   *
   * "✓ Google connected" was a check that could not fail: it read a blob out
   * of SecureStore and said yes. Koral verified the connection herself, was
   * told it was fine, and the interview still never arrived, because the token
   * was present and the request was being refused. A check that cannot fail is
   * worse than no check — it ends the investigation. (CLAUDE.md, rule 3.)
   *
   * One real request against the calendar, today's window, smallest possible
   * page. Returns the fix in words, not a boolean.
   */
  async verifyGoogleConnection(): Promise<{
    ok: boolean;
    /** Google's own words when it refused, else null. */
    error: string | null;
    /** Which fix this is: reconnect here, or change the Cloud project. */
    fix: 'none' | 'reconnect' | 'enable_api' | 'connect';
  }> {
    if (!(await this.isGoogleConnected())) {
      return { ok: false, error: 'not_connected', fix: 'connect' };
    }
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const { error } = await this.fetchCalendarEvents(key);
    if (!error) return { ok: true, error: null, fix: 'none' };
    // 401/403 split: an expired or revoked grant is fixed on this phone, a
    // disabled API is fixed in the Google Cloud console and nowhere else.
    // Telling her to "sign in again" for the second one wastes her evening.
    const disabled = /has not been used in project|is disabled|accessNotConfigured/i.test(error);
    return {
      ok: false,
      error,
      fix: disabled ? 'enable_api' : 'reconnect',
    };
  },

  /**
   * Which Google account is connected directly: {connected, email?}.
   *
   * The email is what tells the phone-calendar reader WHICH account's primary
   * calendar GoogleSync already reads (utils/googleCalendarSkip). Without it
   * every Google account's main calendar on the phone was skipped, so a second
   * Gmail's calendar silently went unread. A token from an older build has no
   * email: it is looked up once from Calendar's own answer and kept.
   */
  async connectedGoogleAccount(): Promise<{ connected: boolean; email?: string }> {
    const first = await accountFor();
    if (!first) return { connected: Boolean(await SecureStore.getItemAsync('google_access_token')) };
    if (first.email) return { connected: true, email: first.email };
    const email = await this.identifyGoogleAccount(false, first.key);
    return { connected: true, email: email || undefined };
  },

  /**
   * Ask Calendar which account this token belongs to, and store it.
   * calendars/primary → id IS the account's address; no new scope needed.
   * null (with the reason in the log) when it cannot say; then retried after
   * ACCOUNT_LOOKUP_RETRY_MS, never on every sync.
   */
  async identifyGoogleAccount(force = false, key?: string): Promise<string | null> {
    if (!force && accountLookupFailedAt && Date.now() - accountLookupFailedAt < ACCOUNT_LOOKUP_RETRY_MS) return null;
    const accounts = await loadAccounts();
    const account = key ? accounts.find((a) => a.key === key) : accounts.find((a) => !a.email) ?? accounts[0];
    if (!account) return null;
    const token = await this.getToken(account.email || undefined, account.key);
    if (!token) return null;
    const id = await emailForAccessToken(token);
    if (!id) {
      accountLookupFailedAt = Date.now();
      return null;
    }
    const stored = await readTokens(account.key);
    if (stored) await writeTokens(account.key, { ...stored, email: id });
    account.email = id;
    await saveAccounts(accounts);
    accountLookupFailedAt = 0;
    return id;
  },

  /** A fresh access token for this account (by address), or the first account's. */
  async getToken(email?: string, key?: string): Promise<string | null> {
    const account = key ? (await loadAccounts()).find((a) => a.key === key) ?? null : await accountFor(email);
    if (!account) return email || key ? null : SecureStore.getItemAsync('google_access_token'); // legacy fallback
    const stored = await readTokens(account.key);
    if (!stored) return null;
    // Refresh when the access token is expired (or about to).
    if (Date.now() > stored.expiresAt - 60_000 && stored.refreshToken) {
      try {
        const discovery = await AuthSession.fetchDiscoveryAsync('https://accounts.google.com');
        const refreshed = await AuthSession.refreshAsync(
          { clientId: OAUTH_CLIENT_ID, refreshToken: stored.refreshToken },
          discovery,
        );
        const next: StoredTokens = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? stored.refreshToken,
          expiresAt: Date.now() + (refreshed.expiresIn ?? 3600) * 1000,
          email: stored.email,
        };
        await writeTokens(account.key, next);
        return next.accessToken;
      } catch (e) {
        console.warn('[Google] token refresh failed:', e);
        return stored.accessToken; // let the API call fail loudly if truly dead
      }
    }
    return stored.accessToken;
  },

  /**
   * One local day's events, WITH the reason when there are none.
   *
   * The window used to be sent as `${date}T00:00:00Z` – `T23:59:59Z`, i.e. UTC.
   * In Israel (UTC+3) that asks Google for 03:00 today → 02:59 TOMORROW, so
   * anything before 03:00 was never returned and late-night events landed on
   * the wrong day. The bounds are built from local midnight now and carry a
   * real offset, so "today" means the user's today.
   *
   * Why this returns a REASON and not just an array: every way this call can
   * fail — no token, a refresh token Google has revoked, a grant made before
   * the calendar scope existed, the Calendar API not enabled on the project —
   * used to arrive at the caller as `[]`, which is indistinguishable from an
   * empty calendar. Koral had an interview sitting on her calendar and the
   * Profile screen answered "0 events found", because a 403 and a free
   * Wednesday looked identical all the way up the stack. They do not any more.
   */
  async fetchCalendarEvents(date: string, email?: string): Promise<CalendarFetchResult> {
    const token = await this.getToken(email);
    if (!token) return { events: [], error: 'not_connected' };
    try {
      const [y, m, d] = date.split('-').map(Number);
      const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0);
      const dayEnd = new Date(y, m - 1, d, 23, 59, 59, 999);
      const params = new URLSearchParams({
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: 'true',        // expands recurring events into occurrences
        orderBy: 'startTime',
        maxResults: '50',
      });
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => null);

      // An HTTP error carries Google's own explanation. Keep it: "Request had
      // insufficient authentication scopes" and "Calendar API has not been
      // used in project … before or it is disabled" are two completely
      // different fixes, and she cannot act on either without being told which.
      if (!res.ok || !data) {
        const detail = String(
          data?.error?.message || data?.error_description || data?.error || 'no response body',
        ).slice(0, 200);
        const reason = `http_${res.status}: ${detail}`;
        console.warn('[Google] calendar fetch failed', date, reason);
        return { events: [], error: reason };
      }

      // Google returns an offset-bearing RFC-3339 string ("…T11:00:00+03:00");
      // utils/calendarTime parses it and reads the local clock, so the zone
      // database decides the offset on both sides of a DST change.
      const hhmm = localClockOf;

      // A vacation or a conference in Google is an all-day event: imported as
      // a whole day / a range (utils/allDay), never as 00:00 (29.10, Koral).
      const allDay: CalendarEvent[] = (data.items || [])
        .filter((item: any) => item.start?.date && !item.start?.dateTime && item.status !== 'cancelled' && item.summary)
        .map((item: any) => ({
          id: item.id,
          title: item.summary,
          startTime: '',
          endTime: '',
          allDay: true,
          startDate: String(item.start.date),
          endDate: endFromExclusive(String(item.start.date), item.end?.date),
          location: item.location || undefined,
          description: item.description,
        }));
      const events: CalendarEvent[] = (data.items || [])
        // An all-day event has `start.date` and no `start.dateTime`. It has no
        // clock time at all, so giving it 00:00 would invent a midnight
        // appointment — and then a wake alarm for it. Skipped.
        .filter((item: any) => item.start?.dateTime && item.status !== 'cancelled')
        .map((item: any) => ({
          id: item.id,
          title: item.summary,
          startTime: hhmm(item.start?.dateTime) || '00:00',
          endTime: hhmm(item.end?.dateTime) || '00:00',
          // An invite written by a recruiting system (Comeet, Spark Hire,
          // Greenhouse…) leaves `location` EMPTY and puts the address in the
          // body, usually beside a Google Maps link. Reading it back out is
          // the difference between an interview that has a route, a leave-home
          // time and an alarm, and one that is only a name on a timeline.
          location: item.location || addressFromDescription(item.description) || addressFromTitle(item.summary),
          description: item.description,
          // Google exposes the video link in three different places depending
          // on how the event was created; none of them were being read, so the
          // only link Lumi ever saw was one the organiser happened to type
          // into `location` — where it then got treated as an address.
          meetingUrl:
            item.hangoutLink
            || (item.conferenceData?.entryPoints || [])
              .find((e: any) => e.entryPointType === 'video')?.uri
            || meetingUrlFromEvent(item.location, item.description),
          attendees: (item.attendees || [])
            .map((a: any) => a.email)
            .filter(Boolean),
          organizer: item.organizer?.email,
        }));
      return { events, allDay };
    } catch (e) {
      const reason = `network: ${String((e as Error)?.message || e).slice(0, 200)}`;
      console.warn('[Google] calendar fetch threw', date, reason);
      return { events: [], error: reason };
    }
  },

  /**
   * The LAST time she met these people: calendar events before `beforeDate`
   * whose attendees include one of `addresses`, or that carry the same title.
   *
   * 18.10, Koral: a brief has to say who the call is with AND a summary of the
   * previous meeting if there was one. Read here, on the phone, with her own
   * token; at most two events leave it, as title + date + the notes the event
   * carries (its description, cut). A failure says why (rule 1) — an earlier
   * meeting that could not be looked up must not read as "there was none".
   */
  async previousMeetingsWith(
    addresses: string[], title: string, beforeDate: string, account?: string,
  ): Promise<{ meetings: Array<{ date: string; title: string; notes: string }>; error?: string }> {
    const token = await this.getToken(account);
    if (!token) return { meetings: [], error: 'not_connected' };
    const who = addresses.map((a) => String(a || '').trim().toLowerCase()).filter((a) => a.includes('@'));
    const sameTitle = String(title || '').trim().toLowerCase();
    if (!who.length && !sameTitle) return { meetings: [] };
    try {
      const [y, m, d] = beforeDate.split('-').map(Number);
      const to = new Date(y, m - 1, d, 0, 0, 0, 0);
      const from = new Date(to.getTime() - 120 * 24 * 60 * 60 * 1000);
      const params = new URLSearchParams({
        timeMin: from.toISOString(), timeMax: to.toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      });
      if (who[0]) params.set('q', who[0]);
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const reason = `http_${res.status}: ${String(data?.error?.message || 'no response body').slice(0, 160)}`;
        console.warn('[Google] previous meetings lookup failed', reason);
        return { meetings: [], error: reason };
      }
      const hits = (data.items || [])
        .filter((e: any) => e.start?.dateTime && e.status !== 'cancelled')
        .filter((e: any) => {
          const guests = (e.attendees || []).map((a: any) => String(a.email || '').toLowerCase());
          return who.some((w) => guests.includes(w))
            || (sameTitle && String(e.summary || '').trim().toLowerCase() === sameTitle);
        })
        .slice(-2)
        .map((e: any) => ({
          date: String(e.start.dateTime).slice(0, 10),
          title: String(e.summary || '').slice(0, 120),
          // The invitation's own text is not "what was said", but it is all the
          // calendar holds; the server says "no notes" when it is empty.
          notes: String(e.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600),
        }));
      return { meetings: hits };
    } catch (e) {
      const reason = `network: ${String((e as Error)?.message || e).slice(0, 160)}`;
      console.warn('[Google] previous meetings lookup threw', reason);
      return { meetings: [], error: reason };
    }
  },

  /**
   * One event, by the id its task carries (`calendarEventId`), with everything
   * the calendar holds: link, guests, description, join link, attachments.
   * Asked of each calendar-enabled account in turn — a task does not record
   * which one it came from. Read live, never stored (utils/eventDetails). A
   * failure says why (rule 1): "not found" and "could not ask" are different.
   */
  async getEventDetails(eventId: string): Promise<{ details?: EventDetails; error?: string }> {
    const hit = eventCache.get(eventId);
    if (hit && Date.now() - hit.at < EVENT_TTL_MS) return { details: hit.details };
    const all = (await this.listGoogleAccounts()).filter((a) => a.calendar);
    if (!all.length) return { error: 'not_connected' };
    // The account that answered last time goes first: one GET, not one per account.
    const known = eventAnsweredBy.get(eventId);
    const accounts = [...all].sort((x, y) => Number(y.email === known) - Number(x.email === known));
    let lastError = 'not_found';
    for (const acct of accounts) {
      const token = await this.getToken(acct.email || undefined);
      if (!token) { lastError = 'not_connected'; continue; }
      try {
        // A hung request must not hold the spinner (and the radio) for ever.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 10000);
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?supportsAttachments=true`,
          { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal },
        ).finally(() => clearTimeout(timer));
        if (res.status === 404) continue;
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) {
          lastError = `http_${res.status}: ${String(data?.error?.message || 'no response body').slice(0, 160)}`;
          console.warn('[Google] event details lookup failed', lastError);
          continue;
        }
        eventAnsweredBy.set(eventId, acct.email);
        const details = eventDetailsFromGoogle(data);
        eventCache.set(eventId, { details, at: Date.now() });
        return { details };
      } catch (e) {
        lastError = `network: ${String((e as Error)?.message || e).slice(0, 160)}`;
        console.warn('[Google] event details lookup threw', lastError);
      }
    }
    return { error: lastError };
  },

  /** One local day's events, array only — for callers that cannot act on a failure. */
  async getCalendarEventsToday(date: string): Promise<CalendarEvent[]> {
    return (await this.fetchCalendarEvents(date)).events;
  },

  /**
   * Create an event on the user's primary calendar. Returns the new event id,
   * or null when not connected / the grant predates the calendar.events scope
   * (403) — callers keep the local task either way.
   * `date` is YYYY-MM-DD, `startTime`/`endTime` are HH:MM local.
   */
  async createCalendarEvent(
    title: string,
    date: string,
    startTime: string,
    durationMinutes = 60,
    location?: string,
    /** Which of her accounts' calendar; the first account when omitted. */
    account?: string,
  ): Promise<string | null> {
    const token = await this.getToken(account);
    if (!token) return null;
    try {
      const start = new Date(`${date}T${startTime}:00`);
      const end = new Date(start.getTime() + durationMinutes * 60_000);
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        + `T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
      // Local wall-clock + the device time zone: Google resolves the offset.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jerusalem';
      const res = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: title,
            location,
            start: { dateTime: iso(start), timeZone },
            end: { dateTime: iso(end), timeZone },
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        console.log('[Google] calendar insert failed:', data?.error?.message);
        return null;
      }
      return data.id || null;
    } catch (e) {
      console.log('[Google] calendar insert error:', e);
      return null;
    }
  },

  async searchGmailForTask(keywords: string): Promise<{ threadId: string; subject: string; sender: string; snippet: string } | null> {
    if (!GMAIL_ENABLED) return null;   // off in this build (utils/gmailAccess), never "not found"
    const token = await this.getToken();
    if (!token) return null;
    try {
      const q = encodeURIComponent(keywords);
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=3`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      if (!data.messages?.[0]) return null;
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${data.messages[0].id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const msg = await msgRes.json();
      const headers = msg.payload?.headers || [];
      return {
        threadId: msg.threadId,
        subject: headers.find((h: any) => h.name === 'Subject')?.value || '',
        sender: headers.find((h: any) => h.name === 'From')?.value || '',
        snippet: msg.snippet || '',
      };
    } catch { return null; }
  },

  /**
   * What she and this person have already said to each other.
   *
   * Koral, 2026-09-17: "collect data from Gmail — if they had a conversation
   * there, remind what they talked about."
   *
   * Walking into a call having forgotten the last exchange is the specific
   * thing this fixes, and it is the half of a briefing the web cannot supply:
   * Tavily knows what Ceva does, only her mailbox knows what she and this
   * person already agreed.
   *
   * THE MAILBOX NEVER LEAVES THE PHONE WHOLE. This asks for messages with ONE
   * named correspondent, takes at most `max` of them, and returns the subject
   * and Gmail's own snippet — never the body. What the caller then sends to
   * the server is a handful of lines about one thread, which is the minimum
   * that can answer "what did we talk about".
   *
   * Returns [] for every failure, including no token: a brief without history
   * is still a brief.
   */
  async gmailHistoryWith(
    email: string, max = 4,
    /** Which of her mailboxes; the first account when omitted. */
    account?: string,
  ): Promise<Array<{ date: string; subject: string; from: string; snippet: string }>> {
    if (!GMAIL_ENABLED) return [];   // off in this build; the brief simply carries no mail history
    const token = await this.getToken(account);
    const address = (email || '').trim();
    if (!token || !address.includes('@')) return [];
    try {
      // Both directions: what they wrote and what she answered.
      const q = encodeURIComponent(`from:${address} OR to:${address}`);
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${max}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await res.json();
      const messages: Array<{ id: string }> = data.messages || [];
      const out: Array<{ date: string; subject: string; from: string; snippet: string }> = [];
      for (const m of messages.slice(0, max)) {
        // metadata format: headers and the snippet, never the body.
        const detail = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`
          + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date',
          { headers: { Authorization: `Bearer ${token}` } },
        ).then((r) => r.json()).catch(() => null);
        if (!detail) continue;
        const headers = detail.payload?.headers || [];
        const header = (n: string) => headers.find((h: any) => h.name === n)?.value || '';
        out.push({
          date: header('Date'),
          subject: header('Subject'),
          from: header('From'),
          snippet: String(detail.snippet || '').slice(0, 300),
        });
      }
      return out;
    } catch (e) {
      console.warn('[Google] gmail history lookup failed', e);
      return [];
    }
  },

  /**
   * Tight, event-focused inbox scan (recent days, keyword-filtered, max 10)
   * for calendar-like emails: reservations, appointments, interviews, invites.
   * Deliberately NOT a full inbox crawl — see plan constraint (memory/latency).
   */
  async scanGmailForEvents(account?: string): Promise<{ id: string; threadId: string; subject: string; sender: string; snippet: string }[]> {
    if (!GMAIL_ENABLED) return [];   // off in this build; callers say so via GMAIL_ENABLED
    const token = await this.getToken(account);
    if (!token) return [];
    try {
      const q = encodeURIComponent(
        'newer_than:7d (reservation OR confirmation OR confirmed OR appointment OR invitation OR interview OR "הזמנה" OR "אישור" OR "תור" OR "ראיון" OR "פגישה")',
      );
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=10`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await res.json();
      const messages: { id: string }[] = data.messages || [];
      const out: { id: string; threadId: string; subject: string; sender: string; snippet: string }[] = [];
      for (const m of messages) {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const msg = await msgRes.json();
        const headers = msg.payload?.headers || [];
        out.push({
          id: m.id,
          threadId: msg.threadId || m.id,
          subject: headers.find((h: any) => h.name === 'Subject')?.value || '',
          sender: headers.find((h: any) => h.name === 'From')?.value || '',
          snippet: msg.snippet || '',
        });
      }
      return out;
    } catch (e) {
      console.log('[Google] gmail event scan failed:', e);
      return [];
    }
  },

  // ── Routing: delegated to RoutePlanner (no expo deps, testable in node) ──
  getTransitPlan: RoutePlanner.getTransitPlan,
  getTransitPlans: RoutePlanner.getTransitPlans,
  getTransitAlternatives: RoutePlanner.getTransitAlternatives,
  getPlanForMode: RoutePlanner.getPlanForMode,
  // The same two lookups, carrying WHY they came back empty. New code uses
  // these: the array/null pair above cannot tell a refused API key from a
  // destination with no bus, and the app spent 107 rejected Directions calls
  // telling her the second thing while the first was happening.
  transitAlternatives: RoutePlanner.transitAlternatives,
  transitAlternativesMulti: RoutePlanner.transitAlternativesMulti,
  planForMode: RoutePlanner.planForMode,
  getDepartNowPlan: RoutePlanner.getDepartNowPlan,
  getDepartNowOptions: RoutePlanner.getDepartNowOptions,
  getNeighbourDeparture: RoutePlanner.getNeighbourDeparture,
  compareModes: RoutePlanner.compareModes,
  searchPlaces: RoutePlanner.searchPlaces,

  async getCarDriveTime(destination: string, userProfile: UserProfile, date: string): Promise<TransitPlan | null> {
    // ponytail: kept as a shim — everything routes through getPlanForMode now.
    return RoutePlanner.getPlanForMode('car', destination, '09:00', userProfile, date);
  },
};
