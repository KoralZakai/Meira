/**
 * useAppLanguage — the app language, read once and kept current.
 *
 * Several new surfaces (tab bar, sheets) need "he or en" and none of them
 * owned it; each screen used to read getSettings() on its own. `refresh`
 * re-reads after the Menu changes the language.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppLanguage } from '../types';
import { getSettings } from '../services/TaskStorage';

const listeners = new Set<(lang: AppLanguage) => void>();

/** Tell every mounted surface the language changed (the Menu calls this). */
export function announceLanguage(lang: AppLanguage): void {
  listeners.forEach((fn) => fn(lang));
}

export function useAppLanguage(): { language: AppLanguage; he: boolean; refresh: () => void } {
  const [language, setLanguage] = useState<AppLanguage>('en');
  const refresh = useCallback(() => {
    getSettings()
      .then((s) => setLanguage(s?.language === 'he' ? 'he' : 'en'))
      .catch((e) => console.warn('[useAppLanguage] settings unreadable', e));
  }, []);
  useEffect(() => {
    refresh();
    listeners.add(setLanguage);
    return () => { listeners.delete(setLanguage); };
  }, [refresh]);
  return { language, he: language === 'he', refresh };
}
