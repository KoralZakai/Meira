/**
 * profileFacts — "what Meira knows about you" (canvas v4, Profile).
 *
 * Every leave time and wake alarm is computed from a handful of profile
 * fields, and the Profile screen showed them as form rows, one per card, with
 * the gaps in red text further down. This is the same facts as one glance:
 * each says its value, where it came from (she said it / Meira learned it),
 * or — when it is not known — that it is not known (rule 1: a missing home
 * must never read like an empty field that does not matter).
 */
import type { UserProfile } from '../models/UserProfile';
import type { LineIconName } from '../components/ui/LineIcon';

export interface ProfileFact {
  key: string;
  icon: LineIconName;
  label: string;
  /** null = Meira does not know this yet. */
  value: string | null;
  source: 'you' | 'learned';
  /** Missing AND every route/alarm needs it. */
  needed?: boolean;
}

const MODE: Record<string, [LineIconName, string, string]> = {
  transit: ['bus', 'Public transport', 'תחבורה ציבורית'],
  car: ['car', 'Car', 'רכב'],
  bicycle: ['bike', 'Bike', 'אופניים'],
  foot: ['walk', 'Walking', 'הליכה'],
};

const isHHMM = (v?: string) => !!v && /^\d{1,2}:\d{2}$/.test(v);

export function profileFacts(p: Partial<UserProfile> | null | undefined, he: boolean): ProfileFact[] {
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const mode = MODE[p?.transportMode ?? ''];
  const homeKnown = !!(p?.homeAddress && p.homeAddress.trim());
  const facts: ProfileFact[] = [
    {
      key: 'home', icon: 'home', label: T('Home', 'בית'), source: 'you',
      value: homeKnown ? p!.homeAddress!.trim() : null, needed: !homeKnown,
    },
    {
      key: 'work', icon: 'work', label: T('Work / studies', 'עבודה / לימודים'), source: 'you',
      value: p?.workAddress?.trim() || null,
    },
    {
      key: 'transport', icon: mode ? mode[0] : 'bus', label: T('Getting around', 'איך מגיעה'), source: 'you',
      value: mode ? (he ? mode[2] : mode[1]) : null,
    },
    {
      key: 'car', icon: 'car', label: T('Car', 'רכב'), source: 'you',
      value: p?.hasCar === undefined ? null : p.hasCar ? T('Has a car', 'יש רכב') : T('No car', 'אין רכב'),
    },
    {
      key: 'wake', icon: 'alarm', label: T('Earliest wake', 'הכי מוקדם לקום'), source: 'you',
      value: isHHMM(p?.earliestWakeTime) ? p!.earliestWakeTime! : null,
    },
    {
      key: 'sleep', icon: 'moon', label: T('Bedtime', 'שעת שינה'), source: 'you',
      value: isHHMM(p?.sleepTime) ? p!.sleepTime! : null,
    },
    {
      key: 'routine', icon: 'coffee', label: T('Morning routine', 'שגרת בוקר'), source: 'you',
      value: p?.totalMorningRoutineMinutes ? T(`${p.totalMorningRoutineMinutes} min`, `${p.totalMorningRoutineMinutes} דק׳`) : null,
    },
  ];
  // Learned, never typed (utils/leadLearning) — shown only once there is a number.
  if (typeof p?.departDelayMinutes === 'number' && p.departDelayMinutes > 0) {
    facts.push({
      key: 'delay', icon: 'timer', label: T('You usually leave', 'בדרך כלל יוצאת'), source: 'learned',
      value: T(`${Math.round(p.departDelayMinutes)} min late`, `${Math.round(p.departDelayMinutes)} דק׳ אחרי הזמן`),
    });
  }
  return facts;
}

/** "5 of 7 known" — the header line; counts only the facts that can be missing. */
export function knownCount(facts: ProfileFact[]): { known: number; total: number } {
  const base = facts.filter((f) => f.source === 'you');
  return { known: base.filter((f) => f.value !== null).length, total: base.length };
}
