/**
 * DataKey — when the app may write plaintext, and when it must not (7.10).
 *
 *   npx tsx tests/run-data-key.ts
 */
const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: {} };
  if (request.endsWith('/LumiServer')) return { __esModule: true, getDataKeyFromServer: async () => null };
  return origLoad.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DK = require('../src/services/DataKey');

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}
const vault = new Map<string, string>();
const store = {
  get: async (n: string) => vault.get(n) ?? null,
  set: async (n: string, v: string) => { vault.set(n, v); },
  remove: async (n: string) => { vault.delete(n); },
};
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');

(async () => {
  let calls = 0;
  DK.__setDataKeyDeps({ store, fetchKey: async () => { calls += 1; return { enabled: false }; } });
  check('sealing off → null (write as before)', (await DK.getDataKey('u1')) === null);
  await DK.getDataKey('u1');
  check('…and not asked again on every write', calls === 1);

  DK.__setDataKeyDeps({ store, fetchKey: async () => null });
  let threw = false;
  try { await DK.getDataKey('u1'); } catch { threw = true; }
  check('server unreachable and nothing cached → THROWS (never plaintext by accident)', threw);

  DK.__setDataKeyDeps({ store, fetchKey: async () => ({ enabled: true, key: KEY }) });
  const k = await DK.getDataKey('u1');
  check('sealing on → the 32-byte key', k instanceof Uint8Array && k.length === 32);
  check('kept for this account', JSON.parse(vault.get(DK.DATA_KEY_NAME)!).userId === 'u1');

  DK.__setDataKeyDeps({ store, fetchKey: async () => null });
  check('offline later → the cached key still works', (await DK.getDataKey('u1'))?.length === 32);
  threw = false;
  try { await DK.getDataKey('u2'); } catch { threw = true; }
  check('another account never gets the previous one\'s key', threw);

  await DK.forgetDataKey();
  check('forget wipes it', !vault.has(DK.DATA_KEY_NAME));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
