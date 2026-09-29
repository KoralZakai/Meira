/**
 * A Microsoft Graph event (Outlook / Teams) → the CalendarEvent shape every
 * importer shares. Pure; tested in tests/run-calendar-sources.ts against
 * Graph's real payload shape.
 *
 * Graph-specific traps, each one a silent bug if missed:
 *  - Times are "2026-09-30T07:00:00.0000000" with `timeZone: "UTC"` and NO
 *    offset in the string. Parsed as local time it moves every meeting by the
 *    phone's UTC offset — three hours in Israel. Parsed as UTC here.
 *  - Seven fractional digits. Hermes' Date parser refuses them; trimmed to 3.
 *  - A Teams meeting's location is the words "Microsoft Teams Meeting", which
 *    calendarEventToTask refuses as a place; its link is onlineMeeting.joinUrl.
 *  - A meeting she DECLINED is still returned. It is not in her day.
 */
import { meetingUrlFromEvent } from './meetingLink';
import { addressFromDescription } from './eventAddress';
import type { CalendarEvent } from '../types/index';

function parseGraphTime(t?: { dateTime?: string; timeZone?: string }): Date | null {
  if (!t?.dateTime) return null;
  let s = t.dateTime.replace(/(\.\d{3})\d+/, '$1');
  const hasOffset = /(Z|[+-]\d\d:?\d\d)$/.test(s);
  if (!hasOffset && (!t.timeZone || /^(UTC|Etc\/UTC|GMT)$/i.test(t.timeZone))) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function placeOf(loc: any): string | undefined {
  if (!loc) return undefined;
  const a = loc.address || {};
  const street = [a.street, a.city].filter(Boolean).join(', ');
  const name = String(loc.displayName || '').trim();
  if (street && name && !street.includes(name)) return `${name}, ${street}`;
  return street || name || undefined;
}

export function graphEventToCalendarEvent(it: any): { event: CalendarEvent; date: string } | null {
  if (!it || !it.subject || it.isAllDay || it.isCancelled) return null;
  if (String(it.responseStatus?.response || '').toLowerCase() === 'declined') return null;
  const start = parseGraphTime(it.start);
  const end = parseGraphTime(it.end);
  if (!start) return null;
  const date = dateKey(start);
  const endTime = end && dateKey(end) === date ? hhmm(end) : '23:59';
  const body = String(it.bodyPreview || '') || undefined;
  const place = placeOf(it.location);
  return {
    date,
    event: {
      id: String(it.id),
      title: String(it.subject),
      startTime: hhmm(start),
      endTime,
      location: place || addressFromDescription(body),
      description: body,
      meetingUrl: it.onlineMeeting?.joinUrl || it.onlineMeetingUrl || meetingUrlFromEvent(place, body),
      organizer: it.organizer?.emailAddress?.address || undefined,
      attendees: (it.attendees || [])
        .map((a: any) => a?.emailAddress?.address)
        .filter(Boolean),
    },
  };
}
