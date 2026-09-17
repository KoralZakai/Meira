/** useDailyCheckIn — tracks which daily check-ins (morning/afternoon/evening) are done. Depends on TaskStorage daily logs. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { DailyLog, AppSettings, CheckInType } from '../types/models';
import {
  DEFAULT_SETTINGS,
  getDailyLog,
  getSettings,
  saveDailyLog,
  saveSettings,
  toDateKey,
} from '../services/TaskStorage';

function toMinutes(hour: number, minute: number) {
  return hour * 60 + minute;
}

export function useDailyCheckIn() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [log, setLog] = useState<DailyLog | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const today = toDateKey();

  const load = useCallback(async () => {
    const [s, l] = await Promise.all([getSettings(), getDailyLog(today)]);
    setSettings(s);
    setLog(l);
    setIsLoaded(true);
  }, [today]);

  useEffect(() => {
    load();
  }, [load]);

  const updateSettings = useCallback(async (next: AppSettings) => {
    await saveSettings(next);
    setSettings(next);
  }, []);

  const markDone = useCallback(
    async (type: CheckInType) => {
      if (!log) {
        return;
      }

      const next: DailyLog = {
        ...log,
        morningDone: type === 'morning' ? true : log.morningDone,
        afternoonDone: type === 'afternoon' ? true : log.afternoonDone,
        eveningDone: type === 'evening' ? true : log.eveningDone,
      };

      await saveDailyLog(next);
      setLog(next);
    },
    [log],
  );

  const [androidForegroundTriggered, setAndroidForegroundTriggered] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const onState = (state: AppStateStatus) => {
      if (state === 'active') {
        setAndroidForegroundTriggered(true);
      }
    };

    const sub = AppState.addEventListener('change', onState);
    return () => sub.remove();
  }, []);

  const pendingCheckIn = useMemo<CheckInType | null>(() => {
    if (!log) {
      return null;
    }

    const now = new Date();
    const nowMinutes = toMinutes(now.getHours(), now.getMinutes());

    const morningStart = toMinutes(settings.androidMorningWindowStart, 0);
    const morningEnd = toMinutes(settings.androidMorningWindowEnd, 0);
    const afternoonAt = toMinutes(settings.afternoonTime.hour, settings.afternoonTime.minute);
    const eveningAt = toMinutes(settings.eveningTime.hour, settings.eveningTime.minute);

    const inMorningWindow = nowMinutes >= morningStart && nowMinutes <= morningEnd;

    const shouldForceMorningOnAndroid =
      Platform.OS === 'android' && inMorningWindow && androidForegroundTriggered;

    if (!log.morningDone && (inMorningWindow || shouldForceMorningOnAndroid)) {
      return 'morning';
    }

    if (!log.afternoonDone && nowMinutes >= afternoonAt && nowMinutes < eveningAt) {
      return 'afternoon';
    }

    if (!log.eveningDone && nowMinutes >= eveningAt) {
      return 'evening';
    }

    return null;
  }, [androidForegroundTriggered, log, settings]);

  return {
    isLoaded,
    settings,
    log,
    pendingCheckIn,
    updateSettings,
    markDone,
    reload: load,
  };
}
