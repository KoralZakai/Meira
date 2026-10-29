/**
 * DataKey — the key that seals THIS account's rows in Supabase (7.10).
 *
 * tasks and user_profiles held what she will do, where, with whom, and her home
 * address in plaintext columns. The personal fields now travel as ONE sealed
 * blob (supabaseRepo: sealTaskRow / sealProfileRow) under a key the server
 * derives for her verified account (POST /app/data-key, server/field_crypto).
 * The server opens the same rows with the same key, so WhatsApp and the app
 * still see one list.
 *
 * Kept in SecureStore (Android Keystore) with the account it belongs to; a
 * different account signing in never gets the previous one's key. While the
 * server says {enabled:false} (SEAL_APP_ROWS=0) the answer is null and rows are
 * written as before — asked again after DISABLED_RETRY_MS.
 */
import { fromBase64 } from './EncryptedStorage';
import { getDataKeyFromServer } from './LumiServer';

export const DATA_KEY_NAME = 'meira.datakey.v1';
const DISABLED_RETRY_MS = 10 * 60_000;

let memo: { userId: string; key: Uint8Array | null; at: number } | null = null;

type Store = { get(n: string): Promise<string | null>; set(n: string, v: string): Promise<void>; remove(n: string): Promise<void> };
/* eslint-disable @typescript-eslint/no-var-requires */
let store: Store = {
  get: (n) => require('expo-secure-store').getItemAsync(n),
  set: (n, v) => require('expo-secure-store').setItemAsync(n, v),
  remove: (n) => require('expo-secure-store').deleteItemAsync(n),
};
/* eslint-enable @typescript-eslint/no-var-requires */
let fetchKey: () => Promise<{ enabled: boolean; key?: string } | null> = getDataKeyFromServer;

/** Tests only. */
export function __setDataKeyDeps(d: { store?: Store; fetchKey?: typeof fetchKey }): void {
  if (d.store) store = d.store;
  if (d.fetchKey) fetchKey = d.fetchKey;
  memo = null;
}

/**
 * The key, or null when sealing is off.
 * THROWS when it cannot be known (sealing is on but the server is unreachable
 * and nothing is cached) — the caller must not write plaintext then, and must
 * not treat sealed rows it cannot open as the truth.
 */
export async function getDataKey(userId: string): Promise<Uint8Array | null> {
  if (memo && memo.userId === userId && (memo.key || Date.now() - memo.at < DISABLED_RETRY_MS)) {
    return memo.key;
  }
  try {
    const cached = await store.get(DATA_KEY_NAME);
    if (cached) {
      const { userId: owner, key } = JSON.parse(cached);
      if (owner === userId && typeof key === 'string') {
        memo = { userId, key: fromBase64(key), at: Date.now() };
        return memo.key;
      }
    }
  } catch (e) {
    console.warn('[DataKey] cached key unreadable', String(e));
  }
  const res = await fetchKey();
  if (!res) throw new Error('data key unavailable (server unreachable or signed out)');
  if (!res.enabled || !res.key) {
    memo = { userId, key: null, at: Date.now() };
    return null;
  }
  await store.set(DATA_KEY_NAME, JSON.stringify({ userId, key: res.key }));
  memo = { userId, key: fromBase64(res.key), at: Date.now() };
  return memo.key;
}

export async function forgetDataKey(): Promise<void> {
  memo = null;
  await store.remove(DATA_KEY_NAME).catch(() => undefined);
}
