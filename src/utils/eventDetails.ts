/**
 * eventDetails — everything a Google Calendar event holds, in the shape the
 * task card shows: the link to the event, who is invited (names and answers),
 * the description, the organiser, the video-call join link, dial-in, and the
 * files attached to the invitation.
 *
 * Read from the calendar ITSELF when she opens a task — not stored, not synced,
 * no model. The event is the source of truth, so a changed description or a
 * guest who declined shows the moment she looks; nothing to go stale, no new
 * column, and nothing sensitive in the cloud (a dial-in PIN lives on screen only).
 *
 * Pure: no storage, no network. Node-testable (tests/run-event-details.ts).
 */
import { meetingUrlFromEvent } from './meetingLink';

export type GuestAnswer = 'yes' | 'no' | 'maybe' | 'none';

export interface Guest { name: string; email: string; answer: GuestAnswer; organizer?: boolean; self?: boolean }
export interface EventAttachment { title: string; url: string }

export interface EventDetails {
  /** The event in Google Calendar — htmlLink, so it opens in the right account. */
  url?: string;
  title: string;
  description: string;
  location?: string;
  organizer?: { name: string; email: string };
  guests: Guest[];
  /** Zoom / Meet / Teams — only a recognised conferencing host is one tap. */
  joinUrl?: string;
  dialIn?: { phone: string; pin?: string };
  attachments: EventAttachment[];
}

const ANSWER: Record<string, GuestAnswer> = { accepted: 'yes', declined: 'no', tentative: 'maybe', needsAction: 'none' };
const MAX_GUESTS = 40;

/** HTML (Google keeps <br>, <a>, <li> in descriptions) → plain lines. */
export function plainText(html: string | undefined, max = 2000): string {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<\s*(ul|ol)[^>]*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//i.test(u);

export function eventDetailsFromGoogle(item: any): EventDetails {
  const entries: any[] = item?.conferenceData?.entryPoints || [];
  const phone = entries.find((e) => e?.entryPointType === 'phone');
  // A join link is taken from the structured fields first; from free text only
  // a recognised conferencing host (a map link in a body is not a meeting — rule 8).
  const video = item?.hangoutLink
    || entries.find((e) => e?.entryPointType === 'video')?.uri
    || meetingUrlFromEvent(item?.location, item?.description);
  const guests: Guest[] = (item?.attendees || []).slice(0, MAX_GUESTS).map((a: any) => ({
    name: String(a?.displayName || String(a?.email || '').split('@')[0] || '').trim(),
    email: String(a?.email || ''),
    answer: ANSWER[String(a?.responseStatus)] ?? 'none',
    ...(a?.organizer ? { organizer: true } : {}),
    ...(a?.self ? { self: true } : {}),
  })).filter((g: Guest) => g.email || g.name);
  return {
    url: isHttps(item?.htmlLink) ? item.htmlLink : undefined,
    title: String(item?.summary || ''),
    description: plainText(item?.description),
    location: item?.location ? String(item.location) : undefined,
    organizer: item?.organizer?.email
      ? { name: String(item.organizer.displayName || item.organizer.email.split('@')[0]), email: String(item.organizer.email) }
      : undefined,
    guests,
    joinUrl: isHttps(video) ? video : undefined,
    dialIn: phone?.uri ? { phone: String(phone.uri).replace(/^tel:/, ''), pin: phone.pin ? String(phone.pin) : undefined } : undefined,
    attachments: (item?.attachments || [])
      .filter((f: any) => isHttps(f?.fileUrl))
      .map((f: any) => ({ title: String(f.title || 'file'), url: f.fileUrl })),
  };
}
