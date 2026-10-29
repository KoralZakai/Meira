/**
 * DemoDay — a full, realistic day on a fresh account, for judges and demos.
 *
 * A reviewer signs in with an empty account and no Google calendar. Menu →
 * "Load demo day" creates tasks timed from NOW, so every feature has something
 * to act on whenever it is pressed:
 *   - a meeting across town in ~70 min → route, leave time, wake/leave alerts
 *   - coffee in Herzliya 15 min after it → "not enough time to get there"
 *   - karaoke tonight → Meira prepares songs (Tavily)
 *   - a clinic visit tomorrow morning → what to bring and ask; the wake alarm
 *   - errands with no place (laundry, the coffee machine, a parcel) → "On your
 *     way" finds places on those routes, open when she passes
 * Real addresses with known coordinates, so routing starts at once.
 *
 * Created through addTask, like anything she types; the ids are remembered so
 * "Clear demo day" removes exactly these and nothing of hers.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { addTask, deleteTasks } from './TaskStorage';
import { ensureTravelChain, dateOffset } from './GoogleSync';
import { Task, AppLanguage } from '../types/index';
import { getTodayString } from '../utils/timeUtils';

const IDS_KEY = 'lumi.demoDay.ids.v1';

const place = (address: string, displayName: string, lat: number, lng: number) =>
  ({ address, displayName, lat, lng, confirmed: true }) as any;

/** HH:MM, `minutes` from now, rounded up to the next 5. */
function fromNow(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const m = Math.ceil(d.getMinutes() / 5) * 5;
  d.setMinutes(m, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function base(text: string, extra: Partial<Task>): Omit<Task, 'id' | 'createdAt' | 'completedAt'> {
  return {
    text, category: 'general', priority: 'need_to', isFixed: false,
    durationMinutes: 30, date: getTodayString(), status: 'pending',
    historicalDurations: [], source: 'manual',
    ...extra,
  } as any;
}

export async function loadDemoDay(lang: AppLanguage): Promise<{ created: number; error?: string }> {
  const today = getTodayString();
  const tomorrow = dateOffset(1);
  const soon = fromNow(70);
  // Late in the evening the day would spill past midnight: the demo day is
  // tomorrow morning instead, so every time on it is a real one.
  const late = Number(soon.split(':')[0]) >= 20 || Number(soon.split(':')[0]) < 6;
  const meetAt = late ? '10:00' : soon;
  const dayOf = late ? tomorrow : today;
  const [mh, mm] = meetAt.split(':').map(Number);
  const coffeeAt = `${String(mh + 1).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  const tasks = [
    base('Meeting — Nebius team', {
      category: 'meeting', priority: 'must', isFixed: true, fixedTime: meetAt, durationMinutes: 45,
      date: dayOf, location: place('Azrieli Center, Derech Menachem Begin 132, Tel Aviv-Yafo', 'Azrieli Center', 32.0745, 34.7920),
    }),
    base('Coffee with Dana', {
      category: 'meeting', priority: 'have_to', isFixed: true, fixedTime: coffeeAt, durationMinutes: 45,
      date: dayOf, location: place('Herzliya Pituah Marina, Herzliya', 'Herzliya Marina', 32.1640, 34.7960),
    }),
    base('Karaoke with friends', {
      category: 'leisure', priority: 'nice_to_do', isFixed: true, fixedTime: '21:30', durationMinutes: 120,
      date: dayOf, location: place('Allenby St 30, Tel Aviv-Yafo', 'Allenby 30', 32.0686, 34.7704),
    }),
    base('Dentist — Dr. Levi', {
      category: 'doctor', priority: 'must', isFixed: true, fixedTime: '09:30', durationMinutes: 45,
      date: tomorrow, location: place('Ibn Gabirol St 120, Tel Aviv-Yafo', 'Ibn Gabirol 120', 32.0870, 34.7818),
    }),
    base('Laundry', { durationMinutes: 30 }),
    base('Fix the coffee machine', { durationMinutes: 20 }),
    base('Pick up a parcel from the post office', { durationMinutes: 15 }),
  ];

  const ids: string[] = [];
  try {
    for (const t of tasks) ids.push((await addTask(t)).id);
  } catch (e) {
    console.warn('[DemoDay] could not create', e);
    return { created: ids.length, error: String(e) };
  } finally {
    const prev = await readIds();
    await AsyncStorage.setItem(IDS_KEY, JSON.stringify([...prev, ...ids])).catch((e) =>
      console.warn('[DemoDay] ids not saved', e));
  }
  // Routes, leave times and alerts — the same chain a real day gets.
  for (const d of new Set([dayOf, tomorrow])) {
    await ensureTravelChain(d, lang).catch((e) => console.warn('[DemoDay] travel chain', d, e));
  }
  return { created: ids.length };
}

async function readIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(IDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('[DemoDay] ids unreadable', e);
    return [];
  }
}

/** Remove exactly the demo tasks — nothing she created herself. */
export async function clearDemoDay(): Promise<number> {
  const ids = await readIds();
  const removed = ids.length ? await deleteTasks(ids) : 0;
  await AsyncStorage.removeItem(IDS_KEY).catch((e) => console.warn('[DemoDay] ids not cleared', e));
  return removed;
}
