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
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { UserProfile, CalendarEvent, TransitPlan, TransportType } from '../types/index';
import * as RoutePlanner from './RoutePlanner';
import { extractMeetingUrl } from '../utils/meetingLink';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  // Write scope: accepting an emailed appointment puts it on the real calendar
  // (createCalendarEvent). Tokens granted before this scope existed keep working
  // for reads and simply fail the insert — the local task is created either way.
  'https://www.googleapis.com/auth/calendar.events',
];

// OAuth client id: the Android-specific id when present (EAS env), else the generic one.
const OAUTH_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_ANDROID ||
  process.env.EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || '';

/** SecureStore key holding {accessToken, refreshToken?, expiresAt} as JSON. */
const TOKEN_STORE_KEY = 'google_tokens';

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

async function loadStoredTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(TOKEN_STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch { return null; }
}

async function saveStoredTokens(t: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_STORE_KEY, JSON.stringify(t));
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
        extraParams: { access_type: 'offline', prompt: 'consent' },
      });
      const result = await request.promptAsync(discovery);
      if (result.type !== 'success' || !result.params?.code) return false;
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
      await saveStoredTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      });
      return true;
    } catch (e) {
      console.log('[Google] Auth error:', e);
      return false;
    }
  },

  /** True when a Google token is stored (i.e. the user connected their account). */
  async isGoogleConnected(): Promise<boolean> {
    if (await loadStoredTokens()) return true;
    // Legacy single-token storage from older builds.
    return Boolean(await SecureStore.getItemAsync('google_access_token'));
  },

  async getToken(): Promise<string | null> {
    const stored = await loadStoredTokens();
    if (!stored) return SecureStore.getItemAsync('google_access_token'); // legacy fallback
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
        };
        await saveStoredTokens(next);
        return next.accessToken;
      } catch (e) {
        console.log('[Google] token refresh failed:', e);
        return stored.accessToken; // let the API call fail loudly if truly dead
      }
    }
    return stored.accessToken;
  },

  /**
   * One local day's events.
   *
   * The window used to be sent as `${date}T00:00:00Z` – `T23:59:59Z`, i.e. UTC.
   * In Israel (UTC+3) that asks Google for 03:00 today → 02:59 TOMORROW, so
   * anything before 03:00 was never returned and late-night events landed on
   * the wrong day. The bounds are built from local midnight now and carry a
   * real offset, so "today" means the user's today.
   */
  async getCalendarEventsToday(date: string): Promise<CalendarEvent[]> {
    const token = await this.getToken();
    if (!token) return [];
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
      const data = await res.json();

      // Google returns an offset-bearing RFC-3339 string ("…T11:00:00+03:00"),
      // and slicing characters 11–16 off it only worked while that offset
      // happened to match the phone. Parse it and read the local clock instead.
      const hhmm = (dt?: string): string | null => {
        if (!dt) return null;
        const parsed = new Date(dt);
        if (Number.isNaN(parsed.getTime())) return null;
        return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
      };

      return (data.items || [])
        // An all-day event has `start.date` and no `start.dateTime`. It has no
        // clock time at all, so giving it 00:00 would invent a midnight
        // appointment — and then a wake alarm for it. Skipped.
        .filter((item: any) => item.start?.dateTime && item.status !== 'cancelled')
        .map((item: any) => ({
          id: item.id,
          title: item.summary,
          startTime: hhmm(item.start?.dateTime) || '00:00',
          endTime: hhmm(item.end?.dateTime) || '00:00',
          location: item.location,
          description: item.description,
          // Google exposes the video link in three different places depending
          // on how the event was created; none of them were being read, so the
          // only link Lumi ever saw was one the organiser happened to type
          // into `location` — where it then got treated as an address.
          meetingUrl:
            item.hangoutLink
            || (item.conferenceData?.entryPoints || [])
              .find((e: any) => e.entryPointType === 'video')?.uri
            || extractMeetingUrl(item.location, item.description),
          attendees: (item.attendees || [])
            .map((a: any) => a.email)
            .filter(Boolean),
          organizer: item.organizer?.email,
        }));
    } catch { return []; }
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
  ): Promise<string | null> {
    const token = await this.getToken();
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
  ): Promise<Array<{ date: string; subject: string; from: string; snippet: string }>> {
    const token = await this.getToken();
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
  async scanGmailForEvents(): Promise<{ id: string; threadId: string; subject: string; sender: string; snippet: string }[]> {
    const token = await this.getToken();
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
  getDepartNowPlan: RoutePlanner.getDepartNowPlan,
  getDepartNowOptions: RoutePlanner.getDepartNowOptions,
  compareModes: RoutePlanner.compareModes,
  searchPlaces: RoutePlanner.searchPlaces,

  async getCarDriveTime(destination: string, userProfile: UserProfile, date: string): Promise<TransitPlan | null> {
    // ponytail: kept as a shim — everything routes through getPlanForMode now.
    return RoutePlanner.getPlanForMode('car', destination, '09:00', userProfile, date);
  },
};
