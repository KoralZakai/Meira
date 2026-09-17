'use client';

import { useMemo, useState } from 'react';

// Lightweight month calendar for the left rail. Selecting a day drives the
// board's date filter; days that have tasks get a dot.

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function CalendarSidebar({
  selected,
  today,
  taskDates,
  onSelect,
}: {
  selected: string; // '' = all days
  today: string;
  taskDates: Set<string>;
  onSelect: (date: string) => void;
}) {
  const [view, setView] = useState(() => new Date(`${selected || today}T00:00:00`));

  const grid = useMemo(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (string | null)[] = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(new Date(year, month, d)));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [view]);

  const shift = (delta: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));

  return (
    <aside className="cal-rail">
      <div className="cal-card card">
        <div className="cal-nav">
          <button className="cal-arrow" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <span className="cal-month">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
          <button className="cal-arrow" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
        <div className="cal-weekdays">
          {WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}
        </div>
        <div className="cal-grid">
          {grid.map((date, i) =>
            date === null ? (
              <span key={i} className="cal-cell empty" />
            ) : (
              <button
                key={i}
                className={`cal-cell${date === selected ? ' selected' : ''}${date === today ? ' today' : ''}`}
                onClick={() => onSelect(date === selected ? '' : date)}
              >
                {Number(date.slice(-2))}
                {taskDates.has(date) && <span className="cal-dot" />}
              </button>
            ),
          )}
        </div>
        <button className="cal-all" onClick={() => onSelect('')}>
          {selected ? 'Show all days' : 'All days'}
        </button>
      </div>
    </aside>
  );
}
