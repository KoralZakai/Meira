/**
 * changeNudge — when the app is CLOSED and the calendar moved something, may Meira knock? (19.10)
 *
 * The card on Today is waiting (ChangeRecordStore, written by the sync). This decides whether
 * a notification is worth sending about it too — the closed-app trigger of rule 7. The answer
 * is mostly "no", on purpose:
 *
 *   · never for a card she has already SEEN on screen, one she answered, or one she closed;
 *   · quiet hours 22:00–07:30: held, not dropped and not counted — the first run after
 *     07:30 sends it;
 *   · at most TWO knocks per change, and the second no sooner than 3 hours after the first;
 *   · one notification per run, the soonest event first, "+N" when more are waiting;
 *   · nothing about an event whose new moment has already passed.
 *
 * Pure. tests/run-change-nudge.ts. The sending is services/ChangeNudgeService.
 */
import type { AppLanguage } from '../types/index';
import { ChangeRecord, effectLine, headline, isStillOpen, momentLabel } from './changeRecord';

export const QUIET_FROM = '22:00';
export const QUIET_TO = '07:30';
export const MAX_NUDGES_PER_CHANGE = 2;
export const MIN_GAP_BETWEEN_NUDGES_MS = 3 * 60 * 60 * 1000;

export type NudgeLog = Record<string, { n: number; at: number }>;

export function inQuietHours(hhmm: string): boolean {
  return hhmm >= QUIET_FROM || hhmm < QUIET_TO;
}

export interface NudgeDecision {
  send: { key: string; title: string; body: string } | null;
  /** Why nothing was sent, when something was waiting. */
  held?: 'quiet' | 'limit' | 'nothing';
}

const moment = (r: ChangeRecord) => `${r.after.date} ${r.after.time ?? '00:00'}`;

/** Is this card one worth a knock right now, ignoring the clock? */
function waiting(r: ChangeRecord, today: string, nowHHMM: string): 'yes' | 'no' {
  if (!isStillOpen(r, today)) return 'no';
  if (r.seenAt || r.ui) return 'no';
  if (r.after.date === today && r.after.time && r.after.time <= nowHHMM) return 'no';
  return 'yes';
}

export function decideChangeNudge(
  records: ChangeRecord[], log: NudgeLog, nowMs: number, today: string, nowHHMM: string, language: AppLanguage,
): NudgeDecision {
  const open = records.filter((r) => waiting(r, today, nowHHMM) === 'yes');
  if (!open.length) return { send: null, held: 'nothing' };
  if (inQuietHours(nowHHMM)) return { send: null, held: 'quiet' };
  const due = open
    .filter((r) => {
      const e = log[r.key];
      return !e || (e.n < MAX_NUDGES_PER_CHANGE && nowMs - e.at >= MIN_GAP_BETWEEN_NUDGES_MS);
    })
    .sort((a, b) => moment(a).localeCompare(moment(b)));
  if (!due.length) return { send: null, held: 'limit' };
  const first = due[0];
  const more = due.length - 1;
  const he = language === 'he';
  return {
    send: {
      key: first.key,
      title: `🎯 ${headline(first, language)}`,
      body: `${momentLabel(first.after, language)} · ${effectLine(first, language)}${more > 0 ? ` (+${more})` : ''}`
        + (he ? ' · לחצי לפתוח' : ' · tap to open'),
    },
  };
}

/** The log after a knock: counted per change, dated. Old entries for closed cards are dropped. */
export function afterNudge(log: NudgeLog, key: string, nowMs: number, keep: string[]): NudgeLog {
  const next: NudgeLog = {};
  for (const k of keep) if (log[k]) next[k] = log[k];
  next[key] = { n: (log[key]?.n ?? 0) + 1, at: nowMs };
  return next;
}
