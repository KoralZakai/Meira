'use client';

import { useCallback, useEffect, useState } from 'react';
import { connectCalendar, fetchCalendarEvents, type CalendarEvent } from '@/lib/calendar';

// Shows today's Google Calendar events alongside the Lumi schedule. If we don't
// have a calendar-scoped token yet, it offers a one-click "Connect" that
// re-runs OAuth asking for the calendar.readonly scope.

export default function CalendarPanel({
  providerToken,
  dateKey,
}: {
  providerToken: string | null | undefined;
  dateKey: string;
}) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const evs = await fetchCalendarEvents(providerToken, dateKey);
      if (evs === null) {
        setNeedsConnect(true);
        setEvents(null);
      } else {
        setNeedsConnect(false);
        setEvents(evs);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Calendar failed');
    } finally {
      setLoading(false);
    }
  }, [providerToken, dateKey]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="cal-panel card">
      <div className="card-head">
        <h3>📅 Google Calendar</h3>
        {!needsConnect && (
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? '…' : 'Refresh'}
          </button>
        )}
      </div>

      {needsConnect && (
        <div className="cal-connect">
          <p className="muted">Sync today’s schedule with your Google Calendar.</p>
          <button className="btn btn-primary btn-sm" onClick={() => connectCalendar()}>
            Connect Calendar
          </button>
        </div>
      )}

      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}

      {!needsConnect && events && events.length === 0 && (
        <p className="muted">No events today.</p>
      )}

      {!needsConnect && events && events.length > 0 && (
        <ul className="cal-list">
          {events.map((e) => (
            <li key={e.id} className="cal-item">
              <span className="cal-time">{e.allDay ? 'all-day' : `${e.startTime}–${e.endTime}`}</span>
              <span className="cal-title">{e.title}</span>
              {e.location && <span className="cal-loc muted">📍 {e.location}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
