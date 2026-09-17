/**
 * PhoneContactsService — native contact picker returning a normalized
 * {name, phone} for attaching a contact to a task.
 *
 * Dependencies: expo-contacts (permission prompt). Returns null when denied
 * or cancelled — callers must handle the null path.
 */
import { Contact, ContactField, requestPermissionsAsync } from 'expo-contacts';

/** Normalized {name, phone} returned by the native picker. */
export interface PickedPhoneContact {
  name?: string;
  phone?: string;
}

function normalizePhone(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/[^\d+\-\s()]/g, '').trim();
  return cleaned || undefined;
}

/** Open the native contact picker; null when denied or cancelled. */
export async function pickPhoneContact(): Promise<PickedPhoneContact | null> {
  try {
    const permission = await requestPermissionsAsync();
    if (!permission.granted) {
      console.log('[CONTACTS] contact permission denied:', permission);
      return null;
    }

    const picked = await Contact.presentPicker();
    if (!picked) {
      return null;
    }

    const details = await picked.getDetails([ContactField.FULL_NAME, ContactField.GIVEN_NAME, ContactField.FAMILY_NAME, ContactField.PHONES]);
    const fallbackPicked = picked as unknown as {
      fullName?: string | null;
      givenName?: string | null;
      familyName?: string | null;
      phones?: Array<{ number?: string | null }>;
      getFullName?: () => Promise<string | null>;
      getPhones?: () => Promise<Array<{ number?: string | null }>>;
    };

    const methodFullName = fallbackPicked.getFullName ? await fallbackPicked.getFullName() : null;
    const methodPhones = fallbackPicked.getPhones ? await fallbackPicked.getPhones() : [];
    const fallbackName = [details.givenName ?? fallbackPicked.givenName, details.familyName ?? fallbackPicked.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const derivedName = (
      details.fullName
      ?? methodFullName
      ?? fallbackPicked.fullName
      ?? fallbackName
    ) || undefined;
    const derivedPhone = normalizePhone(
      details.phones?.[0]?.number
      ?? methodPhones[0]?.number
      ?? fallbackPicked.phones?.[0]?.number
      ?? null,
    );

    console.log('[CONTACTS] picked contact details:', {
      derivedName,
      derivedPhone,
      rawFullName: details.fullName ?? fallbackPicked.fullName ?? null,
      phoneCount: details.phones?.length ?? methodPhones.length ?? fallbackPicked.phones?.length ?? 0,
    });

    return {
      name: derivedName,
      phone: derivedPhone,
    };
  } catch (error) {
    console.log('[CONTACTS] contact picker failed:', error);
    return null;
  }
}