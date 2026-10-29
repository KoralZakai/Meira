/**
 * AddUnderstandService — the Add screen's two server questions.
 *
 *   addUnderstand     POST /app/add/understand   Meira's conclusions for a sentence
 *   errandsOnTheWay   POST /app/errands/along    {rules_only}: which place on a
 *                     planned journey suits an errand — decided by the words,
 *                     no model call, no web search per place
 *
 * Kept out of LumiServer on purpose: that module's `call()` answers every
 * failure with `null`, so "you are offline", "the server is down" and "today's
 * AI requests are used up" are one and the same value. This screen has to tell
 * a person which of them it was (CLAUDE.md, silent-state rule 1), so each
 * failure here has its own reason.
 *
 * Identity is the Supabase access token, checked by Supabase on the server —
 * never a phone number in the body. The contact's phone number never goes up
 * at all: the body carries `hasPhone`, a boolean; the WhatsApp link is built on
 * this device (utils/addConclusions.waLink).
 */
import { getSession } from './SupabaseAuthService';
import type { ErrandsResult, ErrandTrip } from './LumiServer';
import { sanitizeConclusions, type UnderstandResult } from '../utils/addConclusions';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

const UNDERSTAND_TIMEOUT_MS = 30_000;
const ERRANDS_TIMEOUT_MS = 45_000;

type Failure = 'no_server' | 'signed_out' | 'offline' | 'slow' | 'rate_limited' | 'server_error';

async function post(
  path: string, body: unknown, timeoutMs: number,
): Promise<{ ok: true; body: any } | { ok: false; reason: Failure; status?: number }> {
  if (!SERVER_URL) return { ok: false, reason: 'no_server' };
  let token: string | undefined;
  try {
    token = (await getSession())?.access_token;
  } catch (e) {
    console.warn('[AddServer] could not read the session', e);
  }
  if (!token) return { ok: false, reason: 'signed_out' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 429) return { ok: false, reason: 'rate_limited', status: 429 };
    if (!res.ok) {
      console.warn('[AddServer]', path, 'said', res.status);
      return { ok: false, reason: 'server_error', status: res.status };
    }
    return { ok: true, body: await res.json() };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || controller.signal.aborted;
    console.warn('[AddServer]', path, aborted ? 'timed out' : 'failed', e);
    return { ok: false, reason: aborted ? 'slow' : 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

export interface UnderstandPayload {
  text: string;
  lang: 'he' | 'en';
  /** The chips — what the phone already read for itself. */
  parsed: {
    category: string;
    time?: string; endTime?: string; date?: string;
    person?: { label: string; relation?: string; hasPhone: boolean };
    place?: string;
    occasion?: string;
  };
  context: {
    now: string;
    here_label?: string;
    tomorrow: Array<{ text: string; time?: string; place?: string }>;
  };
}

/** Meira's conclusions for what she is typing. Never throws; every failure has a reason. */
export async function addUnderstand(payload: UnderstandPayload): Promise<UnderstandResult> {
  const r = await post('/app/add/understand', payload, UNDERSTAND_TIMEOUT_MS);
  if (!r.ok) {
    return { ok: false, reason: r.reason === 'rate_limited' ? 'rate_limited' : r.reason === 'no_server' || r.reason === 'signed_out' ? 'no_server' : 'model_unavailable' };
  }
  const b = r.body;
  if (!b || b.ok !== true) {
    const reason = ['ai_limit', 'model_unavailable', 'bad_output', 'too_short'].includes(b?.reason) ? b.reason : 'model_unavailable';
    console.warn('[AddUnderstand] the server could not conclude:', b?.reason ?? 'no reason given');
    return { ok: false, reason };
  }
  const g = b.greeting;
  const greeting = g && typeof g.text_he === 'string' && typeof g.text_en === 'string' && typeof g.to === 'string'
    ? { to: g.to, text_he: g.text_he, text_en: g.text_en } : undefined;
  return { ok: true, conclusions: sanitizeConclusions(b.conclusions), greeting, model_used: Boolean(b.model_used) };
}

export type ErrandsOutcome = ErrandsResult | { ok: false; reason: Failure };

/** Places ON her planned journeys for an errand the rule table recognises. */
export async function errandsOnTheWay(text: string, trips: ErrandTrip[]): Promise<ErrandsOutcome> {
  const r = await post('/app/errands/along', { task: { text }, trips, rules_only: true }, ERRANDS_TIMEOUT_MS);
  if (!r.ok) return { ok: false, reason: r.reason };
  return r.body as ErrandsResult;
}
