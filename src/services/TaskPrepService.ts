/**
 * TaskPrepService — Meira prepares you for what is next, whatever it is.
 *
 * The meeting brief covers interviews and meetings. This covers the rest:
 * karaoke → songs to practise and where their lyrics are; a clinic → what to
 * bring and ask (server/task_prep.py decides whether anything is worth it).
 *
 * Cached on the device per task + wording, a refusal too ("laundry" is asked
 * once, not on every render). Never throws: Today must not fall over for this.
 *
 * Trigger (CLAUDE.md rule 7): Today asks for the pill's task whenever it
 * changes; the card is one tap from the pill.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { taskPrep, TaskPrepResult } from './LumiServer';
import { Task } from '../types/index';
import { addrOf } from '../utils/dayPlanning';

const CACHE_KEY = 'lumi.taskPrep.v1';
const TTL_MS = 2 * 24 * 60 * 60 * 1000;
const REFUSAL_TTL_MS = 6 * 60 * 60 * 1000;

interface Row { prep: TaskPrepResult; at: number }

const keyOf = (t: Task) => `${t.id}|${t.text.trim().toLowerCase()}`;

async function readCache(): Promise<Record<string, Row>> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('[TaskPrep] cache unreadable', e);
    return {};
  }
}

async function writeCache(map: Record<string, Row>): Promise<void> {
  try {
    const keys = Object.keys(map).sort((a, b) => map[b].at - map[a].at).slice(0, 30);
    const out: Record<string, Row> = {};
    keys.forEach((k) => { out[k] = map[k]; });
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(out));
  } catch (e) {
    console.warn('[TaskPrep] cache unwritable', e);
  }
}

/** The prep for a task, or null when there is none to show (with a warn saying why). */
export async function prepForTask(task: Task, force = false): Promise<TaskPrepResult | null> {
  const key = keyOf(task);
  const cache = await readCache();
  const row = cache[key];
  if (!force && row && Date.now() - row.at < (row.prep.ok ? TTL_MS : REFUSAL_TTL_MS)) {
    return row.prep.ok ? row.prep : null;
  }
  const res = await taskPrep({
    id: task.id,
    text: task.text,
    category: task.category,
    date: task.date,
    time: task.fixedTime || task.scheduledTime,
    location: addrOf(task) || undefined,
  }, force).catch((e) => {
    console.warn('[TaskPrep] request failed', e);
    return null;
  });
  if (!res) return null;            // no server / signed out / offline — not cached
  if (!res.ok && res.reason !== 'nothing_to_prepare') {
    console.warn('[TaskPrep] no prep:', res.reason, 'for task', task.id);
  }
  cache[key] = { prep: res, at: Date.now() };
  await writeCache(cache);
  return res.ok ? res : null;
}
