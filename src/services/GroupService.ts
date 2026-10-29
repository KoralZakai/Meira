/**
 * GroupService — the trigger for "find time together" (Feature 3, rule 7).
 *
 * `groupTick` runs from CalendarAutoSync on every sync path (launch, foreground,
 * heartbeat, pull-to-refresh, the closed-app job). It tells her, once each:
 *  - a new invite ("Dana is finding a time: party") — the server also pushes,
 *    but a push needs a registered token; this does not;
 *  - an invite still unanswered after 24h (one reminder);
 *  - for a group she organizes: everyone has answered → go lock it.
 */
import AsyncStorage from './EncryptedStorage';
import { groupList, groupView } from './LumiServer';
import { sendImmediate } from './NotificationService';
import { inviteNotices, type GroupSeen } from '../utils/groupGrid';
import type { AppLanguage } from '../types/index';

const SEEN_KEY = 'lumi.groups.seen.v1';
const MAX_VIEWS = 3;

async function readSeen(): Promise<GroupSeen> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as GroupSeen) : {};
  } catch {
    console.warn('[Groups] seen state unreadable — starting fresh');
    return {};
  }
}

export async function groupTick(language: AppLanguage, now = Date.now()): Promise<{ notified: number; error?: string }> {
  const he = language === 'he';
  const r = await groupList();
  if (!r.ok) return { notified: 0, error: r.reason };
  if (!r.data.ok) return { notified: 0, error: r.data.reason };
  const groups = r.data.groups ?? [];
  const seen = await readSeen();
  let notified = 0;

  const { fresh, remind } = inviteNotices(groups, seen, now);
  for (const g of fresh) {
    await sendImmediate(he ? '👥 הזמנה למצוא זמן' : '👥 Finding a time', `${g.title || (he ? 'מפגש' : 'Get-together')} — ${he ? 'מתי את פנויה?' : 'when are you free?'}`,
      { screen: 'FindTime', groupId: g.id });
    notified += 1;
  }
  for (const g of remind) {
    await sendImmediate(he ? '👥 עוד מחכים לך' : '👥 Still waiting for you', `${g.title || ''} — ${he ? 'כן או לא, לוקח 10 שניות' : 'yes or no, takes 10 seconds'}`,
      { screen: 'FindTime', groupId: g.id });
    notified += 1;
  }
  seen.invites = [...new Set([...(seen.invites ?? []), ...fresh.map((g) => g.id)])].slice(-200);
  seen.reminded = [...new Set([...(seen.reminded ?? []), ...remind.map((g) => g.id)])].slice(-200);

  const ready = new Set(seen.ready ?? []);
  const mine = groups.filter((g) => g.role === 'owner' && g.status === 'open' && !ready.has(g.id)).slice(0, MAX_VIEWS);
  for (const g of mine) {
    const v = await groupView(g.id);
    if (!v.ok) { console.warn('[Groups] view failed', v.reason); continue; }
    if (v.data.ok && v.data.role === 'owner' && v.data.everyone_answered) {
      await sendImmediate(he ? '👥 כולם ענו' : '👥 Everyone answered', `${g.title || ''} — ${he ? 'הגיע הזמן לקבוע' : 'time to lock it'}`,
        { screen: 'FindTime', groupId: g.id });
      ready.add(g.id);
      notified += 1;
    }
  }
  seen.ready = [...ready].slice(-200);
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(seen)).catch(() => {});
  return { notified };
}
