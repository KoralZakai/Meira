/**
 * lateNotice — the "I'm running late" message she sends herself (canvas v4, 28.10).
 *
 * The late flow showed the next train and the new arrival, and then left her
 * to type the apology with one thumb while running for it. This drafts it:
 * how late, when she will arrive, to the person the task is with when the
 * task has their number, otherwise to a chat she picks. WhatsApp opens with
 * the text in the box — Meira never sends it (messages to others need her yes).
 */
import type { Task } from '../types/index';
import { waLink } from './addConclusions';

/** "אגיע באיחור של 12 דק׳, בערך ב־17:12. סליחה!" — gender-neutral, short. */
export function lateText(lateBy: number, arriveAt: string, he: boolean): string {
  const by = Math.max(1, Math.round(lateBy));
  return he
    ? `היי, אגיע באיחור של ${by} דק׳, בערך ב־${arriveAt}. סליחה!`
    : `Hi, I'm running ${by} min late — I'll be there around ${arriveAt}. Sorry!`;
}

/** The person's number on the task, wherever it was saved. */
export function contactPhoneOf(task: Task): string {
  return String((task as any).contact?.phone || (task as any).contactPhone || '').trim();
}

export interface LateNotice {
  text: string;
  url: string;
  /** Who the chat opens to — the contact's name, or '' when she picks. */
  to: string;
}

export function lateNotice(task: Task, lateBy: number, arriveAt: string, he: boolean): LateNotice {
  const text = lateText(lateBy, arriveAt, he);
  const direct = waLink(contactPhoneOf(task), text);
  const name = String((task as any).contact?.name || (task as any).contactName || '').trim();
  return direct
    ? { text, url: direct, to: name }
    : { text, url: `whatsapp://send?text=${encodeURIComponent(text)}`, to: '' };
}
