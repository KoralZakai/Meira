/**
 * MorningBriefingService — the spoken "wake-up call": composes a motivational
 * greeting + today's task list and (a) speaks it aloud via TTS, (b) schedules
 * an alarm-style notification that fires with sound even while the phone is
 * locked, carrying the same text.
 *
 * IMPORTANT constraint: TTS (expo-speech) only runs while the app's JS is
 * running. A locked-screen notification can play a sound and show the briefing
 * text, but it cannot make the phone SPEAK on its own — the speaking happens
 * when the app is open (the alarm tap routes here from App.tsx). A fully
 * self-speaking locked alarm would need a native alarm module outside Expo.
 *
 * Dependencies: SpeechService.speak (TTS), TaskStorage (getTasksForDate,
 * toDateKey, getSettings), UserProfileStorage.loadProfile (name/language),
 * constants/strings (motivational lines), NotificationService (alarm channel).
 * Consumed by SettingsScreen (test button) and App.tsx (morning alarm tap).
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { speak } from './SpeechService';
import { getTasksForDate, toDateKey, getSettings } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { scheduleWakeAlarm, PENDING_WAKE_BRIEFING_KEY } from './NotificationService';
import { AppLanguage } from '../types/models';
import { isPrepBlock } from '../utils/interviewPrep';
import { BriefingItem, buildMorningBriefing } from '../utils/dayBriefing';
export { buildMorningBriefing } from '../utils/dayBriefing';

/** Load today's tasks + profile and return the composed briefing text. */
export async function getTodaysBriefing(): Promise<{ text: string; language: AppLanguage }> {
  const settings = await getSettings();
  const language = settings.language;
  const profile = await loadProfile();
  const tasks = await getTasksForDate(toDateKey());
  const items: BriefingItem[] = tasks
    .filter((t) => t.status !== 'moved' && t.status !== 'complete')
    .map((t) => ({
      time: t.fixedTime || t.scheduledTime,
      text: t.text,
      leaveAt: typeof t.location === 'object' ? t.location?.leaveHomeBy : undefined,
      prep: isPrepBlock(t),
      category: t.category,
    }));
  return { text: buildMorningBriefing(profile?.name ?? 'there', items, language), language };
}

/** Speak today's briefing aloud right now. Returns the spoken text (for the test UI). */
export async function speakMorningBriefingNow(): Promise<string> {
  const { text, language } = await getTodaysBriefing();
  await speak(text, language);
  return text;
}

/** How long after the wake alarm an app-open still counts as "waking up". */
const WAKE_BRIEFING_WINDOW_MS = 60 * 60 * 1000;

/**
 * Auto-speak on app-open: if a wake alarm was scheduled (marker written by
 * NotificationService) and it fired within the last hour, recompose TODAY's
 * briefing fresh and speak it — no notification tap needed. Consumes the
 * marker so it speaks at most once per alarm. Called from App.tsx on
 * AppState 'active'. Returns true if it spoke.
 */
export async function maybeSpeakWakeBriefing(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_WAKE_BRIEFING_KEY);
    if (!raw) return false;
    const when = new Date(raw).getTime();
    if (Number.isNaN(when)) {
      await AsyncStorage.removeItem(PENDING_WAKE_BRIEFING_KEY);
      return false;
    }
    const now = Date.now();
    if (now < when) return false; // alarm hasn't fired yet — keep the marker
    await AsyncStorage.removeItem(PENDING_WAKE_BRIEFING_KEY); // consume
    if (now - when > WAKE_BRIEFING_WINDOW_MS) return false; // opened too late
    await speakMorningBriefingNow(); // recomposed fresh — today's actual tasks
    await markMorningSpoken(); // don't double up with the daily greeting
    return true;
  } catch (e) {
    console.log('[MorningBriefing] wake auto-speak failed:', e);
    return false;
  }
}

// Daily morning greeting: FIRST app open of the day inside the morning window
// speaks the briefing (day, date, hour, today's tasks) — no alarm needed.
const MORNING_SPOKEN_KEY = 'lumi.morningSpokenDate.v1';

async function markMorningSpoken(): Promise<void> {
  await AsyncStorage.setItem(MORNING_SPOKEN_KEY, toDateKey()).catch(() => {});
}

export async function maybeSpeakDailyMorningBriefing(): Promise<boolean> {
  try {
    const settings = await getSettings();
    const hour = new Date().getHours();
    const from = settings.androidMorningWindowStart ?? 6;
    const to = settings.androidMorningWindowEnd ?? 10;
    if (hour < from || hour >= Math.max(to, from + 1) + 2) return false; // window + grace
    if ((await AsyncStorage.getItem(MORNING_SPOKEN_KEY)) === toDateKey()) return false;
    await markMorningSpoken(); // set BEFORE speaking — never double-fire
    await speakMorningBriefingNow();
    return true;
  } catch (e) {
    console.log('[MorningBriefing] daily auto-speak failed:', e);
    return false;
  }
}

/**
 * Schedule a one-off wake-up alarm at a specific clock time (defaults to the
 * next 09:00). The notification body IS the briefing so it shows/sounds even
 * locked; opening it makes Lumi read the list aloud.
 * ponytail: composes from TODAY's tasks at schedule time — fine for a test;
 * a production daily alarm would recompose each morning.
 */
export async function scheduleWakeUpTest(hour = 9, minute = 0): Promise<Date> {
  const { text, language } = await getTodaysBriefing();
  const when = new Date();
  when.setHours(hour, minute, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1); // next occurrence
  const title = language === 'he' ? '⏰ בוקר טוב מלומי' : '⏰ Good morning from Lumi';
  // checkInType routes the tap to the morning screen; briefing tells App.tsx to speak.
  await scheduleWakeAlarm(title, text, when, { checkInType: 'morning', briefing: true });
  return when;
}
