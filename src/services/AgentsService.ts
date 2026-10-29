/**
 * AgentsService — REST client for the user's personal agents (the "Agent
 * Builder"): list/install/create/update/delete against the Lumi server.
 *
 * An agent runs SERVER-side (server/agent_runner.py fires it on schedule and
 * messages the user on WhatsApp) — the app is only the management UI.
 *
 * Dependencies: EXPO_PUBLIC_SERVER_URL. Server counterpart: server/main.py
 * /agents endpoints + server/agents_store.py. Consumed by AgentsScreen.
 */

import { authedFetch } from './serverAuth';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

export interface AgentSchedule {
  days: number[]; // Python weekday ints: Monday=0 .. Sunday=6
  time: string;   // HH:MM Israel local
}

export interface LumiAgent {
  id: string;
  name: string;
  emoji: string;
  soul: string;
  template: string | null;
  schedule: AgentSchedule;
  enabled: boolean;
  next_run: string | null;
  last_run: string | null;
  run_count: number;
}

export interface AgentTemplate {
  id: string;
  name: string;
  emoji: string;
  soul: string;
  schedule: AgentSchedule;
}

const clean = (phone: string) => (phone || '').replace(/[^\d]/g, '');

// Every /agents route requires the Supabase token now; authedFetch returns
// null when signed out, which each caller maps to its existing empty result.

/**
 * The agents, or WHY they could not be read. An empty list and a dead server
 * must not look the same — she would think she has no agents (rule 1).
 */
export async function listAgents(
  phone: string,
): Promise<{ agents: LumiAgent[]; templates: AgentTemplate[]; max: number; error?: string }> {
  const empty = { agents: [], templates: [], max: 5 };
  if (!SERVER_URL) return { ...empty, error: 'no server' };
  if (!clean(phone)) return { ...empty, error: 'no phone' };
  try {
    const res = await authedFetch(`${SERVER_URL}/agents/${clean(phone)}`);
    if (!res) return { ...empty, error: 'signed out' };
    if (!res.ok) return { ...empty, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    console.warn('[Agents] list failed', e);
    return { ...empty, error: 'network' };
  }
}

/** Install a template ({template}) or create a custom agent ({name, soul, days, time}). */
export async function createAgent(
  phone: string,
  def: { template?: string; name?: string; soul?: string; days?: number[]; time?: string; emoji?: string },
): Promise<{ agent?: LumiAgent; error?: string }> {
  if (!SERVER_URL || !clean(phone)) return { error: 'no server' };
  try {
    const res = await authedFetch(`${SERVER_URL}/agents/${clean(phone)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    });
    if (!res) return { error: 'signed out' };
    return await res.json();
  } catch (e) {
    console.warn('[Agents] create failed', e);
    return { error: 'network' };
  }
}

export async function updateAgent(
  phone: string,
  agentId: string,
  patch: Partial<{ enabled: boolean; days: number[]; time: string; soul: string; name: string; emoji: string }>,
): Promise<LumiAgent | null> {
  if (!SERVER_URL || !clean(phone)) return null;
  try {
    const res = await authedFetch(`${SERVER_URL}/agents/${clean(phone)}/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res || !res.ok) return null;
    return (await res.json()).agent ?? null;
  } catch (e) {
    console.warn('[Agents] update failed', e);
    return null;
  }
}

export async function deleteAgent(phone: string, agentId: string): Promise<boolean> {
  if (!SERVER_URL || !clean(phone)) return false;
  try {
    const res = await authedFetch(`${SERVER_URL}/agents/${clean(phone)}/${agentId}`, { method: 'DELETE' });
    return !!res && res.ok;
  } catch (e) {
    console.warn('[Agents] delete failed', e);
    return false;
  }
}

/** Run one agent now — its message goes to WhatsApp. Returns the reason on failure. */
export async function runAgentNow(phone: string, agentId: string): Promise<{ ok?: boolean; error?: string }> {
  if (!SERVER_URL || !clean(phone)) return { error: 'no server' };
  try {
    const res = await authedFetch(`${SERVER_URL}/agents/${clean(phone)}/${agentId}/run`, { method: 'POST' });
    if (!res) return { error: 'signed out' };
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true } : { error: body.error || `HTTP ${res.status}` };
  } catch (e) {
    console.warn('[Agents] run failed', e);
    return { error: 'network' };
  }
}
