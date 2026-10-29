/**
 * transitAlertLine — the words under a trip row for its last disruption check.
 *
 * Option A (Koral, 20.10): one line under the row with the headline, the
 * source and the time it was checked. Pure, so both languages are tested in node.
 *
 *  - alerts       → warn line: "⚠️ Possible disruption: {headline}" · source · "checked 07:58"
 *  - could not    → muted line: "Couldn't check for disruptions" · "checked 07:58"
 *  - checked, clear, or never checked → null (no line; nothing claimed)
 *
 * The time carries its DATE when it is not today (silent-state rule 4).
 */
import type { TaskTransitAlerts } from '../types/index';

export interface AlertLine {
  kind: 'warn' | 'unchecked';
  text: string;
  source?: string;
  link?: string;
  checked: string;
  more: number;
}

export function sourceOf(link: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(link || '');
  return m ? m[1] : '';
}

function pad(n: number) { return String(n).padStart(2, '0'); }

export function checkedLabel(at: number, now: Date, he: boolean): string {
  const d = new Date(at);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const when = sameDay ? hhmm : `${d.getDate()}.${d.getMonth() + 1} ${hhmm}`;
  return he ? `נבדק ${when}` : `checked ${when}`;
}

export function transitAlertLine(
  state: TaskTransitAlerts | undefined, he: boolean, now = new Date(),
): AlertLine | null {
  if (!state || !state.checkedAt) return null;
  const checked = checkedLabel(state.checkedAt, now, he);
  const first = state.alerts?.[0];
  if (first) {
    return {
      kind: 'warn',
      text: `${he ? '⚠️ ייתכן שיבוש:' : '⚠️ Possible disruption:'} ${first.title}`,
      source: sourceOf(first.link),
      link: first.link,
      checked,
      more: Math.max(0, state.alerts.length - 1),
    };
  }
  if (state.reason) {
    return {
      kind: 'unchecked',
      text: he ? 'לא הצלחתי לבדוק שיבושים בדרך' : "Couldn't check for disruptions",
      checked,
      more: 0,
    };
  }
  return null;
}
