/**
 * ChangeNudgeService — the knock when the app is closed and the calendar moved something (19.10).
 *
 * TRIGGER (rule 7, "app closed"): called by the WorkManager job in CalendarAutoSync, right after
 * the sync that wrote the change records. The decision is utils/changeNudge (quiet hours, at
 * most two per change, never about a card she has seen); this file reads the cards, remembers
 * the knocks, and sends. Tapping the notification opens Today, where the card is.
 *
 * Skipped while the app is in front: she can see the card, and a banner on top of it is noise.
 */
import { AppState } from 'react-native';
import AsyncStorage from './EncryptedStorage';
import { openChanges } from './ChangeRecordStore';
import { sendImmediate } from './NotificationService';
import { NudgeLog, afterNudge, decideChangeNudge } from '../utils/changeNudge';
import { getTodayString } from '../utils/timeUtils';
import type { AppLanguage } from '../types/index';

const LOG_KEY = 'lumi.changeNudges.v1';

async function readLog(): Promise<NudgeLog> {
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.warn('[ChangeNudge] log unreadable — sending nothing rather than risk a repeat', e);
    throw e;
  }
}

/** -> what happened, so the caller (and the log line) can say it. */
export async function nudgeAboutChanges(language: AppLanguage): Promise<'sent' | 'held-quiet' | 'held-limit' | 'nothing' | 'app-open' | 'unreadable'> {
  if (AppState.currentState === 'active') return 'app-open';
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = getTodayString();
  const { records, error } = await openChanges(today);
  if (error) { console.warn('[ChangeNudge] cards unreadable:', error); return 'unreadable'; }
  let log: NudgeLog;
  try { log = await readLog(); } catch { return 'unreadable'; }
  const d = decideChangeNudge(records, log, now.getTime(), today, hhmm, language);
  if (!d.send) return d.held === 'quiet' ? 'held-quiet' : d.held === 'limit' ? 'held-limit' : 'nothing';
  try {
    await sendImmediate(d.send.title, d.send.body, { screen: 'Today', change: d.send.key });
  } catch (e) {
    console.warn('[ChangeNudge] could not send', e);
    return 'unreadable';   // not counted: the next run tries again
  }
  await AsyncStorage.setItem(LOG_KEY, JSON.stringify(afterNudge(log, d.send.key, now.getTime(), records.map((r) => r.key))))
    .catch((e) => console.warn('[ChangeNudge] could not record the knock', e));
  return 'sent';
}
