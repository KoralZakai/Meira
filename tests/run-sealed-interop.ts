/**
 * Sealed rows: the app and the server read each other's ciphertext (7.10).
 *
 *   npx tsx tests/run-sealed-interop.ts
 *
 * tests/fixtures/sealed-vector.json is written by server/tests/test_field_crypto.py
 * (Python `cryptography`, fixed key and nonce). This opens it with the app's
 * code, seals the same plaintext with the same nonce and must produce the SAME
 * bytes — so either side opens the other's rows. Then the row-level rules.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: {} };
  if (request.endsWith('/supabaseClient')) return { __esModule: true, supabase: null, isSupabaseConfigured: false };
  if (request.endsWith('/LumiServer')) return { __esModule: true, getDataKeyFromServer: async () => null };
  return origLoad.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ES = require('../src/services/EncryptedStorage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const repo = require('../src/services/supabaseRepo');

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const v = JSON.parse(readFileSync(join(__dirname, 'fixtures/sealed-vector.json'), 'utf8'));
const key = ES.fromBase64(v.key_b64);

console.log('Python → app');
check('the app opens what the server sealed', ES.openWith(key, v.aad, v.sealed) === v.plain);
let threw = false;
try { ES.openWith(key, 'tasks:OTHER', v.sealed); } catch { threw = true; }
check('…and refuses it under another row id', threw);

console.log('app → Python');
ES.__setDeps({ random: (n: number) => Uint8Array.from({ length: n }, (_, i) => i) });
check('same key, nonce and text give the server\'s exact bytes', ES.sealWith(key, v.aad, v.plain) === v.sealed);
ES.__setDeps({ random: (n: number) => new Uint8Array(require('crypto').randomBytes(n)) });

console.log('task rows');
const row = { id: 't1', userId: 'u', text: 'ראיון ב-Ceva', date: '2026-10-08', status: 'pending',
  location: { address: 'Ra\'anana', lat: 32.18 }, contactPhone: '0541234567', locationLat: 32.18 };
const sealed = repo.sealTaskRow(row, key);
check('text reads as the lock', sealed.text === repo.SEALED_PLACEHOLDER);
// Only the clear columns: random base64 in `sealed` may spell "Ceva" by chance.
const { sealed: _blob, ...clearCols } = sealed;
check('nothing personal in the clear', !JSON.stringify(clearCols).includes('Ceva') && sealed.location === null
  && sealed.contactPhone === null && sealed.locationLat === null);
check('date and status stay queryable', sealed.date === '2026-10-08' && sealed.status === 'pending');
const back = repo.openTaskRow(sealed, key);
check('opens back to the task', back.text === 'ראיון ב-Ceva' && back.location.address === 'Ra\'anana');
check('an older build\'s plaintext edit wins', repo.openTaskRow({ ...sealed, text: 'edited elsewhere' }, key).text === 'edited elsewhere');
threw = false;
try { repo.openTaskRow(sealed, undefined); } catch { threw = true; }
check('no key → the read FAILS (never a list of locks taken as truth)', threw);

console.log('profile rows');
const prof = repo.sealProfileRow({ userId: 'u', name: 'Koral', homeAddress: 'אבן גבירול 30', homeLat: 32.08,
  homeLng: 34.78, transportType: 'bus' }, key);
check('home is not in the clear', prof.homeAddress === '' && prof.homeLat === 0 && !JSON.stringify(prof).includes('גבירול'));
check('opens back', repo.openProfileRow(prof, key).homeAddress === 'אבן גבירול 30');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
