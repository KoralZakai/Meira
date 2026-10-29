/**
 * firstMeeting — the words and the checklist of Meira's first conversation
 * (8.10, Koral). The screen is OnboardingScreen; the questions are asked and
 * the answers understood on the server (profile_extract, which keeps asking
 * until every detail is covered). This file only turns what is known so far
 * into what she sees — pure, so tests/run-first-meeting.ts pins it.
 */
import { UserProfile } from '../models/UserProfile';
import { parseRoutineNotes, sameRoutine } from './routines';

/** What the server returns after each answer (camelCase, merged so far). */
export interface MeetingDraft {
  name?: string;
  wakeTime?: string;
  morningHabits?: Array<{ habit: string; estimatedMinutes: number }>;
  totalMorningMinutesEstimate?: number;
  morningConfirmed?: boolean;
  routines?: Array<{ what: string; place?: string | null; days?: string | null; time?: string | null; transport?: string | null }> | 'none';
  workAddress?: string;
  workTransport?: string;
  workStartTime?: string;
  transportMode?: 'car' | 'foot' | 'bicycle' | 'transit';
  hasCar?: boolean;
  homeAddress?: string;
  sleepTime?: string;
  routinesNotes?: string;
}

export function openingLine(he: boolean, name?: string): string {
  const hi = name ? (he ? `היי ${name}, אני מאירה!` : `Hi ${name}, I'm Meira!`) : (he ? 'היי, אני מאירה!' : "Hi, I'm Meira!");
  return he
    ? `${hi} ספרי לי קצת על עצמך — מתי את קמה, מה את עושה בבוקר וכמה זמן זה לוקח לך, ואיך את מגיעה למקומות.`
    : `${hi} Tell me about yourself — when you wake up, what your morning looks like and how long it takes, and how you get around.`;
}

/** A returning user: what is new, not the whole interview again. */
export function welcomeBackLine(he: boolean, name?: string): string {
  return he
    ? `היי${name ? ` ${name}` : ''}! ספרי לי מה חדש — רוטינה חדשה, עבודה, משהו בבוקר?`
    : `Hi${name ? ` ${name}` : ''}! Tell me what's new — a new routine, work, something in your morning?`;
}

/** What the stored profile already knows, in the server's terms — so a re-run
 *  asks only what is missing. Routines are not re-read (prose): new ones ADD. */
export function draftFromProfile(p: (UserProfile & { defaultWakeTime?: string }) | null): MeetingDraft {
  if (!p) return {};
  const d: MeetingDraft = {};
  if (p.name) d.name = p.name;
  if (p.defaultWakeTime) d.wakeTime = p.defaultWakeTime;
  if (p.totalMorningRoutineMinutes) { d.totalMorningMinutesEstimate = p.totalMorningRoutineMinutes; d.morningConfirmed = true; }
  if (p.homeAddress) d.homeAddress = p.homeAddress;
  if (typeof p.hasCar === 'boolean') d.hasCar = p.hasCar;
  if (p.workAddress) d.workAddress = p.workAddress;
  if (p.sleepTime) d.sleepTime = p.sleepTime;
  if (p.transportMode) d.transportMode = p.transportMode;
  return d;
}

export function doneLine(he: boolean, name?: string): string {
  return he
    ? `מעולה${name ? ` ${name}` : ''}, יש לי את כל מה שצריך! מעכשיו אני מתכננת לך את היום אחורה מכל דבר — מתי לקום, מתי לצאת.`
    : `Perfect${name ? `, ${name}` : ''} — I have everything I need. From now on I plan your day backwards: when to wake, when to leave.`;
}

export function morningMinutes(d: MeetingDraft): number {
  const sum = (d.morningHabits ?? []).reduce((n, h) => n + (h.estimatedMinutes || 0), 0);
  return d.totalMorningMinutesEstimate || sum || 0;
}

const MODE_HE: Record<string, string> = { car: 'אוטו', bus: 'אוטובוס', train: 'רכבת', bike: 'אופניים', walk: 'ברגל',
  transit: 'תחבורה ציבורית', foot: 'ברגל', bicycle: 'אופניים' };
const MODE_EN: Record<string, string> = { car: 'car', bus: 'bus', train: 'train', bike: 'bike', walk: 'walk',
  transit: 'public transport', foot: 'on foot', bicycle: 'bike' };

export interface ChecklistRow { key: string; label: string; value: string | null }

/** ✓ / ○ rows, in the order she is asked. `value` null = still to ask. */
export function checklist(d: MeetingDraft, he: boolean): ChecklistRow[] {
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const mode = (m?: string) => (m ? (he ? MODE_HE[m] : MODE_EN[m]) || m : '');
  const mins = morningMinutes(d);
  const routines = d.routines === 'none'
    ? T('none', 'אין')
    : Array.isArray(d.routines) && d.routines.length
      // Each routine with its day and hour, one per line: 21.10 — "yoga classes" alone did not say
      // whether what she told Meira was understood, or which day and hour it was saved on.
      ? d.routines.map((r) => [r.what, r.days, r.time].filter(Boolean).join(' · ')).join('\n')
      : null;
  const work = d.workAddress === 'none'
    ? T('none', 'אין')
    : d.workAddress ? [d.workAddress, mode(d.workTransport)].filter(Boolean).join(' · ') : null;
  return [
    { key: 'name', label: T('Name', 'שם'), value: d.name || null },
    { key: 'wake', label: T('Wake up', 'קימה'), value: d.wakeTime || null },
    { key: 'morning', label: T('Morning', 'בוקר'),
      value: mins ? `${mins} ${T('min', 'דק׳')}${d.morningConfirmed ? '' : ' ?'}` : null },
    { key: 'routines', label: T('Routines', 'רוטינות'), value: routines },
    { key: 'work', label: T('Work', 'עבודה'), value: work },
    { key: 'home', label: T('Home', 'בית'), value: d.homeAddress || null },
    { key: 'car', label: T('Car?', 'אוטו?'), value: typeof d.hasCar === 'boolean' ? (d.hasCar ? T('yes', 'יש') : T('no', 'אין')) : null },
    { key: 'sleep', label: T('Sleep', 'שינה'), value: d.sleepTime || null },
  ];
}

/**
 * Everything saved about her, in full, for her to check (8.10, Koral: "show
 * the user what was saved about them, to verify with them"). Routines one per
 * row with days, hour, place and how she gets there — the checklist only
 * names them.
 */
export function savedSummary(d: MeetingDraft, he: boolean): ChecklistRow[] {
  const T = (en: string, hebrew: string) => (he ? hebrew : en);
  const mode = (m?: string | null) => (m ? (he ? MODE_HE[m] : MODE_EN[m]) || m : '');
  const rows = checklist(d, he).filter((r) => r.key !== 'routines' && r.value);
  const routines: ChecklistRow[] = Array.isArray(d.routines)
    ? d.routines.map((r, i) => ({
      key: `routine-${i}`,
      label: r.what,
      value: [r.days, r.time, r.place, mode(r.transport)].filter(Boolean).join(' · ') || T('no details yet', 'בלי פרטים עדיין'),
    }))
    : d.routines === 'none' ? [{ key: 'routines', label: T('Routines', 'רוטינות'), value: T('none', 'אין') }] : [];
  const at = rows.findIndex((r) => r.key === 'work');
  return at < 0 ? [...rows, ...routines] : [...rows.slice(0, at), ...routines, ...rows.slice(at)];
}

/**
 * She taps a row to fix it (9.10, Koral: "there's a mistake about my work —
 * how do I edit it?"). The row's fields are dropped from the draft, so the
 * server counts them as missing and her next answer REPLACES them, and Meira
 * asks that one question again. Routine rows fix all routines (they are asked
 * as one list). Null = not a row that can be re-asked.
 */
const FIX: Record<string, { fields: Array<keyof MeetingDraft>; he: string; en: string }> = {
  name: { fields: ['name'], he: 'איך קוראים לך?', en: "What's your name?" },
  wake: { fields: ['wakeTime'], he: 'באיזו שעה את קמה בדרך כלל?', en: 'What time do you usually wake up?' },
  morning: { fields: ['morningHabits', 'totalMorningMinutesEstimate', 'morningConfirmed'],
    he: 'כמה זמן לוקח לך להתארגן בבוקר?', en: 'How long does it take you to get ready in the morning?' },
  routines: { fields: ['routines'], he: 'ספרי לי שוב על הרוטינות שלך — מה, איפה, באילו ימים ושעות?',
    en: 'Tell me your routines again — what, where, which days and hours?' },
  work: { fields: ['workAddress', 'workTransport'], he: 'איפה את עובדת, ואיך את מגיעה לשם?',
    en: 'Where do you work, and how do you get there?' },
  home: { fields: ['homeAddress'], he: 'מה הכתובת של הבית?', en: "What's your home address?" },
  car: { fields: ['hasCar'], he: 'יש לך אוטו?', en: 'Do you have a car?' },
  sleep: { fields: ['sleepTime'], he: 'באיזו שעה את הולכת לישון?', en: 'What time do you go to sleep?' },
};

export function fixRow(d: MeetingDraft, key: string, he: boolean): { draft: MeetingDraft; question: string } | null {
  const fix = FIX[key.startsWith('routine') ? 'routines' : key];
  if (!fix) return null;
  const draft = { ...d };
  for (const f of fix.fields) delete draft[f];
  return { draft, question: he ? fix.he : fix.en };
}

export function checkLine(he: boolean): string {
  return he ? 'זה מה ששמרתי עלייך — תבדקי שהכל נכון.' : "Here's what I saved about you — check it's all right.";
}

const HHMM = /^\d{2}:\d{2}$/;

/**
 * What is known so far → the stored profile, ON TOP of what was there (a
 * returning user re-running the meeting loses nothing she did not re-say).
 * `complete` marks onboarding done; a partial save (⏭ later) keeps asking
 * next time.
 */
/** Her routines as the profile's lines ("what · days · time · place"). */
export function routineLines(d: MeetingDraft): string[] {
  return Array.isArray(d.routines)
    ? d.routines.filter((r) => r.what).map((r) => [r.what, r.days, r.time, r.place].filter(Boolean).join(' · '))
    : [];
}

/**
 * The conversation as it stands, kept beside the profile (9.10, Koral: "when I
 * leave the screen and come back, it isn't saved!"). The profile keeps
 * routines as prose and has no "I don't work", so a reopened meeting showed
 * them as never said. `lines` are the routine lines this meeting wrote, so the
 * next save replaces them instead of adding them again.
 */
export const MEETING_DRAFT_KEY = 'meira.firstMeeting.draft';
export interface SavedMeeting { draft: MeetingDraft; lines: string[] }

/** Reopening: what the conversation saved, under what the profile says now. */
export function resumeDraft(fromProfile: MeetingDraft, saved: SavedMeeting | null): MeetingDraft {
  return { ...(saved?.draft ?? {}), ...fromProfile };
}

export function toProfile(
  d: MeetingDraft, existing: UserProfile | null, complete: boolean, nowIso: string, previousLines: string[] = [],
): UserProfile {
  const habits = (d.morningHabits ?? []).filter((h) => h.habit && h.estimatedMinutes > 0);
  const total = morningMinutes(d) || existing?.totalMorningRoutineMinutes || 0;
  const lines = routineLines(d);
  // Every answer saves; without this each save appended the routines again.
  // And a line that says the same routine again REPLACES the old one (11.10:
  // one workout, told five ways, was five lines and five cards).
  const parsed = lines.map((l) => parseRoutineNotes(l)[0]).filter(Boolean);
  const restated = (l: string) => {
    const old = parseRoutineNotes(l)[0];
    return Boolean(old && parsed.some((n) => sameRoutine(old, n)));
  };
  const before = (existing?.routinesNotes ?? '').split('\n')
    .filter((l) => l.trim() && !previousLines.includes(l) && !restated(l));
  const notes = [...before, ...lines.filter((l) => !before.includes(l))];
  return {
    ...(existing ?? {} as UserProfile),
    name: d.name || existing?.name || '',
    homeAddress: d.homeAddress || existing?.homeAddress || '',
    homeLatLng: d.homeAddress && d.homeAddress !== existing?.homeAddress ? null : existing?.homeLatLng ?? null,
    // "I don't work" CLEARS the old workplace (9.10: Palo Alto stayed on after it).
    workAddress: d.workAddress === 'none' ? '' : d.workAddress || existing?.workAddress,
    transportMode: d.transportMode || existing?.transportMode || 'transit',
    morningHabits: habits.length ? habits : existing?.morningHabits ?? [],
    totalMorningRoutineMinutes: total,
    workStartTime: d.workStartTime && HHMM.test(d.workStartTime) ? d.workStartTime : existing?.workStartTime || '',
    sleepTime: d.sleepTime || existing?.sleepTime || '',
    routinesNotes: lines.length || previousLines.length ? notes.join('\n') : existing?.routinesNotes,
    hasCar: typeof d.hasCar === 'boolean' ? d.hasCar : existing?.hasCar,
    // profileShape reads it; nothing used to write it (it fell back to 08:00).
    ...(d.wakeTime ? { defaultWakeTime: d.wakeTime } : {}),
    onboardingComplete: complete || Boolean(existing?.onboardingComplete),
    createdAt: existing?.createdAt || nowIso,
    lastUpdated: nowIso,
  } as UserProfile;
}

/** Strip the server's bookkeeping, keep the merged profile. */
export function draftOf(server: Record<string, any>): MeetingDraft {
  const { missingFields: _m, followUpQuestion: _f, isComplete: _c, ...rest } = server;
  return rest as MeetingDraft;
}
