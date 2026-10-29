/**
 * EncryptedStorage — nothing she stores is readable on the phone's disk (7.10).
 *
 *   npx tsx tests/run-encrypted-storage.ts
 *
 * Checks: round-trip (Hebrew, emoji, a big tasks blob); the disk holds no
 * plaintext; a value moved under another name or edited fails (returns null,
 * reports why) instead of being believed; a legacy plaintext value is read
 * once and sealed; a re-seal never overwrites a newer write; clear() removes
 * the key, so old ciphertext is unreadable afterwards; base64/utf8 helpers.
 */
import { randomBytes } from 'crypto';

const disk = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return disk.has(k) ? disk.get(k)! : null; },
  async setItem(k: string, v: string) { disk.set(k, v); },
  async removeItem(k: string) { disk.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => disk.delete(k)); },
  async clear() { disk.clear(); },
};
const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: memoryAsyncStorage };
  return origLoad.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ES = require('../src/services/EncryptedStorage');
const keyring = new Map<string, string>();
ES.__setDeps({
  keys: {
    get: async (n: string) => keyring.get(n) ?? null,
    set: async (n: string, v: string) => { keyring.set(n, v); },
    remove: async (n: string) => { keyring.delete(n); },
  },
  random: (n: number) => new Uint8Array(randomBytes(n)),
});
const S = ES.default;

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  console.log('round trip');
  const home = JSON.stringify({ homeAddress: 'אבן גבירול 30, תל אביב', homeLat: 32.08, emoji: '🚌⏰' });
  await S.setItem('user_profile', home);
  check('reads back exactly', (await S.getItem('user_profile')) === home);
  const raw = disk.get('user_profile')!;
  check('disk holds ciphertext only', raw.startsWith('enc1:') && !raw.includes('גבירול') && !raw.includes('32.08'));
  await S.setItem('user_profile', home);
  check('a fresh nonce every write', disk.get('user_profile') !== raw);
  const big = JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: `t${i}`, text: `משימה ${i} 📍`, date: '2026-10-08' })));
  const t0 = Date.now();
  await S.setItem('lumi.tasks.v1', big);
  const back = await S.getItem('lumi.tasks.v1');
  check(`a ${Math.round(big.length / 1024)} KB tasks blob round-trips`, back === big, `${Date.now() - t0} ms`);

  console.log('tampering is caught, not believed');
  disk.set('lumi.chat.v1', disk.get('user_profile')!);   // moved under another name
  check('a value moved to another name reads as absent', (await S.getItem('lumi.chat.v1')) === null);
  check('…and says why', /lumi\.chat\.v1/.test(ES.lastFailure() ?? ''));
  const ct = disk.get('user_profile')!;
  disk.set('user_profile', ct.slice(0, -6) + (ct.slice(-6, -5) === 'A' ? 'B' : 'A') + ct.slice(-5));
  check('an edited value reads as absent', (await S.getItem('user_profile')) === null);

  console.log('legacy plaintext from an older build');
  disk.set('lumi.knownPlaces.v1', '{"gym":"Space Gym"}');
  check('is still readable', (await S.getItem('lumi.knownPlaces.v1')) === '{"gym":"Space Gym"}');
  await tick();
  check('and is sealed in the background', disk.get('lumi.knownPlaces.v1')!.startsWith('enc1:'));
  check('and still reads the same', (await S.getItem('lumi.knownPlaces.v1')) === '{"gym":"Space Gym"}');

  disk.set('race', 'old plaintext');
  const p = S.getItem('race');
  await S.setItem('race', 'new value');
  await p; await tick();
  check('a re-seal never overwrites a newer write', (await S.getItem('race')) === 'new value');

  console.log('clear() is a wipe');
  await S.setItem('x', 'secret');
  const sealed = disk.get('x')!;
  await S.clear();
  check('values gone', disk.size === 0);
  check('key gone', keyring.size === 0);
  disk.set('x', sealed);
  check('old ciphertext is unreadable with the new key', (await S.getItem('x')) === null);

  console.log('helpers');
  const sample = new Uint8Array(randomBytes(1000));
  check('base64 round-trips', ES.fromBase64(ES.toBase64(sample)).every((b: number, i: number) => b === sample[i]));
  check('base64 matches Node', ES.toBase64(sample) === Buffer.from(sample).toString('base64'));
  const words = 'שלום 👋 мир ✓ 漢字';
  check('utf8 matches Node', Buffer.from(ES.utf8Encode(words)).toString('utf8') === words
    && ES.utf8Decode(new Uint8Array(Buffer.from(words, 'utf8'))) === words);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
