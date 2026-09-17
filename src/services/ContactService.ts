/**
 * ContactService — search device contacts with Hebrew/English fuzzy matching.
 *
 * Dependencies: expo-contacts (device permission), utils/fuzzyMatch
 * (fuzzyScore + name variants). Consumed by the add-task flow to attach a
 * TaskContact to a task. Returns [] gracefully when permission is denied.
 */
import * as Contacts from 'expo-contacts';
import { TaskContact } from '../types/index';
import { fuzzyScore, getNameVariants } from '../utils/fuzzyMatch';

let cachedContacts: any[] = [];

/** Device-contacts search facade; returns TaskContact matches scored by utils/fuzzyMatch (EN+HE name variants). */
export const ContactService = {
  async requestPermission(): Promise<boolean> {
    const { status } = await Contacts.requestPermissionsAsync();
    return status === 'granted';
  },

  async loadContacts(): Promise<void> {
    if (cachedContacts.length > 0) return;
    try {
      const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails] });
      cachedContacts = data || [];
    } catch (e) {
      console.log('[ContactService] Error loading contacts:', e);
      cachedContacts = [];
    }
  },

  async getBestContactMatch(nameQuery: string): Promise<TaskContact | null> {
    await this.loadContacts();
    const variants = getNameVariants(nameQuery);
    let bestScore = 0;
    let bestContact: any = null;

    for (const contact of cachedContacts) {
      const fullName = contact.name || '';
      for (const variant of variants) {
        const score = fuzzyScore(fullName, variant);
        if (score > bestScore) { bestScore = score; bestContact = contact; }
      }
    }

    if (!bestContact || bestScore < 0.5) return null;
    return {
      name: bestContact.name || '',
      phone: bestContact.phoneNumbers?.[0]?.number,
      email: bestContact.emails?.[0]?.email,
      contactId: bestContact.id,
    };
  },
};
