/**
 * A row from Android's calendar database (expo-calendar) → the CalendarEvent
 * shape every importer shares, or null when it is not an appointment.
 * Pure; tested in tests/run-calendar-sources.ts.
 */
import { endFromExclusive } from './allDay';
import { meetingUrlFromEvent } from './meetingLink';
import { addressFromDescription, addressFromTitle } from './eventAddress';
import type { CalendarEvent } from '../types/index';

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A phone-calendar event in the shape every importer shares, or null when it
 * is not an appointment (all-day, cancelled, untitled).
 */
export function deviceEventToCalendarEvent(ev: {
  id: string; title?: string | null; startDate: string | Date; endDate: string | Date;
  allDay?: boolean; status?: string | null; location?: string | null; notes?: string | null;
  organizerEmail?: string | null; url?: string | null;
}): { event: CalendarEvent; date: string } | null {
  if (!ev.title) return null;
  if (ev.allDay) {
    // Android keeps an all-day event at UTC midnight, its end EXCLUSIVE (29.10).
    if (String(ev.status || '').toLowerCase().startsWith('cancel')) return null;
    const s = new Date(ev.startDate);
    if (Number.isNaN(s.getTime())) return null;
    const startDate = s.toISOString().slice(0, 10);
    const e = new Date(ev.endDate);
    const endDate = Number.isNaN(e.getTime()) ? undefined : endFromExclusive(startDate, e.toISOString().slice(0, 10));
    return {
      date: startDate,
      event: { id: String(ev.id), title: ev.title, startTime: '', endTime: '', allDay: true, startDate, endDate,
        location: ev.location || undefined, description: ev.notes || undefined },
    };
  }
  // Android reports a cancelled occurrence as a row with status CANCELED.
  if (String(ev.status || '').toLowerCase().startsWith('cancel')) return null;
  const start = new Date(ev.startDate);
  const end = new Date(ev.endDate);
  if (Number.isNaN(start.getTime())) return null;
  const date = localDateKey(start);
  // An event that runs past midnight ends, for the day it starts on, at 23:59.
  const endTime = !Number.isNaN(end.getTime()) && localDateKey(end) === date ? hhmm(end) : '23:59';
  const notes = ev.notes || undefined;
  return {
    date,
    event: {
      id: String(ev.id),
      title: ev.title,
      startTime: hhmm(start),
      endTime,
      // Same as Google: an invitation that left the venue in the body.
      location: ev.location || addressFromDescription(notes) || addressFromTitle(ev.title),
      description: notes,
      meetingUrl: meetingUrlFromEvent(ev.location, notes) || meetingUrlFromEvent(ev.url, undefined),
      organizer: ev.organizerEmail || undefined,
    },
  };
}

