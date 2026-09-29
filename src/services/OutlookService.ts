/**
 * OutlookService — Outlook / Microsoft 365 calendar and Teams meetings,
 * through Microsoft Graph, read on the phone with her own token.
 *
 * WHY THIS AND NOT ONLY THE PHONE'S CALENDARS: DeviceCalendarSync already
 * reads Outlook when the Outlook app syncs into Android's calendar. A work
 * account often cannot (company policy blocks the sync, or there is no Outlook
 * app on a personal phone), and the phone database drops what Graph keeps:
 * the Teams join link (`onlineMeeting.joinUrl`) and the organiser. So an
 * Outlook invitation for a Teams call arrives as a remote meeting with its
 * link — no journey, no wake alarm for a sofa — and an in-person one arrives
 * with its venue, a route and a leave time.
 *
 * Same privacy bargain as Google: PKCE public client, no secret anywhere, the
 * token in SecureStore, the mailbox never leaves the phone. Scopes are
 * read-only (Calendars.Read). The client id is PUBLIC by construction
 * (EXPO_PUBLIC_MS_CLIENT_ID, an Azure "Mobile and desktop" app registration
 * with redirect `lumi://outlook`); without it this reports `not_configured`
 * in words instead of offering a button that cannot work (rule 3).
 *
 * Triggers: none of its own — CalendarAutoSync runs it with the rest (rule 7).
 */
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { importCalendarTasks } from './GoogleSync';
import { calendarEventToTask } from '../utils/calendarEventTask';
import { graphEventToCalendarEvent } from '../utils/graphEvent';
import { getTodayString } from '../utils/timeUtils';
import type { AppLanguage, Task } from '../types/index';

WebBrowser.maybeCompleteAuthSession();

const CLIENT_ID = process.env.EXPO_PUBLIC_MS_CLIENT_ID || '';
const AUTHORITY = 'https://login.microsoftonline.com/common/v2.0';
const SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Calendars.Read'];
const TOKEN_KEY = 'ms_tokens';
const LAST_RESULT_KEY = 'meira.outlook.last.v1';
const SYNC_DAYS = 30;

interface StoredTokens { accessToken: string; refreshToken?: string; expiresAt: number; account?: string }

export type OutlookFailure =
  | 'not_configured'
  | 'not_connected'
  | 'cancelled'
  | 'reconnect'
  | `http_${number}: ${string}`
  | `network: ${string}`;

export interface OutlookSyncResult {
  ok: boolean;
  added: number;
  events: number;
  account?: string;
  error?: OutlookFailure;
  at: number;
}

export function outlookConfigured(): boolean {
  return Boolean(CLIENT_ID);
}

function redirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: 'lumi', path: 'outlook' });
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[Outlook] token store unreadable', e);
    return null;
  }
}

async function saveTokens(t: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(t));
}

export async function outlookConnected(): Promise<boolean> {
  return Boolean(await loadTokens());
}

/** The signed-in account ("koral@company.com"), for the Menu row. */
export async function outlookAccount(): Promise<string | null> {
  return (await loadTokens())?.account ?? null;
}

export async function lastOutlookResult(): Promise<OutlookSyncResult | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_RESULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    console.warn('[Outlook] last result unreadable');
    return null;
  }
}

export async function signInWithMicrosoft(): Promise<{ ok: boolean; account?: string; error?: OutlookFailure }> {
  if (!CLIENT_ID) return { ok: false, error: 'not_configured' };
  try {
    const discovery = await AuthSession.fetchDiscoveryAsync(AUTHORITY);
    const uri = redirectUri();
    const request = new AuthSession.AuthRequest({
      clientId: CLIENT_ID,
      scopes: SCOPES,
      redirectUri: uri,
      extraParams: { prompt: 'select_account' },
    });
    const result = await request.promptAsync(discovery);
    if (result.type !== 'success' || !result.params?.code) {
      return { ok: false, error: result.type === 'success' ? `http_400: ${result.params?.error_description || 'no code'}` : 'cancelled' };
    }
    const tokens = await AuthSession.exchangeCodeAsync(
      {
        clientId: CLIENT_ID,
        code: result.params.code,
        redirectUri: uri,
        extraParams: { code_verifier: request.codeVerifier || '' },
      },
      discovery,
    );
    const account = await whoAmI(tokens.accessToken);
    await saveTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      account: account ?? undefined,
    });
    return { ok: true, account: account ?? undefined };
  } catch (e) {
    const why = String((e as Error)?.message || e).slice(0, 160);
    console.warn('[Outlook] sign-in failed', why);
    return { ok: false, error: `network: ${why}` };
  }
}

export async function signOutMicrosoft(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch((e) => console.warn('[Outlook] sign-out failed', e));
  await AsyncStorage.removeItem(LAST_RESULT_KEY).catch(() => {});
}

async function whoAmI(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = await res.json().catch(() => null);
    return me?.mail || me?.userPrincipalName || null;
  } catch (e) {
    console.warn('[Outlook] /me failed', e);
    return null;
  }
}

/** A live access token, refreshed when due. null = she must sign in again. */
async function token(): Promise<string | null> {
  const t = await loadTokens();
  if (!t) return null;
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken) return null;
  try {
    const discovery = await AuthSession.fetchDiscoveryAsync(AUTHORITY);
    const r = await AuthSession.refreshAsync(
      { clientId: CLIENT_ID, refreshToken: t.refreshToken, scopes: SCOPES },
      discovery,
    );
    await saveTokens({
      ...t,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ?? t.refreshToken,
      expiresAt: Date.now() + (r.expiresIn ?? 3600) * 1000,
    });
    return r.accessToken;
  } catch (e) {
    console.warn('[Outlook] refresh failed — she needs to sign in again', e);
    return null;
  }
}

/** Graph's calendarView for a window, every page. Occurrences are expanded. */
async function calendarView(accessToken: string, from: Date, to: Date): Promise<{ items: any[]; error?: OutlookFailure }> {
  const select = 'id,subject,start,end,location,bodyPreview,isAllDay,isCancelled,onlineMeeting,onlineMeetingUrl,organizer,attendees,responseStatus';
  let url: string | null = 'https://graph.microsoft.com/v1.0/me/calendarView'
    + `?startDateTime=${encodeURIComponent(from.toISOString())}`
    + `&endDateTime=${encodeURIComponent(to.toISOString())}`
    + `&$select=${select}&$top=100&$orderby=start/dateTime`;
  const items: any[] = [];
  try {
    for (let page = 0; url && page < 10; page++) {
      // Times come back in UTC unless asked otherwise; graphEvent parses them as UTC.
      const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data: any = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const detail = String(data?.error?.message || 'no response body').slice(0, 160);
        return { items, error: res.status === 401 ? 'reconnect' : `http_${res.status}: ${detail}` };
      }
      items.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
    return { items };
  } catch (e) {
    return { items, error: `network: ${String((e as Error)?.message || e).slice(0, 160)}` };
  }
}

/** Read the month ahead from Outlook and land it. Never throws. */
export async function syncOutlook(lang: AppLanguage, days = SYNC_DAYS): Promise<OutlookSyncResult> {
  const finish = async (r: Omit<OutlookSyncResult, 'at'>): Promise<OutlookSyncResult> => {
    const out = { ...r, at: Date.now() };
    await AsyncStorage.setItem(LAST_RESULT_KEY, JSON.stringify(out)).catch(() => {});
    if (out.error && out.error !== 'not_connected') console.warn('[Outlook] sync:', out.error);
    return out;
  };
  if (!CLIENT_ID) return { ok: false, added: 0, events: 0, error: 'not_configured', at: Date.now() };
  const stored = await loadTokens();
  if (!stored) return { ok: false, added: 0, events: 0, error: 'not_connected', at: Date.now() };
  const access = await token();
  if (!access) return finish({ ok: false, added: 0, events: 0, account: stored.account, error: 'reconnect' });

  const [y, m, d] = getTodayString().split('-').map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + days, 23, 59, 59, 999);
  const { items, error } = await calendarView(access, from, to);
  if (error) return finish({ ok: false, added: 0, events: items.length, account: stored.account, error });

  const tasks: Task[] = [];
  for (const it of items) {
    const mapped = graphEventToCalendarEvent(it);
    if (mapped) tasks.push(calendarEventToTask(mapped.event, mapped.date, 'outlook', { calendarName: 'Outlook' }));
  }
  try {
    const added = tasks.length ? await importCalendarTasks(tasks, lang, 'outlook') : 0;
    console.warn(`[Outlook] ${items.length} event(s) → ${added} added/corrected`);
    return finish({ ok: true, added, events: items.length, account: stored.account });
  } catch (e) {
    return finish({ ok: false, added: 0, events: items.length, account: stored.account,
      error: `network: import ${String((e as Error)?.message || e).slice(0, 120)}` });
  }
}
