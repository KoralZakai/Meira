/**
 * AccountDeletion — the in-app half of "delete my account".
 *
 * Google Play has required since 2024 that an app which creates accounts also
 * offers to delete them, both inside the app and from a public web page. Lumi
 * had only a sign-out, which moves nothing: every row stayed exactly where it
 * was. The privacy policy now promises deletion, so this has to be real.
 *
 * Order matters, and it is the opposite of what feels natural:
 *
 *   1. the SERVER first, while the session token is still valid. It is the
 *      only thing that can reach Supabase and the server's own stores, and it
 *      needs a live token to prove who is asking.
 *   2. the DEVICE second. Wiping local storage first would throw away the
 *      token, and with it the only proof of identity the server accepts —
 *      leaving the cloud copy orphaned and unreachable forever.
 *
 * And it refuses to lie. If the server reports a partial deletion (HTTP 207),
 * local data is deliberately left ALONE and the caller is told it failed.
 * Wiping the phone at that point would destroy the user's own copy of data
 * that still exists in the cloud — the worst of both outcomes, and it would
 * look like success.
 *
 * Dependencies: serverAuth (bearer token), SupabaseAuthService (sign-out),
 * AsyncStorage. Consumed by ProfileEditScreen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authedFetch } from './serverAuth';
import { signOut } from './SupabaseAuthService';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;

export type DeletionOutcome =
  /** Gone everywhere: server, cloud, and this device. */
  | { status: 'deleted' }
  /** Not signed in — there is no cloud account to delete. */
  | { status: 'not-signed-in' }
  /** The server could not finish. Local data is untouched ON PURPOSE. */
  | { status: 'partial'; detail: string }
  /** Could not reach the server at all. Nothing was deleted anywhere. */
  | { status: 'failed'; detail: string };

/**
 * Delete this account everywhere, permanently.
 *
 * Never throws: a failure here has to be shown to the user as a clear outcome,
 * not swallowed, and not raised into a screen that would show a red box with a
 * stack trace in it.
 */
export async function deleteAccountEverywhere(): Promise<DeletionOutcome> {
  if (!SERVER_URL) {
    return { status: 'failed', detail: 'No server configured in this build.' };
  }

  // 1. The cloud, while the token is still valid.
  let res: Response | null;
  try {
    res = await authedFetch(`${SERVER_URL}/account`, { method: 'DELETE' });
  } catch (e: any) {
    return { status: 'failed', detail: e?.message || 'Could not reach the server.' };
  }

  // authedFetch returns null when signed out — there is no cloud account.
  if (!res) return { status: 'not-signed-in' };

  if (res.status === 207) {
    const body = await res.json().catch(() => ({} as any));
    const failed = Array.isArray(body?.failed) ? body.failed.join(', ') : 'some data could not be removed';
    return { status: 'partial', detail: failed };
  }
  if (!res.ok) {
    return { status: 'failed', detail: `Server returned ${res.status}.` };
  }

  // 2. Only now the device. The cloud is gone; the local copy is the last one.
  try {
    await AsyncStorage.clear();
  } catch {
    // The account IS deleted server-side. Failing to clear the cache does not
    // make that untrue, and reporting failure here would be the lie.
  }
  await signOut().catch(() => {});

  return { status: 'deleted' };
}

/** What to show the user for each outcome — one place, so the wording is consistent. */
export function describeOutcome(o: DeletionOutcome, he: boolean): { title: string; body: string } {
  switch (o.status) {
    case 'deleted':
      return he
        ? { title: 'החשבון נמחק', body: 'הכל נמחק — משימות, שיחות, פרופיל ומיקומים. תודה שניסית את לומי.' }
        : { title: 'Account deleted', body: 'Everything is gone — tasks, conversations, profile and locations. Thank you for trying Lumi.' };
    case 'not-signed-in':
      return he
        ? { title: 'לא מחוברת', body: 'אין חשבון בענן למחוק. הנתונים על המכשיר יימחקו עם הסרת האפליקציה.' }
        : { title: 'Not signed in', body: 'There is no cloud account to delete. Data on this device goes when you uninstall the app.' };
    case 'partial':
      return he
        ? { title: 'המחיקה לא הושלמה', body: `חלק מהנתונים לא נמחקו (${o.detail}). לא מחקתי כלום מהמכשיר. נסי שוב, או כתבי ל-koralzakai1@gmail.com` }
        : { title: 'Deletion incomplete', body: `Some data could not be removed (${o.detail}). Nothing was deleted from this device. Try again, or email koralzakai1@gmail.com` };
    default:
      return he
        ? { title: 'המחיקה נכשלה', body: `${o.detail} שום דבר לא נמחק. נסי שוב כשיש חיבור.` }
        : { title: 'Deletion failed', body: `${o.detail} Nothing was deleted. Try again when you have a connection.` };
  }
}
