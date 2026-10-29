/**
 * supabaseClient — the singleton Supabase client (session persisted in
 * AsyncStorage) plus the isSupabaseConfigured flag.
 *
 * Dependencies: EXPO_PUBLIC_SUPABASE_URL + EXPO_PUBLIC_SUPABASE_ANON_KEY.
 * When either is missing, isSupabaseConfigured=false and every consumer
 * (TaskStorage, supabaseRepo, SupabaseAuthService) stays local-only.
 */
// Supabase client — shared source of truth for tasks/goals/etc.
// Configured for Expo / React Native: sessions persist in AsyncStorage and
// auto-refresh. URL detection is off (no web redirect flow on native).
//
// flowType is PKCE: native sign-in opens the system browser and Google redirects
// back to lumi://auth/callback?code=..., which SupabaseAuthService exchanges for a
// session. The library default is 'implicit' (tokens in the URL #fragment, no
// ?code=), which would make exchangeCodeForSession fail — so we set it explicitly.
//
// NOTE: this lives in src/services for now; it moves to packages/data when the
// monorepo is scaffolded. The anon key is safe to ship in the client because
// Row Level Security restricts every row to its owner (userId = auth.uid()).
import 'react-native-url-polyfill/auto';
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    '[SUPABASE] Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Set them in .env — auth and cloud sync will not work until then.',
  );
}

/** The app-wide Supabase client; session persists in AsyncStorage. */
export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

/** True once both env vars are present — guard cloud calls with this. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
