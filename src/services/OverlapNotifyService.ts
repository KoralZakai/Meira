/**
 * OverlapNotifyService — "2 events overlap; Meira suggests…" when nobody is looking.
 *
 * The popup lives on Today, so a clash booked on Sunday for Wednesday was only
 * found when she opened the right day. THE TRIGGER (rule 7) is the calendar
 * sync, which already runs on every path — launch, foreground, heartbeat,
 * pull-to-refresh and the closed-app WorkManager job (CalendarAutoSync calls
 * overlapTick at the end of each run). One local notification per pair, ever;
 * a pair she already answered on Today, or one that has begun, is skipped.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { loadProfile } from './UserProfileStorage';
import { sendImmediate } from './NotificationService';
import { newOverlaps, overlapNotification } from '../utils/overlapNote';
import { getTodayString } from '../utils/timeUtils';
import type { AppLanguage, Task } from '../types/index';

const TOLD_KEY = 'meira.overlapNotified.v1';
/** Today's own store of her answers (screens/TodaySchedule PROBLEM_ANSWERS_KEY). */
const ANSWERS_KEY = 'lumi.problemAnswers.v1';
const KEEP = 100;

/** `tasks` is the list the sync already loaded — no second (cloud) fetch. */
export async function overlapTick(language: AppLanguage, tasks: Task[]): Promise<{ notified: number; error?: string }> {
  try {
    const [profile, toldRaw, ansRaw] = await Promise.all([
      loadProfile().catch(() => null),
      AsyncStorage.getItem(TOLD_KEY), AsyncStorage.getItem(ANSWERS_KEY),
    ]);
    const told: Record<string, number> = toldRaw ? JSON.parse(toldRaw) : {};
    const answered = ansRaw ? JSON.parse(ansRaw) : {};
    const now = new Date();
    const found = newOverlaps(tasks, {
      today: getTodayString(),
      now: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      answered, told,
      home: profile?.homeLatLng ?? undefined,
    });
    // A release build drops console.log, and a check that says nothing cannot be told
    // from one that never ran (silent-state rule 3): one warn line per tick.
    console.warn(`[OverlapNotify] tick: ${tasks.length} tasks, ${found.length} new overlap(s)`);
    if (!found.length) return { notified: 0 };
    const he = language === 'he';
    const { title, body } = overlapNotification(found, he);
    // Mark BEFORE sending: a crash after the push must not mean the same push every 15 minutes.
    const next = { ...told };
    for (const f of found) next[f.key] = Date.now();
    await AsyncStorage.setItem(TOLD_KEY, JSON.stringify(Object.fromEntries(Object.entries(next).slice(-KEEP))));
    await sendImmediate(title, body, { type: 'overlap', date: found[0].date, key: found[0].key });
    return { notified: found.length };
  } catch (e) {
    // Rule 2: swallow the throw, return the reason.
    const error = String((e as Error)?.message || e).slice(0, 200);
    console.warn('[OverlapNotify] tick failed', error);
    return { notified: 0, error };
  }
}
