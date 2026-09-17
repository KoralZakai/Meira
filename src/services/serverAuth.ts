/**
 * serverAuth — the Authorization header for calls to the Lumi backend.
 *
 * Every `/tasks`, `/agents`, `/link/verify`, `/push/register` and
 * `/personality/complete` route now requires the Supabase access token the app
 * already holds from sign-in; the server verifies it with Supabase and derives
 * the user from it. Before this, those routes identified the caller by a phone
 * number in the URL or body — a value the client chooses — so anyone who knew a
 * number could read and write that person's data.
 *
 * One helper rather than ten inline copies: the header shape and the
 * signed-out case are decided in a single place, so a caller cannot forget the
 * token and silently fall back to an unauthenticated request.
 *
 * Dependencies: SupabaseAuthService.getSession.
 * Consumed by AgentsService, PushService, TaskStorage, PersonalityHandoffService.
 */
import { getSession } from './SupabaseAuthService';

/** `{ Authorization }` for the signed-in user, or null when signed out. */
export async function authHeader(): Promise<Record<string, string> | null> {
  try {
    const token = (await getSession())?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : null;
  } catch {
    return null;
  }
}

/**
 * `fetch` with the bearer token attached, or null when signed out.
 *
 * Returns null rather than sending an anonymous request, because the server
 * will answer that with 401 and the caller would have to special-case it
 * anyway. A null here means "not signed in" — every caller already has a
 * local-only path for that, which is what keeps the app working offline.
 */
export async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const auth = await authHeader();
  if (!auth) return null;
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...auth } });
}
