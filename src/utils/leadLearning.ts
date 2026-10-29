/**
 * leadLearning — how much earlier Lumi must warn THIS person, measured.
 *
 * `profile.learnedLeadMinutes` has been read by utils/leadTime since it was
 * written and populated by nothing, so every task got the category default
 * forever. This is the missing half: the observation that fills it.
 *
 * The signal is the gap between the departure the route required and the
 * departure that actually happened:
 *
 *     slip = actual departure − location.leaveHomeBy
 *
 * A positive slip means the alert was too late to be acted on — she left after
 * the moment the route needed her gone. Warning her `slip` minutes earlier is
 * exactly the correction, so the learned lead grows by the slip and shrinks
 * again once she starts leaving on time.
 *
 * Pure: no storage, no notifications. The rolling weight matches
 * LearningService's duration averaging (70% history / 30% new) so one unusual
 * morning cannot move the number far.
 */
import { TaskCategory } from '../types/index';

/** Beyond this the reading is a forgotten phone or a bad fix, not behaviour. */
export const MAX_PLAUSIBLE_SLIP_MINUTES = 90;

/** Weight given to the new observation; the rest stays with the old average. */
const NEW_SAMPLE_WEIGHT = 0.3;

/**
 * Minutes between the departure the plan required and the one that happened.
 *
 * Positive = left late. Returns undefined when the comparison cannot be made
 * honestly: no plan, no detected departure, or a gap so large it is noise
 * rather than a habit.
 */
export function departureSlipMinutes(opts: {
  date: string;
  leaveHomeBy?: string;
  departedAt?: number;
}): number | undefined {
  const { date, leaveHomeBy, departedAt } = opts;
  if (!date || !leaveHomeBy || typeof departedAt !== 'number') return undefined;
  if (!/^\d{2}:\d{2}$/.test(leaveHomeBy)) return undefined;

  const planned = new Date(`${date}T${leaveHomeBy}:00`).getTime();
  if (!Number.isFinite(planned)) return undefined;

  const slip = Math.round((departedAt - planned) / 60000);
  if (Math.abs(slip) > MAX_PLAUSIBLE_SLIP_MINUTES) return undefined;
  return slip;
}

/**
 * One rolling step from the lead we have toward the lead this morning implies.
 *
 * Deliberately NOT `previous + slip`: the slip is measured against
 * `location.leaveHomeBy`, which is fixed by the route and does not move when
 * the warning does. Folding the slip into the previous value again each time
 * would make a steady 10-minute habit push the lead up by 10 minutes forever
 * instead of settling at "ten minutes earlier than the default".
 */
export function nextLearnedLead(previous: number, target: number): number {
  const next = previous * (1 - NEW_SAMPLE_WEIGHT) + target * NEW_SAMPLE_WEIGHT;
  return Math.max(2, Math.round(next));
}

/**
 * Her habitual departure delay, in minutes — the other half of what the slip
 * teaches.
 *
 * The learned lead moves the WARNING earlier. This number moves the PLAN: a
 * gap between two places is only comfortable if it holds the trip plus her
 * buffer plus the minutes she usually leaves late (utils/dayFeasibility). Only
 * lateness counts toward the margin — leaving early is not a habit to plan
 * around — but it is averaged in, so a run of early starts wears it back down.
 *
 * Same rolling weight as everything else here (70% history, 30% new).
 */
export function nextDepartDelay(previous: number | undefined, slip: number): number {
  const base = typeof previous === 'number' && Number.isFinite(previous) ? previous : 0;
  const next = base * (1 - NEW_SAMPLE_WEIGHT) + slip * NEW_SAMPLE_WEIGHT;
  return Math.round(next * 10) / 10;
}

/**
 * Fold one completed trip into the learned-lead table.
 *
 * Returns undefined when there is nothing to learn, so the caller can skip the
 * profile write entirely rather than saving an identical object.
 */
export function learnLead(
  learned: Partial<Record<TaskCategory, number>> | undefined,
  opts: {
    category: TaskCategory;
    /** The category's OWN default lead — the stable anchor, never the learned
     *  value, or the target moves every time it is approached. */
    baseLead: number;
    date: string;
    leaveHomeBy?: string;
    departedAt?: number;
  },
): Partial<Record<TaskCategory, number>> | undefined {
  const slip = departureSlipMinutes(opts);
  if (slip === undefined) return undefined;

  const target = opts.baseLead + slip;
  const previous = learned?.[opts.category] ?? opts.baseLead;
  const next = nextLearnedLead(previous, target);
  if (next === learned?.[opts.category]) return undefined;
  return { ...(learned ?? {}), [opts.category]: next };
}
