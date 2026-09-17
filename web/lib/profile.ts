'use client';

import { supabase } from './supabaseClient';

// Mirrors the public.user_profiles row (shared with the mobile app).
export interface UserProfile {
  userId: string;
  name: string;
  language: 'en' | 'he';
  theme: 'light' | 'dark';
  transportType: 'bus' | 'car' | 'walk' | 'bike';
  morningRoutineMinutes: number;
  wakeBufferMinutes: number;
  homeAddress: string;
  homeLat: number;
  homeLng: number;
  defaultWakeTime: string; // HH:MM
  sleepTime: string; // HH:MM
  googleConnected: boolean;
  createdAt: number;
}

const COLUMNS =
  'userId,name,language,theme,transportType,morningRoutineMinutes,wakeBufferMinutes,homeAddress,homeLat,homeLng,defaultWakeTime,sleepTime,googleConnected,createdAt';

export async function fetchProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select(COLUMNS)
    .eq('userId', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as UserProfile) ?? null;
}

// Insert-or-update the caller's own profile row.
export async function upsertProfile(
  userId: string,
  patch: Partial<UserProfile>,
): Promise<UserProfile> {
  const row = {
    userId,
    createdAt: patch.createdAt ?? Date.now(),
    ...patch,
  };
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(row, { onConflict: 'userId' })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as UserProfile;
}
