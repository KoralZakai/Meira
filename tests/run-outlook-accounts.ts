/**
 * run-outlook-accounts — several Microsoft accounts (6.10), each read on its
 * own, each failing on its own, each labelled with its address.
 *
 *   npx tsx tests/run-outlook-accounts.ts
 */
process.env.EXPO_PUBLIC_MS_CLIENT_ID = 'test-client';
const secure = new Map<string, string>();
const async = new Map<string, string>();
let nextAccount = 'work@company.com';
const tokenOwner = new Map<string, string>();
const deadTokens = new Set<string>();
const imported: any[] = [];
const noted: any[] = [];   // noteCancellationsFor calls: a vanished event is judged only after a FULL read

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === 'expo-secure-store') {
    return { __esModule: true,
      getItemAsync: async (k: string) => secure.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
      deleteItemAsync: async (k: string) => { secure.delete(k); } };
  }
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
    return { __esModule: true, default: {
      getItem: async (k: string) => async.get(k) ?? null,
      setItem: async (k: string, v: string) => { async.set(k, v); },
      removeItem: async (k: string) => { async.delete(k); } } };
  }
  if (request === 'expo-auth-session') {
    class AuthRequest { codeVerifier = 'v'; async promptAsync() { return { type: 'success', params: { code: 'c' } }; } }
    return { __esModule: true, AuthRequest, fetchDiscoveryAsync: async () => ({}),
      exchangeCodeAsync: async () => { const t = `tok-${nextAccount}`; tokenOwner.set(t, nextAccount); return { accessToken: t, expiresIn: 3600 }; },
      refreshAsync: async () => ({ accessToken: 'x', expiresIn: 3600 }), makeRedirectUri: () => 'lumi://outlook' };
  }
  if (request === 'expo-web-browser') return { __esModule: true, maybeCompleteAuthSession: () => {} };
  if (request === './GoogleSync') {
    return { __esModule: true, importCalendarTasks: async (tasks: any[]) => { imported.push(...tasks); return tasks.length; },
      noteCancellationsFor: async (prefix: string, dates: string[]) => { noted.push({ prefix, days: dates.length }); } };
  }
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).fetch = async (url: string, init: any) => {
  const token = String(init?.headers?.Authorization || '').replace('Bearer ', '');
  if (url.includes('/me?')) return { ok: true, status: 200, json: async () => ({ mail: tokenOwner.get(token) }) };
  if (url.includes('/calendarView')) {
    if (deadTokens.has(token)) return { ok: false, status: 403, json: async () => ({ error: { message: 'Forbidden' } }) };
    const who = tokenOwner.get(token);
    return { ok: true, status: 200, json: async () => ({ value: [{
      id: `ev-${who}`, subject: `Meeting of ${who}`, isAllDay: false, isCancelled: false,
      start: { dateTime: '2026-10-08T07:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-08T08:00:00.0000000', timeZone: 'UTC' },
    }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Outlook = require('../src/services/OutlookService') as typeof import('../src/services/OutlookService');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

(async () => {
  console.log('\nAn older build\'s one account\n');
  tokenOwner.set('legacy', 'me@outlook.com');
  secure.set('ms_tokens', JSON.stringify({ accessToken: 'legacy', expiresAt: Date.now() + 3600_000, account: 'me@outlook.com' }));
  check('becomes the first account in place', JSON.stringify(await Outlook.outlookAccounts()) === '["me@outlook.com"]');

  console.log('\nA work account added beside it\n');
  nextAccount = 'work@company.com';
  const r = await Outlook.signInWithMicrosoft();
  check('sign-in adds, never replaces', r.ok && JSON.stringify(await Outlook.outlookAccounts()) === '["me@outlook.com","work@company.com"]',
    JSON.stringify(await Outlook.outlookAccounts()));
  await Outlook.signInWithMicrosoft();
  check('the same address signing in again stays one account', (await Outlook.outlookAccounts()).length === 2);

  console.log('\nBoth calendars read, each labelled\n');
  const res = await Outlook.syncOutlook('en', 3);
  check('both accounts\' events imported', res.ok && imported.length === 2, JSON.stringify(res));
  check('every account answered: cancellations judged once, for the whole range', noted.length === 1 && noted[0].prefix === 'ocal-' && noted[0].days === 4);
  check('…each labelled with its own address, not "Outlook"',
    imported.map((t) => t.calendarName).sort().join(',') === 'me@outlook.com,work@company.com',
    imported.map((t) => t.calendarName).join(','));

  console.log('\nOne account failing\n');
  imported.length = 0; noted.length = 0;
  deadTokens.add('tok-work@company.com');
  const half = await Outlook.syncOutlook('en', 3);
  check('the other account\'s events still arrive', imported.length === 1 && /me@outlook/.test(imported[0].calendarName));
  check('one account failed: NOT judged (its events are missing, not cancelled)', noted.length === 0);
  check('…and the failure is said, not swallowed', !half.ok && /http_403/.test(String(half.error)), JSON.stringify(half));

  console.log('\nDisconnecting one\n');
  await Outlook.signOutMicrosoft('work@company.com');
  check('only that account goes', JSON.stringify(await Outlook.outlookAccounts()) === '["me@outlook.com"]');
  await Outlook.signOutMicrosoft();
  check('no name = all of them', !(await Outlook.outlookConnected()));

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
