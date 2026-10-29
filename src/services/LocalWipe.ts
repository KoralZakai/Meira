/**
 * LocalWipe — signing out leaves nothing of her on the phone (7.10 audit).
 *
 * Sign-out used to end only the Supabase session: her tasks, home address,
 * places, chat, Gmail events, the Google/Outlook tokens and every scheduled
 * alert stayed on the device for whoever used it next. Account deletion
 * cleared AsyncStorage but never SecureStore (home address, calendar tokens)
 * nor the scheduled notifications.
 *
 * wipeDevice() removes, in order:
 *   1. every scheduled notification (they carry task text and destinations);
 *   2. every SecureStore entry the app writes — Google and Outlook tokens per
 *      account, the account lists, the home address, the storage key;
 *   3. every stored value (EncryptedStorage.clear also drops its key, so any
 *      copy of the old ciphertext is unreadable).
 * Each step is independent: one failing must not leave the rest in place.
 * Returns the steps that failed, never a silent "done" (silent-state rule 3).
 *
 * NOT removable from here: alarms already handed to the Clock app (Android
 * gives apps no way to delete them). Their label is "Meira · HH:MM" — no task
 * text — since this same audit (AlarmService).
 */
import EncryptedStorage, { STORAGE_KEY_NAME } from './EncryptedStorage';
import { DATA_KEY_NAME, forgetDataKey } from './DataKey';

const FIXED_SECURE_KEYS = [
  'google_tokens', 'google_access_token', 'google_accounts',
  'ms_tokens', 'ms_accounts',
  'lumi_home_sensitive',
];

async function secureStore() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('expo-secure-store') as typeof import('expo-secure-store');
}

async function accountKeys(listKey: string, prefix: string, field: 'email' | 'account'): Promise<string[]> {
  const SecureStore = await secureStore();
  const raw = await SecureStore.getItemAsync(listKey).catch(() => null);
  if (!raw) return [];
  try {
    const list = (JSON.parse(raw)?.accounts ?? []) as Array<Record<string, string>>;
    return list.map((a) => a.key || (a[field]
      ? `${prefix}.${a[field].trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_')}` : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function wipeDevice(): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Notifications = require('expo-notifications');
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.dismissAllNotificationsAsync?.();
  } catch (e) {
    console.warn('[LocalWipe] notifications not cleared', e);
    failed.push('notifications');
  }

  try {
    const SecureStore = await secureStore();
    const keys = new Set([
      ...FIXED_SECURE_KEYS,
      DATA_KEY_NAME,
      ...(await accountKeys('google_accounts', 'google_tokens', 'email')),
      ...(await accountKeys('ms_accounts', 'ms_tokens', 'account')),
    ]);
    for (const k of keys) {
      await SecureStore.deleteItemAsync(k).catch((e) => {
        console.warn('[LocalWipe] secure key not removed', k, e);
        failed.push(`secure:${k}`);
      });
    }
  } catch (e) {
    console.warn('[LocalWipe] secure store not cleared', e);
    failed.push('secure-store');
  }

  await forgetDataKey();
  try {
    await EncryptedStorage.clear(); // values AND the storage key (STORAGE_KEY_NAME)
  } catch (e) {
    console.warn('[LocalWipe] storage not cleared', e);
    failed.push('storage');
  }
  void STORAGE_KEY_NAME;

  return { ok: failed.length === 0, failed };
}
