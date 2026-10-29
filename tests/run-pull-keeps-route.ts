/**
 * run-pull-keeps-route — a pull from the server must not wipe the route the
 * phone planned (1.10: yoga back on "routing…" with a 10:25 fallback alarm),
 * and an Israeli train's "headsign" is its number, not a direction.
 *
 * Run:  npx tsx tests/run-pull-keeps-route.ts
 */
const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
    const m = new Map<string, string>();
    return { __esModule: true, default: { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); }, removeItem: async (k: string) => { m.delete(k); }, getAllKeys: async () => [...m.keys()], multiRemove: async () => {} } };
  }
  if (request.endsWith('/supabaseClient')) return { __esModule: true, isSupabaseConfigured: false, supabase: null };
  if (request.endsWith('/SupabaseAuthService')) return { __esModule: true, getUserId: async () => null };
  if (request.endsWith('/serverAuth')) return { __esModule: true, authedFetch: async () => null };
  return origLoad.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { keepPlannedPlaces } = require('../src/services/WhatsAppTaskSync');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { headsignText } = require('../src/utils/transitParse');

let bad = 0;
const check = (label: string, ok: boolean) => { if (!ok) bad += 1; console.log(`  ${ok ? '✓' : '✗'} ${label}`); };
const planned = { address: 'Yigal Alon St 94, Tel Aviv-Yafo, Israel', lat: 32.07, lng: 34.79, leaveHomeBy: '10:43', transitPlan: { leaveHomeAt: '10:43', arriveAt: '11:00', legs: [] } };
const local = [{ id: 'y', text: 'יוגה', location: planned }];

const [same] = keepPlannedPlaces([{ id: 'y', text: 'יוגה', location: 'Yigal Alon St 94, Tel Aviv-Yafo' }], local);
check('the same place from the server keeps the phone\'s route', same.location.leaveHomeBy === '10:43');
const [moved] = keepPlannedPlaces([{ id: 'y', text: 'יוגה', location: 'Dizengoff 50, Tel Aviv' }], local);
check('a different place comes through — that is a move', moved.location === 'Dizengoff 50, Tel Aviv');
const [fresh] = keepPlannedPlaces([{ id: 'n', text: 'new', location: 'Herzl 1' }], local);
check('a new task is untouched', fresh.location === 'Herzl 1');
check('"256" is a train number', headsignText('256', false) === 'train no. 256' && headsignText('256', true) === 'רכבת מס׳ 256');
check('a real direction stays a direction', headsignText('Nahariya', false) === 'towards Nahariya');
console.log(`\n${bad ? '❌' : '✅'} ${5 - bad}/5 checks passed\n`);
process.exit(bad ? 1 : 0);
