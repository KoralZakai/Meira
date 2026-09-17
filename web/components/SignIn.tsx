'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

export default function SignIn() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    try {
      setLoading(true);
      setError(null);
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
      // Browser redirects to Google, then back here; the session is picked up
      // automatically by detectSessionInUrl.
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    }
  };

  return (
    <div className="signin">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="avatar-logo" src="/lumi-logo.png" alt="Lumi" width={72} height={72} />
      <h1>Lumi</h1>
      <p className="muted">Manage your day from the web</p>
      <button className="btn btn-primary" onClick={signIn} disabled={loading}>
        {loading ? 'Redirecting…' : 'Sign in with Google'}
      </button>
      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
    </div>
  );
}
