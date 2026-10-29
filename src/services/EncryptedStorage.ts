/**
 * EncryptedStorage — AsyncStorage, but nothing on the phone's disk is readable.
 *
 * 7.10 security audit: every AsyncStorage value was plaintext — her tasks (where
 * she will be and when), the home address in `user_profile`, known places, the
 * chat, Gmail-derived events and the Supabase session (a refresh token). Android
 * sandboxes app storage, but a rooted phone, a forensic copy, a debug build or a
 * backup reads it as text.
 *
 * Now every value is AES-256-GCM:
 *   - one random 256-bit key per install, kept in expo-secure-store (Android
 *     Keystore-backed), never in AsyncStorage and never sent anywhere;
 *   - a fresh 96-bit nonce per write (expo-crypto);
 *   - the storage KEY NAME is the additional authenticated data, so a value
 *     cannot be moved under another name — a swapped or edited value fails
 *     to decrypt instead of being believed.
 * Envelope: "enc1:" + base64(nonce ‖ ciphertext ‖ tag).
 *
 * Migration needs no flag day: a value without the prefix is plaintext from an
 * older build — it is returned as-is and re-written encrypted in the background.
 *
 * A value that fails to decrypt is NOT silently empty (silent-state rule 1):
 * it is reported with console.warn and in `lastFailure()`, and `getItem` returns
 * null so the cloud copy wins (cloud-over-local), never a crash.
 *
 * Drop-in: same method names as @react-native-async-storage/async-storage for
 * everything this app uses. tests/run-no-raw-asyncstorage.ts keeps it that way.
 */
// eslint-disable-next-line no-restricted-imports -- the one place the raw store is allowed
import AsyncStorage from '@react-native-async-storage/async-storage';
import { gcm } from '@noble/ciphers/aes';

const PREFIX = 'enc1:';
export const STORAGE_KEY_NAME = 'meira.storage.key.v1';
const NONCE_BYTES = 12;

// ── bytes ↔ text, without TextDecoder (Hermes has no TextDecoder) ──────────

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  const chunk: number[] = [];
  const flush = () => {
    s += String.fromCharCode(...chunk);
    chunk.length = 0;
  };
  for (let i = 0; i < b.length; ) {
    const x = b[i++];
    let c: number;
    if (x < 0x80) c = x;
    else if (x < 0xe0) c = ((x & 31) << 6) | (b[i++] & 63);
    else if (x < 0xf0) c = ((x & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else c = ((x & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    if (c >= 0x10000) {
      c -= 0x10000;
      chunk.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
    } else chunk.push(c);
    if (chunk.length > 4096) flush();
  }
  flush();
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

export function toBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=')
      + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64_INDEX[clean[i]] << 18) | (B64_INDEX[clean[i + 1]] << 12)
      | ((B64_INDEX[clean[i + 2]] ?? 0) << 6) | (B64_INDEX[clean[i + 3]] ?? 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── the key ──────────────────────────────────────────────────────────────────

type KeyStore = {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
};

// Native modules are required lazily: a module that merely IMPORTS storage
// (and every Node test that loads one) must not need the Keystore to exist.
/* eslint-disable @typescript-eslint/no-var-requires */
const secureKeyStore: KeyStore = {
  get: (n) => require('expo-secure-store').getItemAsync(n),
  set: (n, v) => require('expo-secure-store').setItemAsync(n, v),
  remove: (n) => require('expo-secure-store').deleteItemAsync(n),
};

type Deps = {
  raw: Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem' | 'multiRemove' | 'clear'>;
  keys: KeyStore;
  random: (n: number) => Uint8Array;
};

let deps: Deps = {
  raw: AsyncStorage,
  keys: secureKeyStore,
  random: (n) => require('expo-crypto').getRandomBytes(n),
};
/* eslint-enable @typescript-eslint/no-var-requires */

/** Tests only: swap the disk, the keystore and the RNG. */
export function __setDeps(d: Partial<Deps>): void {
  deps = { ...deps, ...d };
  keyPromise = null;
}

let keyPromise: Promise<Uint8Array> | null = null;

function storageKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const stored = await deps.keys.get(STORAGE_KEY_NAME);
      if (stored && /^[0-9a-f]{64}$/.test(stored)) return unhex(stored);
      const fresh = deps.random(32);
      await deps.keys.set(STORAGE_KEY_NAME, hex(fresh));
      return fresh;
    })().catch((e) => {
      keyPromise = null; // let the next call retry instead of caching a failure
      throw e;
    });
  }
  return keyPromise;
}

// ── encrypt / decrypt ───────────────────────────────────────────────────────

let failure: string | null = null;

/** Why the last value could not be read, or null. For diagnostics screens. */
export function lastFailure(): string | null {
  return failure;
}

/**
 * "enc1:" + base64(nonce ‖ ciphertext ‖ tag) under `key`, with `aad` bound in.
 * The SAME format the server writes (server/field_crypto.py) — the sealed task
 * and profile rows are opened by both sides; tests/run-sealed-interop.ts holds
 * a vector Python sealed.
 */
export function sealWith(key: Uint8Array, aad: string, value: string): string {
  const nonce = deps.random(NONCE_BYTES);
  const ct = gcm(key, nonce, utf8Encode(aad)).encrypt(utf8Encode(value));
  const all = new Uint8Array(nonce.length + ct.length);
  all.set(nonce, 0);
  all.set(ct, nonce.length);
  return PREFIX + toBase64(all);
}

/** Opens what sealWith (or the server) sealed. Throws on a wrong key, aad or edit. */
export function openWith(key: Uint8Array, aad: string, stored: string): string {
  const all = fromBase64(stored.slice(PREFIX.length));
  const nonce = all.subarray(0, NONCE_BYTES);
  return utf8Decode(gcm(key, nonce, utf8Encode(aad)).decrypt(all.subarray(NONCE_BYTES)));
}

export async function seal(name: string, value: string): Promise<string> {
  return sealWith(await storageKey(), name, value);
}

export async function open(name: string, stored: string): Promise<string> {
  return openWith(await storageKey(), name, stored);
}

export function isSealed(stored: string | null): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

// ── the AsyncStorage-shaped surface ─────────────────────────────────────────

// Writes per name, this process. The background re-seal of a legacy value
// must never land on top of a newer write made while it was encrypting.
const writes = new Map<string, number>();
const bump = (name: string) => writes.set(name, (writes.get(name) ?? 0) + 1);
let epoch = 0; // bumped by clear(): nothing read before it may be written after it

async function getItem(name: string): Promise<string | null> {
  // Taken BEFORE the read: a write that starts while we are reading must win.
  const seen = writes.get(name) ?? 0;
  const era = epoch;
  const stored = await deps.raw.getItem(name);
  if (stored === null || stored === undefined) return null;
  if (!isSealed(stored)) {
    // Written by an older build. Readable once, then sealed — unless something
    // wrote this name meanwhile, in which case that newer value stands.
    seal(name, stored)
      .then(async (sealed) => {
        if ((writes.get(name) ?? 0) !== seen || epoch !== era) return;
        bump(name);
        await deps.raw.setItem(name, sealed);
      })
      .catch((e) => console.warn('[EncryptedStorage] could not seal legacy value', name, String(e)));
    return stored;
  }
  try {
    return await open(name, stored);
  } catch (e) {
    failure = `${name}: ${String((e as Error)?.message ?? e)}`;
    console.warn('[EncryptedStorage] value could not be decrypted — treated as absent', failure);
    return null;
  }
}

async function setItem(name: string, value: string): Promise<void> {
  bump(name);
  await deps.raw.setItem(name, await seal(name, value));
}

async function removeItem(name: string): Promise<void> {
  bump(name);
  await deps.raw.removeItem(name);
}

async function multiRemove(names: readonly string[]): Promise<void> {
  names.forEach(bump);
  await deps.raw.multiRemove(names as string[]);
}

/** Every value AND the key. After this nothing previously stored can be read. */
async function clear(): Promise<void> {
  epoch += 1;
  await deps.raw.clear();
  await deps.keys.remove(STORAGE_KEY_NAME).catch(() => undefined);
  keyPromise = null;
}

const EncryptedStorage = { getItem, setItem, removeItem, multiRemove, clear };
export default EncryptedStorage;
