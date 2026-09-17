/**
 * PersonalityHandoffService — client for the WhatsApp→app quiz handoff:
 * resolves a one-time lumi://personality?token=… link and reports completion.
 *
 * Dependencies: EXPO_PUBLIC_SERVER_URL (FastAPI backend); server counterpart
 * is server/personality_handoff.py + /personality/* routes in server/main.py.
 * Consumed by PersonalityHandoffScreen.
 */
import { MBTIType } from '../types';

import { authedFetch } from './serverAuth';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

/** Resolved handoff payload from the server: user id + any known MBTI type/confidence. */
export interface HandoffState {
  userId: string;
  mbtiType: MBTIType | null;
  mbtiConfidence: number;
}

/** Resolve a one-time lumi://personality?token=... link into who's finishing the quiz. */
export async function resolveHandoff(token: string): Promise<HandoffState | null> {
  if (!SERVER_URL) return null;
  try {
    const res = await fetch(`${SERVER_URL}/personality/resolve?token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return { userId: data.user_id, mbtiType: data.mbti_type ?? null, mbtiConfidence: data.mbti_confidence ?? 0.4 };
  } catch {
    return null;
  }
}

/** Tell the WhatsApp side the quiz was completed in-app, so both surfaces agree. */
export async function completeHandoff(userId: string, mbtiType: MBTIType): Promise<boolean> {
  if (!SERVER_URL) return false;
  try {
    // Server writes to the VERIFIED caller's account; user_id is only cross-checked.
    const res = await authedFetch(`${SERVER_URL}/personality/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, mbti_type: mbtiType }),
    });
    return !!res && res.ok;
  } catch {
    return false;
  }
}
