/**
 * RulesCache — the rules she taught Meira, kept on the phone (server/user_rules).
 *
 * Read on every routine load (GapFillService → utils/routinePolicy), so it is
 * a cache, refreshed when the app comes to the front and after she confirms or
 * removes one. A failed refresh keeps the last list AND says why (rule 1):
 * "no rules" and "could not ask" must not look the same in You.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { LearnedRule, listRules } from './LumiServer';

const RULES_KEY = 'lumi.rules.v1';

export interface RulesSnapshot {
  rules: LearnedRule[];
  /** When the list last came from the server; 0 = never. */
  at: number;
  /** Why the last refresh failed, in words. */
  error?: string;
}

export async function cachedRules(): Promise<RulesSnapshot> {
  try {
    const raw = await AsyncStorage.getItem(RULES_KEY);
    return raw ? JSON.parse(raw) : { rules: [], at: 0 };
  } catch (e) {
    console.warn('[Rules] cache unreadable', e);
    return { rules: [], at: 0, error: 'unreadable on this phone' };
  }
}

async function write(s: RulesSnapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(RULES_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('[Rules] cache not written', e);
  }
}

export async function refreshRules(): Promise<RulesSnapshot> {
  const got = await listRules();
  if (got.ok) {
    const snap = { rules: got.data.rules || [], at: Date.now() };
    await write(snap);
    return snap;
  }
  const last = await cachedRules();
  const snap = { ...last, error: got.reason };
  await write(snap);
  return snap;
}
