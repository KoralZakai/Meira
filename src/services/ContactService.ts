/**
 * ContactService — the device's contacts, for matching a name in a sentence
 * (Hebrew/English fuzzy) and for the Add screen's person chip.
 *
 * Dependencies: expo-contacts (device permission), utils/fuzzyMatch
 * (fuzzyScore + name variants). Consumed by the add-task flow to attach a
 * TaskContact to a task, and by the live chips (utils/liveParse).
 *
 * expo-contacts 56 moved to the `Contact` class; `getContactsAsync` is still
 * exported but THROWS at runtime. The old loader here called it inside a
 * try/catch that logged with console.log and returned [] — so on this SDK it
 * always "found no contacts", in silence. This reads through the new API, and
 * `listForMatching` says WHY it came back empty (silent-state rule 1: "no
 * contacts" and "no permission" must not be one value).
 */
import * as Contacts from 'expo-contacts';
import { TaskContact } from '../types/index';
import { fuzzyScore, getNameVariants } from '../utils/fuzzyMatch';
import type { LiveContact } from '../utils/liveParse';

let cached: LiveContact[] | null = null;

export type ContactsReason = 'denied' | 'error';

/** The mobile number when there is one, else the first. */
function bestPhone(phones: Array<{ number?: string | null; label?: string | null }> | undefined): string | undefined {
  const list = (phones ?? []).filter((p) => p?.number);
  const mobile = list.find((p) => /mobile|cell|נייד|סלולר/i.test(p.label ?? ''));
  return (mobile ?? list[0])?.number ?? undefined;
}

/** Device-contacts facade; returns TaskContact matches scored by utils/fuzzyMatch (EN+HE name variants). */
export const ContactService = {
  async requestPermission(): Promise<boolean> {
    const res = await Contacts.requestPermissionsAsync();
    cached = null;                 // whatever we knew, we now may know more
    return Boolean(res.granted);
  },

  /** Forget the cache — after the permission changed or a contact was picked. */
  invalidate(): void {
    cached = null;
  },

  /**
   * Every contact with a name, for matching. Never prompts: when access has not
   * been granted it says `denied` and the screen offers to ask. An empty list
   * with no reason really is an empty address book.
   */
  async listForMatching(): Promise<{ contacts: LiveContact[]; reason?: ContactsReason }> {
    if (cached) return { contacts: cached };
    try {
      const perm = await Contacts.getPermissionsAsync();
      if (!perm.granted) return { contacts: [], reason: 'denied' };
      const rows = await Contacts.Contact.getAllDetails(
        [Contacts.ContactField.FULL_NAME, Contacts.ContactField.PHONES]);
      cached = (rows as any[])
        .map((r, i): LiveContact => ({
          id: String(r?.id ?? i),
          name: String(r?.fullName ?? '').trim(),
          phone: bestPhone(r?.phones),
        }))
        .filter((c) => c.name);
      return { contacts: cached };
    } catch (e) {
      console.warn('[ContactService] could not read the address book', e);
      return { contacts: [], reason: 'error' };
    }
  },

  async loadContacts(): Promise<void> {
    await this.listForMatching();
  },

  async getBestContactMatch(nameQuery: string): Promise<TaskContact | null> {
    const { contacts } = await this.listForMatching();
    const variants = getNameVariants(nameQuery);
    let bestScore = 0;
    let best: LiveContact | null = null;

    for (const contact of contacts) {
      for (const variant of variants) {
        const score = fuzzyScore(contact.name, variant);
        if (score > bestScore) { bestScore = score; best = contact; }
      }
    }

    if (!best || bestScore < 0.5) return null;
    return { name: best.name, phone: best.phone, contactId: best.id };
  },
};
