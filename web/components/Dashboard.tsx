'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import {
  CATEGORY_META,
  PRIORITY_META,
  PRIORITY_ORDER,
  todayKey,
  type Task,
  type TaskPriority,
} from '@/lib/types';
import {
  createTask,
  deleteTask,
  fetchTasks,
  toggleComplete,
  updateTask,
  type NewTaskInput,
} from '@/lib/tasks';
import { fetchProfile, type UserProfile } from '@/lib/profile';
import { progressStatus } from '@/lib/workPlan';
import { buildDaySchedule } from '@/lib/buildSchedule';
import TaskForm from './TaskForm';
import SmartAlarm from './SmartAlarm';
import CalendarPanel from './CalendarPanel';
import CalendarSidebar from './CalendarSidebar';
import ProfilePanel from './ProfilePanel';

// Pastel "sticky note" backgrounds for subject groups — cycles by group
// index, same palette as the mobile Tasks screen (src/constants/theme.ts
// NOTE_PALETTE) so both platforms match.
const NOTE_PALETTE = [
  { tint: '#FDEFD9', border: '#F1E0B8', tape: '#F6CF67' },
  { tint: '#FCEADC', border: '#F3D3B8', tape: '#F6B98C' },
  { tint: '#FEF3DC', border: '#F3E1B4', tape: '#FBE6A0' },
  { tint: '#FBEFE3', border: '#F0DFC7', tape: '#F1C24E' },
  { tint: '#FDF1E6', border: '#F2DFC3', tape: '#EAB23F' },
];
function noteStyle(index: number) {
  const p = NOTE_PALETTE[index % NOTE_PALETTE.length];
  return { ...p, rotate: index % 2 === 0 ? '-0.6deg' : '0.5deg', tapeRotate: index % 2 === 0 ? '-3deg' : '2deg' };
}

// Compute "HH:MM – HH:MM" from a start time + duration.
function timeRange(start: string | null | undefined, duration?: number): string | null {
  if (!start) return null;
  if (!duration) return start;
  const [h, m] = start.split(':').map(Number);
  const end = (h * 60 + m + duration) % 1440;
  return `${start} – ${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

export default function Dashboard({ session }: { session: Session }) {
  const userId = session.user.id;
  const today = todayKey();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [dateFilter, setDateFilter] = useState('');
  const [query, setQuery] = useState('');
  const composerRef = useRef<HTMLDivElement>(null);
  // Collapsible groups: keys of the groups the user has collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 'board' = grouped notes; 'timeline' = the built "today" schedule.
  const [view, setView] = useState<'board' | 'timeline'>('board');
  const [scheduled, setScheduled] = useState<Task[]>([]);
  // Success-moment animation: which task id is mid-celebration, keyed by a
  // nonce so re-completing the same task restarts the animation cleanly.
  const [burst, setBurst] = useState<{ id: string; nonce: number } | null>(null);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const load = useCallback(async () => {
    try {
      setError(null);
      setTasks(await fetchTasks(userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
    fetchProfile(userId).then(setProfile).catch(() => {});
  }, [load, userId]);

  const onAdd = async (input: NewTaskInput) => {
    const created = await createTask(userId, input);
    setTasks((prev) => [...prev, created]);
  };
  const onToggle = async (task: Task) => {
    const willBeDone = task.status !== 'complete';
    await toggleComplete(userId, task);
    await load();
    if (willBeDone) {
      const nonce = Date.now();
      setBurst({ id: task.id, nonce });
      setTimeout(() => {
        setBurst((current) => (current && current.nonce === nonce ? null : current));
      }, 700);
    } else {
      setBurst((current) => (current && current.id === task.id ? null : current));
    }
  };
  const onDelete = async (task: Task) => {
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    await deleteTask(userId, task.id);
  };
  const onChangePriority = async (task: Task, priority: TaskPriority) => {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, priority } : t)));
    await updateTask(userId, task.id, { priority });
  };
  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const taskDates = useMemo(() => new Set(tasks.map((t) => t.date)), [tasks]);

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (dateFilter && t.date !== dateFilter) return false;
        if (query && !t.text.toLowerCase().includes(query.toLowerCase())) return false;
        return true;
      }),
    [tasks, dateFilter, query],
  );

  // Group into subject sections (each rendered as a sticky note).
  const topicGroups = useMemo(() => {
    const map = new Map<string, Task[]>();
    const priRank = (p?: TaskPriority | null) => (p ? PRIORITY_ORDER.indexOf(p) : 99);
    for (const t of filtered) {
      const key = t.category ?? 'general';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries())
      .map(([key, list]) => ({
        key,
        list: list.sort(
          (a, b) =>
            priRank(a.priority) - priRank(b.priority) ||
            (a.fixedTime || a.scheduledTime || '23:59').localeCompare(b.fixedTime || b.scheduledTime || '23:59'),
        ),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [filtered]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return profile?.name?.trim() ? `${part}, ${profile.name.trim()}!` : `${part}!`;
  }, [profile]);

  const focusComposer = () => {
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    composerRef.current?.querySelector('input')?.focus();
  };

  // Build today's timeline: order today's pending tasks by urgency + assign
  // times (instant local sort), persist, and switch to the timeline view.
  const buildSchedule = async () => {
    const todays = tasks.filter((t) => t.date === today && t.status !== 'complete');
    if (!todays.length) return;
    const planned = buildDaySchedule(todays, (profile as any)?.defaultWakeTime || '08:00');
    setScheduled(planned);
    setView('timeline');
    await Promise.all(planned.map((t) => updateTask(userId, t.id, { scheduledTime: t.scheduledTime })));
    setTasks((prev) => prev.map((t) => planned.find((p) => p.id === t.id) ?? t));
  };

  return (
    <div className="board">
      <header className="board-header">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="avatar-logo" src="/lumi-logo.png" alt="Lumi" width={44} height={44} />
          <div>
            <h1>{greeting}</h1>
            <div className="muted">{session.user.email}</div>
          </div>
        </div>
        <div className="header-actions">
          <input className="board-search" placeholder="Search notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowProfile(true)}>👤</button>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <SmartAlarm tasks={tasks} profile={profile} dateKey={today} />

      <div className="board-layout">
        <CalendarSidebar selected={dateFilter} today={today} taskDates={taskDates} onSelect={setDateFilter} />
        <div className="cal-rail-extra">
          <CalendarPanel providerToken={session.provider_token} dateKey={dateFilter || today} />
        </div>

        <main className="board-main">
          <div ref={composerRef}>
            <TaskForm onAdd={onAdd} />
          </div>

          {loading && <p className="muted">Loading…</p>}
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

          {view === 'timeline' ? (
            <TimelineView tasks={scheduled} onBack={() => setView('board')} />
          ) : (
            <>
              {!loading && filtered.some((t) => t.date === today && t.status !== 'complete') && (
                <div className="build-bar">
                  <button className="build-btn" onClick={buildSchedule}>
                    Build schedule for today
                  </button>
                </div>
              )}

              {!loading && filtered.length === 0 && (
                <div className="empty">
                  {dateFilter ? `No notes for ${dateFilter}.` : 'No notes yet. Add one above ✨'}
                </div>
              )}

              {!loading && (
                <div className="notes-board">
                  {topicGroups.map(({ key, list }, index) => {
                    const meta = CATEGORY_META[key];
                    const open = !collapsed.has(key);
                    const done = list.filter((t) => t.status === 'complete').length;
                    const note = noteStyle(index);
                    return (
                      <section
                        key={key}
                        className="topic-note"
                        style={{ background: note.tint, borderColor: note.border, transform: `rotate(${note.rotate})` }}
                      >
                        <span className="topic-tape" style={{ background: note.tape, transform: `rotate(${note.tapeRotate})` }} />
                        <button className="topic-note-head" onClick={() => toggleGroup(key)}>
                          <span className="topic-icon">{meta?.icon ?? '📌'}</span>
                          <span className="topic-name">{meta?.label ?? key}</span>
                          <span className="topic-count">{done ? `${done}/` : ''}{list.length}</span>
                          <span className={`topic-chevron${open ? ' open' : ''}`}>›</span>
                        </button>
                        {open && (
                          <div className="topic-note-body">
                            {list.map((t) => (
                              <TaskRow
                                key={t.id}
                                task={t}
                                today={today}
                                burstNonce={burst && burst.id === t.id ? burst.nonce : null}
                                onToggle={onToggle}
                                onDelete={onDelete}
                                onChangePriority={onChangePriority}
                              />
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <button className="fab" onClick={focusComposer} aria-label="Add note">＋</button>

      {showProfile && (
        <ProfilePanel userId={userId} email={session.user.email} onClose={() => setShowProfile(false)} onSaved={setProfile} />
      )}
    </div>
  );
}

// The built "today" schedule as an Apple-style timeline: time gutter + card,
// with dashed "free" gaps between tasks. Renders from tasks that already have
// a scheduledTime (assigned by buildDaySchedule).
function TimelineView({ tasks, onBack }: { tasks: Task[]; onBack: () => void }) {
  const timeOf = (t: Task) => t.fixedTime || t.scheduledTime || '';
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const addMin = (hhmm: string, mins: number) => {
    const total = toMin(hhmm) + mins;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  const sorted = [...tasks].filter(timeOf).sort((a, b) => toMin(timeOf(a)) - toMin(timeOf(b)));

  return (
    <div>
      <button className="back-link" onClick={onBack}>‹ Back to tasks</button>
      {sorted.length === 0 ? (
        <div className="empty">No timed tasks yet.</div>
      ) : (
        <div className="timeline">
          {sorted.map((t, i) => {
            const start = timeOf(t);
            const end = addMin(start, t.durationMinutes || 30);
            const meta = CATEGORY_META[t.category ?? 'general'] ?? CATEGORY_META.general;
            const done = t.status === 'complete';
            const prevEnd = i > 0 ? addMin(timeOf(sorted[i - 1]), sorted[i - 1].durationMinutes || 30) : null;
            const gap = prevEnd ? toMin(start) - toMin(prevEnd) : 0;
            return (
              <div key={t.id}>
                {gap > 10 && (
                  <div className="tl-gap">
                    <span className="tl-gap-time">{prevEnd}</span>
                    <span className="tl-gap-line" />
                    <span className="tl-gap-label">
                      {gap >= 60 ? `${Math.floor(gap / 60)}h${gap % 60 ? ` ${gap % 60}m` : ''}` : `${gap}m`} free
                    </span>
                  </div>
                )}
                <div className="tl-row">
                  <div className="tl-time">{start}<br />{end}</div>
                  <div className={`tl-card${done ? ' done' : ''}`} style={{ borderLeftColor: meta.color }}>
                    <div className="tl-title">{meta.icon} {t.text}</div>
                    <div className="tl-meta">
                      {t.durationMinutes ? `${t.durationMinutes} min` : ''}
                      {t.priority ? ` · ${PRIORITY_META[t.priority].label}` : ''}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Colored dots for the checkbox success burst — plain CSS keyframes per
// index (see globals.css .particle-0..5), so no JS-computed transforms.
const PARTICLE_COUNT = 6;

function TaskRow({
  task,
  today,
  burstNonce,
  onToggle,
  onDelete,
  onChangePriority,
}: {
  task: Task;
  today: string;
  burstNonce: number | null;
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onChangePriority: (t: Task, p: TaskPriority) => void;
}) {
  const done = task.status === 'complete';
  const cat = CATEGORY_META[task.category ?? 'general'] ?? CATEGORY_META.general;
  const priColor = task.priority ? PRIORITY_META[task.priority].color : 'var(--border)';
  const prog = progressStatus(task, today);
  const range = timeRange(task.scheduledTime || task.fixedTime, task.durationMinutes);
  const bursting = burstNonce != null;

  return (
    <div className={`task-row${done ? ' done' : ''}`}>
      <div className="task-row-check-wrap">
        <button
          className={`note-check${done ? ' checked' : ''}${bursting ? ' bursting' : ''}`}
          onClick={() => onToggle(task)}
          title={done ? 'Undo' : 'Complete'}
        >
          {done ? '✓' : ''}
        </button>
        {bursting && (
          <span className="burst-wrap" key={burstNonce}>
            {Array.from({ length: PARTICLE_COUNT }).map((_, i) => (
              <span key={i} className={`particle particle-${i}`} />
            ))}
            <span className="point-badge">+10 ✨</span>
          </span>
        )}
      </div>

      <div className="task-row-main">
        <div className="task-row-top">
          <span className="note-badge" style={{ background: cat.color }}>{cat.icon} {cat.label}</span>
          {task.priority && (
            <span className="note-pri" style={{ color: priColor }}>● {PRIORITY_META[task.priority].label}</span>
          )}
        </div>
        <div className={`note-text${done ? ' done' : ''}`}>{task.text}</div>
        <div className="note-meta">
          {range && <span>🕒 {range}</span>}
          {task.deadline && <span>🎯 {task.deadline}</span>}
        </div>
        {prog && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${prog.percent}%`, background: prog.onTrack ? 'var(--success)' : 'var(--warning)' }} />
              <div className="progress-target" style={{ left: `${prog.expectedPercent}%` }} />
            </div>
            <span className={`progress-msg${prog.onTrack ? '' : ' behind'}`}>{prog.message}</span>
          </div>
        )}
      </div>

      <div className="task-row-actions">
        <select
          value={task.priority ?? ''}
          onChange={(e) => onChangePriority(task, e.target.value as TaskPriority)}
          title="Priority"
        >
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>{PRIORITY_META[p].label}</option>
          ))}
        </select>
        <button className="note-del" onClick={() => onDelete(task)} title="Delete">🗑</button>
      </div>
    </div>
  );
}
