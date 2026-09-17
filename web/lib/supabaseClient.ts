'use client';

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Browser Supabase client for the web app. Shares the same project (and tables)
// as the mobile app. `detectSessionInUrl` is on so the session in the URL is
// picked up automatically after the Google redirect.
//
// We use the IMPLICIT flow (not PKCE) on purpose: this is a client-only SPA with
// no server to hold the PKCE code-verifier, and mobile browsers don't reliably
// persist that verifier across the OAuth redirect hops — which left users
// bouncing back to the sign-in screen on phones. Implicit flow returns the
// tokens directly in the URL fragment, so no stored verifier is needed.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** False when the deployment has no Supabase env vars — the UI says so plainly. */
export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY in the Vercel project settings.',
    );
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'implicit',
    },
  });
  return client;
}

/**
 * Built on FIRST USE, not on import.
 *
 * `createClient('', '')` throws "supabaseUrl is required", and Next prerenders
 * `/` at build time — so a missing env var took the whole Vercel build down
 * instead of degrading. Nothing touches this during render (every call site is
 * inside an effect or a handler), so deferring construction keeps the build
 * green and turns a missing variable into a message the user can act on.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const instance = getClient() as any;
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
