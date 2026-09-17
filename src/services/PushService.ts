/**
 * PushService — obtains this device's Expo push token and registers it with
 * the backend (POST /push/register) keyed by the user's WhatsApp phone, so
 * server-side reminders also arrive as phone notifications.
 *
 * Dependencies: expo-notifications + expo-constants (EAS projectId — returns
 * null in Expo Go), EXPO_PUBLIC_SERVER_URL. Server counterparts:
 * server/main.py /push/register, server/push.py, server/reminders.py.
 */
import Constants from 'expo-constants';
import { isExpoGo } from '../utils/isExpoGo';

type NotificationsModule = typeof import('expo-notifications');

let Notifications: NotificationsModule | null = null;
try {
  Notifications = require('expo-notifications') as NotificationsModule;
} catch {
  Notifications = null;
}

import { authedFetch } from './serverAuth';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

/** Get this device's Expo push token, or null (Expo Go, denied permission, or no projectId yet). */
export async function getPushToken(): Promise<string | null> {
  if (isExpoGo || !Notifications) return null; // Expo Go can't receive push (SDK 53+)
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
  if (!projectId || projectId === 'placeholder') return null; // needs a real EAS project first
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return null;
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data;
  } catch (e) {
    console.warn('[Push] getPushToken failed', e);
    return null;
  }
}

/**
 * Confirm the phone → account link resolves SERVER-side, and release anything
 * queued while it didn't.
 *
 * Tasks created over WhatsApp before the number was linked sit in the server's
 * pending_mirror queue, because upsert_task cannot know which Supabase user
 * they belong to. Hitting /link/verify resolves the phone and flushes them.
 * The server has always exposed this — the app simply never called it, so the
 * backlog only drained by accident on the next inbound WhatsApp message.
 *
 * Returns how many tasks were released, or null if the link still doesn't
 * resolve (so the caller can say so honestly instead of claiming success).
 */
export async function verifyPhoneLink(phone: string): Promise<number | null> {
  const clean = (phone || '').replace(/[^\d]/g, '');
  if (!SERVER_URL || !clean) return null;
  try {
    const res = await authedFetch(`${SERVER_URL}/link/verify/${clean}`);
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data?.linked ? Number(data.flushed ?? 0) : null;
  } catch (e) {
    console.warn('[Push] verifyPhoneLink failed', e);
    return null;
  }
}

/** Link this device's push token to the user's WhatsApp number on the server. */
export async function registerPush(phone: string): Promise<boolean> {
  const clean = (phone || '').replace(/[^\d]/g, '');
  if (!SERVER_URL || !clean) return false;
  const token = await getPushToken();
  if (!token) return false;
  try {
    // The server takes the phone from the verified token; `phone` is sent only
    // for backward compatibility and is checked for ownership, not trusted.
    const res = await authedFetch(`${SERVER_URL}/push/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: clean, expo_push_token: token }),
    });
    return !!res && res.ok;
  } catch (e) {
    console.warn('[Push] registerPush failed', e);
    return false;
  }
}
