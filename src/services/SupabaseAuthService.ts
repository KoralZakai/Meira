/**
 * SupabaseAuthService — Google sign-in (expo-auth-session → Supabase) and
 * session helpers.
 *
 * Dependencies: supabaseClient. getUserId() gates ALL cloud sync in
 * TaskStorage/supabaseRepo — a null user id means local-only mode.
 */
// Supabase Auth — establishes a Supabase SESSION (app identity) via Google.
// This is what gives every row its `userId` for Row Level Security. It is
// separate from GoogleService, which only fetches a Google *API* access token
// for Maps/Calendar/Gmail.
//
// Flow (PKCE): ask Supabase for the Google OAuth URL → open it in the system
// browser → Google redirects back to lumi://auth/callback?code=... → exchange
// the code for a session, which is then persisted in AsyncStorage by the client.
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from './supabaseClient';

WebBrowser.maybeCompleteAuthSession();

const redirectTo = AuthSession.makeRedirectUri({ scheme: 'lumi', path: 'auth/callback' });

/**
 * The stage this sign-in reached, for when it fails without an error.
 *
 * "Nothing happens when I press it" was reported three times and every guess at
 * the cause was wrong, because the whole path was invisible in a release build:
 * the only logging was behind __DEV__, and every failure mode here returns null
 * rather than throwing. This records progress so a failure names its own step —
 * readable in `adb logcat -s ReactNativeJS` and shown in the UI alert.
 */
export let lastAuthStage = 'not started';

function stage(s: string): void {
  lastAuthStage = s;
  // console.warn, not console.log: __DEV__ logs are stripped from release
  // bundles, which is exactly why this was undiagnosable on the phone.
  console.warn(`[AUTH] ${s}`);
}

/** Reject rather than hang. A pending promise leaves the button spinning forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not respond within ${ms / 1000}s`)), ms)),
  ]);
}

/** Launch Google sign-in and establish a Supabase session. Returns the session. */
export async function signInWithGoogle(): Promise<Session | null> {
  stage(`starting; redirectTo = ${redirectTo}`);
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured (missing URL or anon key in this build).');
  }

  stage('asking Supabase for the Google URL');
  const { data, error } = await withTimeout(
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    }),
    20_000,
    'Supabase',
  );
  if (error) throw error;
  if (!data?.url) throw new Error('Supabase returned no OAuth URL.');

  stage('opening the browser');
  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  stage(`browser closed with type "${result.type}"`);
  if (result.type !== 'success') {
    // dismiss = closed by the user or by Android; cancel = back button.
    return null;
  }

  const code = new URL(result.url).searchParams.get('code');
  if (!code) throw new Error(`Redirect carried no ?code= (url started ${result.url.slice(0, 40)})`);

  stage('exchanging the code for a session');
  const { data: sessionData, error: exchangeError } =
    await withTimeout(supabase.auth.exchangeCodeForSession(code), 20_000, 'Code exchange');
  if (exchangeError) throw exchangeError;

  stage(sessionData?.session ? 'signed in' : 'exchange returned no session');
  return sessionData?.session ?? null;
}

/** End the Supabase session; the app falls back to local-only storage. */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Current Supabase session or null. */
export async function getSession(): Promise<Session | null> {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** Current user id (used to scope rows). Null when signed out. */
export async function getUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.user?.id ?? null;
}

/**
 * The signed-in account, CONFIRMED with the server — or null.
 *
 * getSession()/getUserId() read the session cached in AsyncStorage and never
 * check it. A session that has been revoked, or whose refresh token is dead,
 * still reads back as a valid-looking user id. The UI then said "Signed in ✓"
 * while every cloud write was rejected, and — because the row disables itself
 * when it believes it is signed in — tapping it did nothing at all.
 *
 * getUser() is a round-trip that the server can reject. On rejection the dead
 * session is cleared, so the next render offers sign-in again instead of
 * showing a tick that cannot be acted on.
 */
export async function getVerifiedUser(): Promise<{ id: string; email?: string } | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      if (error) {
        console.warn('[AUTH] cached session rejected by the server:', error.message);
        await supabase.auth.signOut().catch(() => {});
      }
      return null;
    }
    return { id: data.user.id, email: data.user.email ?? undefined };
  } catch (err: any) {
    console.warn('[AUTH] could not verify the session:', err?.message || err);
    return null;
  }
}

/**
 * Subscribe to sign-in/out changes. Returns an unsubscribe function.
 * `event` is Supabase's own (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED,
 * SIGNED_OUT, …). Note SIGNED_IN also fires at launch when a stored session
 * is restored — it does not by itself mean "she just signed in".
 */
export function onAuthChange(callback: (session: Session | null, event: string) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(session, event));
  return () => data.subscription.unsubscribe();
}
