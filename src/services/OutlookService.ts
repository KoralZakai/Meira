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
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)

import { importCalendarTasks, noteCancellationsFor } from './GoogleSync';
import { datesAhead } from '../utils/cancelledEvents';
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

// ── Several Microsoft accounts (6.10: "many accounts of the same kind") ─────
// One token per account under its own SecureStore key, listed in ACCOUNTS_KEY.
// A second sign-in used to replace the first account; now the same address
// replaces its own token and a new one is added. An older build's single
// `ms_tokens` becomes the first account in place.
const ACCOUNTS_KEY = 'ms_accounts';

interface OutlookAccountRef { account: string; key: string }

const sameAccount = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
const keyForAccount = (account: string) => `ms_tokens.${account.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`;

async function readTokens(key: string): Promise<StoredTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[Outlook] token store unreadable', e);
    return null;
  }
}

async function writeTokens(key: string, t: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(t));
}

async function saveAccounts(list: OutlookAccountRef[]): Promise<void> {
  await SecureStore.setItemAsync(ACCOUNTS_KEY, JSON.stringify({ accounts: list }));
}

async function loadAccounts(): Promise<OutlookAccountRef[]> {
  try {
    const raw = await SecureStore.getItemAsync(ACCOUNTS_KEY);
    if (raw) return JSON.parse(raw).accounts ?? [];
  } catch (e) {
    console.warn('[Outlook] accounts list unreadable', e);
  }
  const legacy = await readTokens(TOKEN_KEY);
  if (!legacy) return [];
  const first = { account: legacy.account || '', key: TOKEN_KEY };
  await saveAccounts([first]).catch((e) => console.warn('[Outlook] accounts list not saved', e));
  return [first];
}

export async function outlookConnected(): Promise<boolean> {
  return (await loadAccounts()).length > 0;
}

/** The first signed-in account ("koral@company.com"), for one-line summaries. */
export async function outlookAccount(): Promise<string | null> {
  return (await loadAccounts())[0]?.account || null;
}

/** Every Microsoft account she connected. */
export async function outlookAccounts(): Promise<string[]> {
  return (await loadAccounts()).map((a) => a.account);
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
    const fresh: StoredTokens = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      account: account ?? undefined,
    };
    // The same address replaces its own token; a new address is a new account.
    const list = await loadAccounts();
    let ref = account ? list.find((a) => sameAccount(a.account, account)) : undefined;
    if (!ref && !account && list.length === 1 && !list[0].account) ref = list[0];
    if (!ref) {
      ref = { account: account || '', key: account ? keyForAccount(account) : `ms_tokens.added_${Date.now()}` };
      list.push(ref);
    } else if (account) {
      ref.account = account;
    }
    await writeTokens(ref.key, fresh);
    await saveAccounts(list);
    return { ok: true, account: account ?? undefined };
  } catch (e) {
    const why = String((e as Error)?.message || e).slice(0, 160);
    console.warn('[Outlook] sign-in failed', why);
    return { ok: false, error: `network: ${why}` };
  }
}

/** Disconnect one account (by address), or every account when none is named. */
export async function signOutMicrosoft(account?: string): Promise<void> {
  const list = await loadAccounts();
  const gone = account === undefined ? list : list.filter((a) => sameAccount(a.account, account) || (!account && !a.account));
  for (const ref of gone) {
    await SecureStore.deleteItemAsync(ref.key).catch((e) => console.warn('[Outlook] sign-out failed', e));
  }
  await saveAccounts(list.filter((a) => !gone.includes(a))).catch((e) => console.warn('[Outlook] accounts list not saved', e));
  if (gone.length === list.length) await AsyncStorage.removeItem(LAST_RESULT_KEY).catch(() => {});
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

/** A live access token for one account, refreshed when due. null = she must sign in again. */
async function token(ref: OutlookAccountRef): Promise<string | null> {
  const t = await readTokens(ref.key);
  if (!t) return null;
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken) return null;
  try {
    const discovery = await AuthSession.fetchDiscoveryAsync(AUTHORITY);
    const r = await AuthSession.refreshAsync(
      { clientId: CLIENT_ID, refreshToken: t.refreshToken, scopes: SCOPES },
      discovery,
    );
    await writeTokens(ref.key, {
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

/** Read the month ahead from every Outlook account and land it. Never throws.
 *  Each account fails on its own; the result names which (rule 1). */
export async function syncOutlook(lang: AppLanguage, days = SYNC_DAYS): Promise<OutlookSyncResult> {
  const finish = async (r: Omit<OutlookSyncResult, 'at'>): Promise<OutlookSyncResult> => {
    const out = { ...r, at: Date.now() };
    await AsyncStorage.setItem(LAST_RESULT_KEY, JSON.stringify(out)).catch(() => {});
    if (out.error && out.error !== 'not_connected') console.warn('[Outlook] sync:', out.error);
    return out;
  };
  if (!CLIENT_ID) return { ok: false, added: 0, events: 0, error: 'not_configured', at: Date.now() };
  const list = await loadAccounts();
  if (!list.length) return { ok: false, added: 0, events: 0, error: 'not_connected', at: Date.now() };

  const [y, m, d] = getTodayString().split('-').map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + days, 23, 59, 59, 999);
  const tasks: Task[] = [];
  let events = 0;
  let firstError: OutlookFailure | undefined;
  const names = list.map((a) => a.account).filter(Boolean).join(', ') || undefined;
  for (const ref of list) {
    const access = await token(ref);
    if (!access) {
      firstError = firstError ?? 'reconnect';
      continue;
    }
    const { items, error } = await calendarView(access, from, to);
    events += items.length;
    if (error) {
      firstError = firstError ?? error;
      continue;
    }
    for (const it of items) {
      const mapped = graphEventToCalendarEvent(it);
      // Labelled with the account it came from, not a hardcoded "Outlook".
      if (mapped) tasks.push(calendarEventToTask(mapped.event, mapped.date, 'outlook', { calendarName: ref.account || 'Outlook' }));
    }
  }
  try {
    // Every account answered: what Outlook no longer lists was cancelled (strictly — see cancelledEvents).
    if (!firstError) {
      await noteCancellationsFor('ocal-', datesAhead(getTodayString(), days), new Set(tasks.map((t) => t.id)),
        list.map((a) => a.account || '').sort().join('|'), tasks);
    }
    const added = tasks.length ? await importCalendarTasks(tasks, lang, 'outlook') : 0;
    console.warn(`[Outlook] ${events} event(s) from ${list.length} account(s) → ${added} added/corrected`);
    return finish({ ok: !firstError, added, events, account: names, ...(firstError ? { error: firstError } : {}) });
  } catch (e) {
    return finish({ ok: false, added: 0, events, account: names,
      error: `network: import ${String((e as Error)?.message || e).slice(0, 120)}` });
  }
}
