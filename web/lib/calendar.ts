'use client';

import { supabase } from './supabaseClient';

// Google Calendar (read-only) via the provider token Supabase hands back after
// the Google OAuth grant. provider_token is only present right after sign-in,
// so we expose connectCalendar() to (re)request the calendar scope on demand.

export interface CalendarEvent {
  id: string;
  title: string;
  startTime: string; // HH:MM (local) or 'all-day'
  endTime: string; // HH:MM
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
}

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

// Re-runs the OAuth flow asking for the calendar scope. Returns to the app with
// a fresh provider_token that can read the user's calendar.
export async function connectCalendar(): Promise<void> {
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      scopes: CAL_SCOPE,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
}

function hhmm(d: Date): string {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Fetch events for a single YYYY-MM-DD day from the primary calendar.
// Returns null if there's no provider token / scope (caller shows "Connect").
export async function fetchCalendarEvents(
  providerToken: string | null | undefined,
  dateKey: string,
): Promise<CalendarEvent[] | null> {
  if (!providerToken) return null;

  const dayStart = new Date(`${dateKey}T00:00:00`);
  const dayEnd = new Date(`${dateKey}T23:59:59`);
  const params = new URLSearchParams({
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${providerToken}` } },
  );

  // 401/403 → token expired or scope not granted; signal "needs connect".
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Calendar API ${res.status}`);

  const json = await res.json();
  const items: any[] = json.items ?? [];
  return items.map((it): CalendarEvent => {
    const allDay = Boolean(it.start?.date);
    const start = new Date(it.start?.dateTime ?? `${it.start?.date}T00:00:00`);
    const end = new Date(it.end?.dateTime ?? `${it.end?.date}T23:59:59`);
    return {
      id: it.id,
      title: it.summary ?? '(no title)',
      allDay,
      start,
      end,
      startTime: allDay ? 'all-day' : hhmm(start),
      endTime: allDay ? '' : hhmm(end),
      location: it.location,
    };
  });
}
