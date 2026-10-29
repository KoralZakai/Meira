/**
 * run-google-accounts — several Google accounts, each with its own token,
 * calendar switch and mail switch (6.10: "private and work Gmail").
 *
 * A second sign-in used to OVERWRITE the first account's token in silence.
 * SecureStore, AuthSession and Google are stubbed: the test owns which
 * address each sign-in "picks" and what Calendar answers.
 *
 *   npx tsx tests/run-google-accounts.ts
 */
const secure = new Map<string, string>();
let nextSignIn = { email: 'private@gmail.com', token: 't-private' };
const tokenToEmail = new Map<string, string>();

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === 'expo-secure-store') {
    return {
      __esModule: true,
      getItemAsync: async (k: string) => secure.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
      deleteItemAsync: async (k: string) => { secure.delete(k); },
    };
  }
  if (request === 'expo-auth-session') {
    class AuthRequest {
      codeVerifier = 'v';
      constructor(public opts: any) {}
      async promptAsync() {
        return nextSignIn.email === 'BLOCKED'
          ? { type: 'error', params: { error: 'admin_policy_enforced' } }
          : { type: 'success', params: { code: 'c' } };
      }
    }
    return {
      __esModule: true,
      AuthRequest,
      fetchDiscoveryAsync: async () => ({}),
      exchangeCodeAsync: async () => {
        tokenToEmail.set(nextSignIn.token, nextSignIn.email);
        return { accessToken: nextSignIn.token, refreshToken: `r-${nextSignIn.token}`, expiresIn: 3600 };
      },
      refreshAsync: async () => ({ accessToken: 'refreshed', expiresIn: 3600 }),
      makeRedirectUri: () => 'lumi://',
    };
  }
  if (request === 'expo-web-browser') return { __esModule: true, maybeCompleteAuthSession: () => {} };
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).fetch = async (url: string, init: any) => {
  const token = String(init?.headers?.Authorization || '').replace('Bearer ', '');
  if (url.includes('/calendars/primary')) {
    const email = tokenToEmail.get(token);
    return { ok: Boolean(email), status: email ? 200 : 401, json: async () => ({ id: email }) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoogleService } = require('../src/services/GoogleService') as typeof import('../src/services/GoogleService');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

(async () => {
  console.log('\nAn older build\'s one token\n');
  tokenToEmail.set('legacy-token', 'private@gmail.com');
  secure.set('google_tokens', JSON.stringify({ accessToken: 'legacy-token', expiresAt: Date.now() + 3600_000 }));
  let list = await GoogleService.listGoogleAccounts();
  check('becomes the first account, in place, its address looked up',
    list.length === 1 && list[0].email === 'private@gmail.com' && list[0].key === 'google_tokens', JSON.stringify(list));
  check('…reading both its calendar and its mail', list[0].calendar && list[0].mail);

  console.log('\nAdding the work account\n');
  nextSignIn = { email: 'work@company.com', token: 't-work' };
  check('sign-in succeeds', await GoogleService.signInWithGoogle());
  list = await GoogleService.listGoogleAccounts();
  check('THE BUG: the private account is still there — two accounts now',
    list.map((a) => a.email).join(',') === 'private@gmail.com,work@company.com', JSON.stringify(list.map((a) => a.email)));
  check('each has its own token', (await GoogleService.getToken('work@company.com')) === 't-work'
    && (await GoogleService.getToken('private@gmail.com')) === 'legacy-token');
  check('a call that names no account still uses the first one', (await GoogleService.getToken()) === 'legacy-token');

  console.log('\nSigning in again with the same address\n');
  nextSignIn = { email: 'work@company.com', token: 't-work-2' };
  await GoogleService.signInWithGoogle();
  list = await GoogleService.listGoogleAccounts();
  check('replaces that account\'s token, adds nothing', list.length === 2 && (await GoogleService.getToken('work@company.com')) === 't-work-2');

  console.log('\nWhat Meira reads from each\n');
  await GoogleService.setGoogleAccountUse('work@company.com', { calendar: false });
  const read = await GoogleService.googleCalendarEmails();
  check('work calendar off → only the private calendar is read by API (the phone reads the work one)',
    JSON.stringify(read.emails) === '["private@gmail.com"]' && !read.unknown, JSON.stringify(read));
  check('…its mail is still read', (await GoogleService.listGoogleAccounts()).find((a) => a.email === 'work@company.com')!.mail);

  console.log('\nA company that blocks the app\n');
  nextSignIn = { email: 'BLOCKED', token: 'x' };
  check('sign-in fails…', !(await GoogleService.signInWithGoogle()));
  check('…and says why, in a word the Calendars screen can explain', GoogleService.lastSignInError() === 'admin_blocked');
  check('…nothing was added', (await GoogleService.listGoogleAccounts()).length === 2);

  console.log('\nDisconnecting one\n');
  check('disconnect the work account', await GoogleService.disconnectGoogleAccount('work@company.com'));
  list = await GoogleService.listGoogleAccounts();
  check('only the private one is left, its token untouched',
    list.length === 1 && list[0].email === 'private@gmail.com' && (await GoogleService.getToken()) === 'legacy-token');
  check('the work token is gone from the phone', !secure.has('google_tokens.work_company.com'), [...secure.keys()].join(','));
  check('still connected overall', await GoogleService.isGoogleConnected());
  await GoogleService.disconnectGoogleAccount('private@gmail.com');
  check('after the last one, not connected', !(await GoogleService.isGoogleConnected()));

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
