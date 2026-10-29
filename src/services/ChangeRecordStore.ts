/**
 * ChangeRecordStore — the cards Today shows when the CALENDAR moved something (19.10).
 *
 * WHO WRITES: GoogleSync's reconcile, the moment Google (or the phone's calendar, or Outlook —
 * they all go through it) says a row is on a different day or hour than it was. That runs on
 * every sync path: launch, foreground, heartbeat, pull-to-refresh and the closed-app
 * WorkManager job — so a card is waiting when she opens the app even if nothing was open.
 * WHO READS: components/ChangeCards, redrawn through onChangesChanged.
 *
 * Silent-state rule 1/2: a read or a write that fails says so (`error`), it does not return an
 * empty list that looks like "nothing moved". A card she closed stays closed — and so does the
 * same state arriving again from the next sync (the key holds the new day and hour).
 */
import AsyncStorage from './EncryptedStorage';
import { ChangeRecord, ChangeUi, isStillOpen } from '../utils/changeRecord';

const KEY = 'lumi.changes.v1';
const MAX_RECORDS = 20;

interface Stored { records: ChangeRecord[]; closed: string[] }

let listeners: Array<() => void> = [];
export function onChangesChanged(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}
const tell = () => { for (const l of listeners) { try { l(); } catch { /* a bad listener is not a failed write */ } } };

async function read(): Promise<{ data: Stored; error?: string }> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.records) && Array.isArray(parsed.closed)) return { data: parsed };
    return { data: { records: [], closed: [] } };
  } catch (e) {
    console.warn('[ChangeRecordStore] unreadable', e);
    return { data: { records: [], closed: [] }, error: String((e as Error)?.message || e) };
  }
}

async function write(data: Stored): Promise<string | undefined> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(data));
    return undefined;
  } catch (e) {
    console.warn('[ChangeRecordStore] write failed', e);
    return String((e as Error)?.message || e);
  }
}

/** Remember a change. A card she closed, or one already shown, is not raised twice. */
export async function recordChange(rec: ChangeRecord, today: string): Promise<{ added: boolean; error?: string }> {
  const { data, error } = await read();
  if (error) return { added: false, error };
  if (data.closed.includes(rec.key) || data.records.some((r) => r.key === rec.key)) return { added: false };
  // One card per task: a newer move replaces the older card of the same event.
  const records = [rec, ...data.records.filter((r) => r.taskId !== rec.taskId && isStillOpen(r, today))]
    .slice(0, MAX_RECORDS);
  const werr = await write({ records, closed: data.closed.slice(-100) });
  if (werr) return { added: false, error: werr };
  tell();
  return { added: true };
}

/** The cards to draw: open ones, newest first. `error` says the read failed (not "nothing moved"). */
export async function openChanges(today: string): Promise<{ records: ChangeRecord[]; error?: string }> {
  const { data, error } = await read();
  return { records: data.records.filter((r) => isStillOpen(r, today) && !data.closed.includes(r.key)), error };
}

export async function closeChange(key: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await read();
  if (error) return { ok: false, error };
  const werr = await write({
    records: data.records.filter((r) => r.key !== key),
    closed: [...data.closed.filter((k) => k !== key), key].slice(-100),
  });
  if (werr) return { ok: false, error: werr };
  tell();
  return { ok: true };
}

/** Remember how far the offer on a card has got (booked, asked the morning, declined). */
export async function setChangeUi(key: string, ui: ChangeUi): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await read();
  if (error) return { ok: false, error };
  if (!data.records.some((r) => r.key === key)) return { ok: false, error: 'not_found' };
  const werr = await write({ ...data, records: data.records.map((r) => (r.key === key ? { ...r, ui } : r)) });
  if (werr) return { ok: false, error: werr };
  tell();
  return { ok: true };
}

/** The cards were drawn on screen: from now on no notification is sent about them. */
export async function markSeen(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const { data, error } = await read();
  if (error) return;
  const now = Date.now();
  const touched = data.records.some((r) => keys.includes(r.key) && !r.seenAt);
  if (!touched) return;
  const werr = await write({ ...data, records: data.records.map((r) => (keys.includes(r.key) && !r.seenAt ? { ...r, seenAt: now } : r)) });
  if (werr) console.warn('[ChangeRecordStore] could not mark seen', werr);
}
