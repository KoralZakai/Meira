'use client';

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient';
import SignIn from '@/components/SignIn';
import Dashboard from '@/components/Dashboard';

export default function Page() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // On-screen diagnostics so we can see why a mobile sign-in fails without a
  // devtools console. Remove once auth is confirmed working on the phone.
  const [diag, setDiag] = useState<string[]>([]);

  useEffect(() => {
    const stamp = () => new Date().toISOString().slice(11, 19);
    const log = (s: string) => setDiag((d) => [...d, `${stamp()} ${s}`]);

    // No Supabase env vars on this deployment — say so instead of throwing
    // inside every auth call and rendering an empty page.
    if (!isSupabaseConfigured) {
      log('Supabase not configured (NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY missing)');
      setSession(null);
      return;
    }

    if (typeof window !== 'undefined') {
      const rawHash = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash;
      const params = new URLSearchParams(rawHash);
      const keys = Array.from(params.keys());
      log(`hash keys: ${keys.join(',') || 'none'}`);

      // FIX: detectSessionInUrl returns null even though the implicit token is
      // present, so establish the session manually from the fragment tokens.
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const hashError = params.get('error_description') || params.get('error');
      if (hashError) {
        log(`provider error: ${hashError.slice(0, 100)}`);
      } else if (accessToken) {
        supabase.auth
          .setSession({ access_token: accessToken, refresh_token: refreshToken ?? '' })
          .then(({ data, error }) => {
            log(`setSession → ${data.session ? 'session ✓' : 'null'}${error ? ' err=' + error.message : ''}`);
            if (data.session) {
              setSession(data.session);
              // Clean the token out of the URL.
              window.history.replaceState({}, '', window.location.pathname);
            }
          })
          .catch((e) => log(`setSession threw: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        log(`getSession ${data.session ? 'SESSION ✓' : 'null'}${error ? ' err=' + error.message : ''}`);
        setSession(data.session ?? null);
      })
      .catch((e) => {
        log(`getSession threw: ${e instanceof Error ? e.message : String(e)}`);
        setSession(null);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      log(`event ${event} → ${s ? 'session ✓' : 'null'}`);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="signin">
        <p className="muted">Loading…</p>
        <DiagPanel diag={diag} />
      </div>
    );
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="signin">
        <h1>Lumi</h1>
        <p className="muted">
          This deployment isn’t connected to Supabase yet. Add{' '}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>{' '}
          in the Vercel project settings, then redeploy.
        </p>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <SignIn />
        <DiagPanel diag={diag} />
      </>
    );
  }

  return <Dashboard session={session} />;
}

function DiagPanel({ diag }: { diag: string[] }) {
  if (diag.length === 0) return null;
  return (
    <pre
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        margin: 0,
        maxHeight: '40vh',
        overflow: 'auto',
        background: '#1a1a2e',
        color: '#06d6a0',
        fontSize: 11,
        lineHeight: 1.5,
        padding: '10px 12px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        zIndex: 9999,
      }}
    >
      {`🔍 auth debug\n${diag.join('\n')}`}
    </pre>
  );
}
