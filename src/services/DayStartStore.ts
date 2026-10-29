/**
 * DayStartStore — "tomorrow I leave from here" (17.10).
 *
 * A day that has not begun starts at home in the travel chain, because home is
 * the only start Meira can know. When she has asked and Koral answered "from
 * here" (questions/kinds/tripOrigin), the answer lives here: date → the place
 * she named, read by GoogleSync.ensureTravelChain through utils/tripStart.
 *
 * Phone only, encrypted at rest (EncryptedStorage) and never synced: where she
 * IS is used, never kept (utils/cloudPrivacy). Old dates fall off — a
 * start that was true last Tuesday says nothing about this one.
 *
 * Unreadable is not "no override" (silent-state rule 1): a storage that
 * throws propagates, so the caller can say it planned from home BECAUSE it could
 * not read; a value that does not parse is warned about and treated as empty.
 *
 * The logic is `makeDayStartStore(kv)` over any key-value store so
 * tests/run-tomorrow-start.ts can run it with a Map; the exports below are
 * bound to the real one.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { hasRealCoords } from '../utils/placeCoords';
import type { DayStart } from '../utils/tripStart';

export const DAY_START_KEY = 'lumi.dayStart.v1';
/** How many dates are kept — the newest. */
export const KEEP_DATES = 14;

export interface KeyValue {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Only well-formed rows survive a read: a real date and a real position. */
function sane(raw: unknown): Record<string, DayStart> {
  const out: Record<string, DayStart> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [date, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = v as Partial<DayStart> | null;
    if (!DATE_RE.test(date) || !s || typeof s !== 'object') continue;
    if (!hasRealCoords(s.lat as number, s.lng as number)) continue;
    out[date] = {
      lat: Number(s.lat), lng: Number(s.lng),
      ...(typeof s.label === 'string' && s.label.trim() ? { label: s.label.trim() } : {}),
      ...(typeof s.setAt === 'number' ? { setAt: s.setAt } : {}),
    };
  }
  return out;
}

export function makeDayStartStore(kv: KeyValue) {
  // One JS thread racing itself is how the task list lost writes once already.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function readAll(): Promise<Record<string, DayStart>> {
    const raw = await kv.getItem(DAY_START_KEY);   // a throw is the caller's to report
    if (!raw) return {};
    try {
      return sane(JSON.parse(raw));
    } catch (e) {
      console.warn('[DayStart] stored starts unreadable; treated as none', e);
      return {};
    }
  }

  const keepNewest = (all: Record<string, DayStart>): Record<string, DayStart> =>
    Object.fromEntries(Object.entries(all).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, KEEP_DATES));

  return {
    all: readAll,
    async get(date: string): Promise<DayStart | null> {
      return (await readAll())[date] ?? null;
    },
    /** Remember where `date` starts. Throws on a position that is not one. */
    set(date: string, start: DayStart): Promise<void> {
      if (!DATE_RE.test(date)) return Promise.reject(new Error(`not a date: ${date}`));
      if (!hasRealCoords(start.lat, start.lng)) return Promise.reject(new Error('not a real position'));
      return locked(async () => {
        const all = await readAll();
        all[date] = {
          lat: start.lat, lng: start.lng,
          ...(start.label?.trim() ? { label: start.label.trim() } : {}),
          setAt: start.setAt ?? Date.now(),
        };
        await kv.setItem(DAY_START_KEY, JSON.stringify(keepNewest(all)));
      });
    },
    /** Forget `date`'s start. true = there was one. */
    clear(date: string): Promise<boolean> {
      return locked(async () => {
        const all = await readAll();
        if (!all[date]) return false;
        delete all[date];
        await kv.setItem(DAY_START_KEY, JSON.stringify(all));
        return true;
      });
    },
  };
}

const store = makeDayStartStore(AsyncStorage);

export const getDayStart = (date: string): Promise<DayStart | null> => store.get(date);
export const setDayStart = (date: string, start: DayStart): Promise<void> => store.set(date, start);
export const clearDayStart = (date: string): Promise<boolean> => store.clear(date);
