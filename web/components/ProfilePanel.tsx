'use client';

import { useEffect, useState } from 'react';
import { fetchProfile, upsertProfile, type UserProfile } from '@/lib/profile';
import AddressAutocomplete from './AddressAutocomplete';

const TRANSPORTS: UserProfile['transportType'][] = ['bus', 'car', 'walk', 'bike'];

export default function ProfilePanel({
  userId,
  email,
  onClose,
  onSaved,
}: {
  userId: string;
  email?: string;
  onClose: () => void;
  onSaved?: (p: UserProfile) => void;
}) {
  const [profile, setProfile] = useState<Partial<UserProfile>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    fetchProfile(userId)
      .then((p) => setProfile(p ?? {}))
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => setLoading(false));
  }, [userId]);

  const set = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) =>
    setProfile((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await upsertProfile(userId, profile);
      setProfile(saved);
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 1800);
      onSaved?.(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Profile</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="form-grid">
            <label>
              <span>Name</span>
              <input value={profile.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="Your name" />
            </label>
            <label>
              <span>Email</span>
              <input value={email ?? ''} disabled />
            </label>
            <label>
              <span>Home address</span>
              <AddressAutocomplete
                value={profile.homeAddress ?? ''}
                placeholder="Start typing your address…"
                onChange={(text) => set('homeAddress', text)}
                onSelect={(r) => {
                  setProfile((prev) => ({
                    ...prev,
                    homeAddress: r.label,
                    homeLat: r.lat,
                    homeLng: r.lng,
                  }));
                }}
              />
            </label>
            <label>
              <span>Transport</span>
              <select
                value={profile.transportType ?? 'bus'}
                onChange={(e) => set('transportType', e.target.value as UserProfile['transportType'])}
              >
                {TRANSPORTS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Wake time</span>
              <input type="time" value={profile.defaultWakeTime ?? '07:00'} onChange={(e) => set('defaultWakeTime', e.target.value)} />
            </label>
            <label>
              <span>Sleep time</span>
              <input type="time" value={profile.sleepTime ?? '23:00'} onChange={(e) => set('sleepTime', e.target.value)} />
            </label>
            <label>
              <span>Morning routine (min)</span>
              <input
                type="number"
                value={profile.morningRoutineMinutes ?? 45}
                onChange={(e) => set('morningRoutineMinutes', Number(e.target.value))}
              />
            </label>
            <label>
              <span>Wake buffer (min)</span>
              <input
                type="number"
                value={profile.wakeBufferMinutes ?? 15}
                onChange={(e) => set('wakeBufferMinutes', Number(e.target.value))}
              />
            </label>
            <label>
              <span>Language</span>
              <select value={profile.language ?? 'en'} onChange={(e) => set('language', e.target.value as 'en' | 'he')}>
                <option value="en">English</option>
                <option value="he">עברית</option>
              </select>
            </label>
          </div>
        )}

        {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}

        <div className="drawer-foot">
          {savedMsg && <span className="saved-msg">Saved ✓</span>}
          <button className="btn btn-primary" onClick={save} disabled={busy || loading}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </aside>
    </div>
  );
}
