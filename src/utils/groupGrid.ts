/**
 * groupGrid — the words and marks of "find time together" (Feature 3, option A grid).
 * Pure: tests/run-groups.ts.
 *
 * A cell is ✓ / ✗ / ?. "?" carries WHY in a small label (waiting / couldn't check /
 * declined / past) — an unknown is never drawn as a no (silent-state rule 1).
 * "said" marks an answer the person gave herself, as opposed to Meira's check.
 */
import type { GroupCell, GroupListItem, GroupSlot } from '../services/LumiServer';

const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function slotLabel(s: { day: string; start: string }, he: boolean): string {
  const d = new Date(`${s.day}T12:00:00`);
  const day = (he ? DAYS_HE : DAYS_EN)[d.getDay()];
  return `${day} ${d.getDate()}.${d.getMonth() + 1} ${s.start}`;
}

export function cellMark(c: GroupCell): '✓' | '✗' | '?' {
  return c.value === 'yes' ? '✓' : c.value === 'no' ? '✗' : '?';
}

export function cellNote(c: GroupCell, he: boolean): string {
  switch (c.source) {
    case 'manual': return he ? 'אמר/ה' : 'said';
    case 'waiting': return he ? 'ממתין' : 'waiting';
    case 'declined': return he ? 'לא מצטרף' : 'declined';
    case 'no_data': return he ? 'לא נבדק' : "couldn't check";
    case 'past': return he ? 'עבר' : 'past';
    default: return '';
  }
}

/** The share message for one member's personal link. */
export function inviteMessage(title: string, link: string, organizer: string, he: boolean): string {
  return he
    ? `${organizer ? `${organizer} ` : ''}מחפש/ת זמן ל${title || 'מפגש'} 👥 — סמנו מתי אתם פנויים: ${link}`
    : `${organizer ? `${organizer} is ` : ''}finding a time for ${title || 'a get-together'} 👥 — tick when you're free: ${link}`;
}

/** Slots sorted, with the date checked: past or malformed are refused before sending. */
export function validSlots(slots: Array<{ day: string; start: string }>, today: string): Array<{ day: string; start: string }> {
  const seen = new Set<string>();
  return slots
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.day) && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) && s.day >= today)
    .filter((s) => { const k = `${s.day} ${s.start}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`))
    .slice(0, 6);
}

export function bestLabel(slots: GroupSlot[], best: string | null, he: boolean): string | null {
  const s = slots.find((x) => x.id === best);
  if (!s) return null;
  return he ? `לקבוע ל${slotLabel(s, true)}` : `Lock ${slotLabel(s, false)}`;
}

// ── the tick: what to tell her about her groups ──

export interface GroupSeen {
  invites?: string[];     // group ids she was told about
  reminded?: string[];    // invites reminded after 24h
  ready?: string[];       // own groups announced as "everyone answered"
}

export function inviteNotices(groups: GroupListItem[], seen: GroupSeen, now: number): {
  fresh: GroupListItem[]; remind: GroupListItem[];
} {
  const invited = groups.filter((g) => g.role === 'member' && g.myStatus === 'invited' && g.status === 'open');
  const told = new Set(seen.invites ?? []);
  const reminded = new Set(seen.reminded ?? []);
  const fresh = invited.filter((g) => !told.has(g.id));
  const remind = invited.filter((g) => told.has(g.id) && !reminded.has(g.id)
    && g.createdAt && now - Date.parse(g.createdAt) >= 24 * 3600_000);
  return { fresh, remind };
}
