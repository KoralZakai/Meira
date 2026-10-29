/**
 * routinePolicy — a rule she taught Meira fills in the days she did not write.
 *
 * After she answered the same way twice ("every day", "changes weekly",
 * "Sunday–Thursday") and said yes to making it a rule (server/user_rules),
 * a dayless routine is not a question any more: it gets the rule's days, and
 * says where they came from (daysFrom: 'rule', shown on her row and in You).
 *
 * Pure. GapFillService.loadRoutines applies it to every routine it loads.
 * Tested by tests/run-routine-policy.ts.
 */
import type { LearnedRule } from '../services/LumiServer';
import type { Routine } from './routines';

const ALL = [0, 1, 2, 3, 4, 5, 6];

export function applyRoutineRules(routines: Routine[], rules: LearnedRule[]): Routine[] {
  const rule = rules.find((r) => r.kind === 'routine_days');
  if (!rule) return routines;
  return routines.map((r) => {
    if (r.daysFrom !== 'unsaid') return r;
    const a = rule.answer;
    if (a.choice === 'varies') return { ...r, weekdays: [], daysFrom: 'varies' };
    const days = a.choice === 'every_day' ? ALL : [...a.days].sort((x, y) => x - y);
    return { ...r, weekdays: days.length === 7 ? [] : days, daysFrom: 'rule' };
  });
}
