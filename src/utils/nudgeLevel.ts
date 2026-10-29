/**
 * nudgeLevel — how pushy Meira is around a study block (19.10, Koral's pick "2":
 * three cards in Profile, each with a sample of what she will get).
 *
 *   alarm       one plain reminder at the hour. No cheering.
 *   gentle      a heads-up half an hour before, and the reminder. (default)
 *   motivating  a cheer an hour before, the reminder, a check-in after.
 *
 * The server owns the reminders (server/reschedule.nudges_for); this file owns
 * the words on the card. Both sides must name the same three levels — the test
 * pins them. Pure: tests/run-nudge-level.ts.
 */
import type { AppLanguage } from '../types/index';

export type NudgeLevel = 'alarm' | 'gentle' | 'motivating';

export const NUDGE_LEVELS: readonly NudgeLevel[] = ['alarm', 'gentle', 'motivating'];
export const DEFAULT_NUDGE_LEVEL: NudgeLevel = 'gentle';

export function nudgeLevelOf(profile: { nudgeLevel?: unknown } | null | undefined): NudgeLevel {
  const v = profile?.nudgeLevel;
  return (NUDGE_LEVELS as readonly unknown[]).includes(v) ? (v as NudgeLevel) : DEFAULT_NUDGE_LEVEL;
}

export interface NudgeCard {
  title: string;
  sample: string;
  /** The interpretation under the slider: how much she will be nudged, in numbers. */
  how: string;
}

const CARDS: Record<NudgeLevel, Record<AppLanguage, NudgeCard>> = {
  alarm: {
    en: { title: 'Alarm only', sample: 'One reminder at the hour. No nice words.', how: 'Level 1 of 3 · 1 reminder · quiet, no cheering' },
    he: { title: 'שעון בלבד', sample: 'תזכורת אחת בשעה. בלי מילים יפות.', how: 'רמה 1 מתוך 3 · תזכורת אחת · שקט, בלי עידוד' },
  },
  gentle: {
    en: { title: 'Gentle', sample: 'Half an hour before: "in half an hour". Then the reminder.', how: 'Level 2 of 3 · 2 reminders · a heads-up, then the reminder' },
    he: { title: 'עדין', sample: 'חצי שעה לפני: "בעוד חצי שעה". ואז התזכורת.', how: 'רמה 2 מתוך 3 · 2 תזכורות · התראה מוקדמת ואז התזכורת' },
  },
  motivating: {
    en: { title: 'Encouraging', sample: 'A cheer ("you can do this!"), the reminder, and "how is it going?" after.', how: 'Level 3 of 3 · 3 messages · cheering, the reminder and a check-in' },
    he: { title: 'מעודד', sample: '"את מסוגלת!", התזכורת, ואחר כך "איך הולך?".', how: 'רמה 3 מתוך 3 · 3 הודעות · עידוד, תזכורת ובדיקה אחרי' },
  },
};

export function nudgeCard(level: NudgeLevel, language: AppLanguage): NudgeCard {
  return CARDS[level][language] ?? CARDS[level].en;
}

// ── the reminders around a block, by level ──────────────────────────────────
// A mirror of server/reschedule.nudges_for (the chat books through the server, the Today card
// through the phone — same words, same hours). tests/run-nudge-level.ts reads the Python source
// and fails if a line here is not there.

const CHEER: Record<'he' | 'en', [string, string, string]> = {
  he: ['יש לך את זה! עוד שעה לומדים 💪', 'את מסוגלת! 💪', 'איך הולך? 🙂'],
  en: ["You've got this! Study in an hour 💪", 'You can do this! 💪', "How's it going? 🙂"],
};

function toMin(hhmm: string): number { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function toHHMM(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** [{at: 'HH:MM', text}] — same day only; a reminder that would cross midnight is dropped. */
export function nudgesFor(level: NudgeLevel, hhmm: string, label: string, he: boolean): Array<{ at: string; text: string }> {
  const lv = (NUDGE_LEVELS as readonly string[]).includes(level) ? level : DEFAULT_NUDGE_LEVEL;
  const base = toMin(hhmm);
  const shift = (d: number): string | null => (base + d >= 0 && base + d < 24 * 60 ? toHHMM(base + d) : null);
  const cheer = CHEER[he ? 'he' : 'en'];
  let plan: Array<[string | null, string]> = [[hhmm, `⏰ ${label}`]];
  if (lv === 'gentle') {
    plan = [[shift(-30), `⏰ ${label} — ${he ? 'בעוד חצי שעה' : 'in half an hour'}`], ...plan];
  } else if (lv === 'motivating') {
    plan = [[shift(-60), `${cheer[0]} (${label})`], [hhmm, `⏰ ${label} — ${cheer[1]}`], [shift(30), cheer[2]]];
  }
  return plan.filter((p): p is [string, string] => !!p[0]).map(([at, text]) => ({ at, text }));
}

// ── the slider (20.10: "need a slide bar for the nudge") ────────────────────

/** The stop nearest to a touch at `x` on a track `width` wide: left = quietest, right = most encouraging. */
export function levelAtX(x: number, width: number): NudgeLevel {
  if (!(width > 0)) return DEFAULT_NUDGE_LEVEL;
  const ratio = Math.min(1, Math.max(0, x / width));
  return NUDGE_LEVELS[Math.round(ratio * (NUDGE_LEVELS.length - 1))];
}

/** Where a level's stop sits, 0..1 along the track. */
export function stopRatio(level: NudgeLevel): number {
  return NUDGE_LEVELS.indexOf(level) / (NUDGE_LEVELS.length - 1);
}

/** One step up (+1) or down (-1), stopping at the ends — for accessibility increment/decrement. */
export function stepLevel(level: NudgeLevel, delta: 1 | -1): NudgeLevel {
  const i = Math.min(NUDGE_LEVELS.length - 1, Math.max(0, NUDGE_LEVELS.indexOf(level) + delta));
  return NUDGE_LEVELS[i];
}
