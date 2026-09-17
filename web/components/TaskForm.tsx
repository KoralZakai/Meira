'use client';

import { useMemo, useState } from 'react';
import { CATEGORY_KEYS, CATEGORY_META, PRIORITY_META, PRIORITY_ORDER, todayKey } from '@/lib/types';
import type { NewTaskInput } from '@/lib/tasks';
import { parseTaskText } from '@/lib/parseTask';
import { buildWorkPlan } from '@/lib/workPlan';

export default function TaskForm({ onAdd }: { onAdd: (input: NewTaskInput) => Promise<void> }) {
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayKey());
  const [priority, setPriority] = useState<NewTaskInput['priority']>('need_to');
  const [category, setCategory] = useState('general');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);

  // Deadline-aware planning inputs.
  const [showPlan, setShowPlan] = useState(false);
  const [deadline, setDeadline] = useState('');
  const [estimateHours, setEstimateHours] = useState('');

  const parsed = useMemo(() => parseTaskText(text, date), [text, date]);

  const estimateMinutes = useMemo(() => {
    const h = parseFloat(estimateHours);
    return Number.isFinite(h) && h > 0 ? Math.round(h * 60) : 0;
  }, [estimateHours]);

  // Smart offer: spread the estimated effort across days before the deadline.
  const workPlan = useMemo(() => {
    if (!deadline || !estimateMinutes) return null;
    return buildWorkPlan(estimateMinutes, deadline, todayKey());
  }, [deadline, estimateMinutes]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      setBusy(true);
      await onAdd({
        text: trimmed,
        date: parsed.date ?? date,
        priority,
        category,
        fixedTime: time || parsed.fixedTime || null,
        durationMinutes: parsed.durationMinutes,
        deadline: deadline || null,
        estimatedWorkMinutes: estimateMinutes || null,
      });
      setText('');
      setTime('');
      setDeadline('');
      setEstimateHours('');
      setShowPlan(false);
    } finally {
      setBusy(false);
    }
  };

  const hint = useMemo(() => {
    const parts: string[] = [];
    if (parsed.fixedTime) parts.push(`🕒 ${parsed.fixedTime}`);
    if (parsed.durationMinutes) {
      const h = Math.floor(parsed.durationMinutes / 60);
      const m = parsed.durationMinutes % 60;
      parts.push(`~${h ? `${h}h` : ''}${m ? `${m}m` : h ? '' : '0m'}`.trim());
    }
    if (parsed.date && parsed.date !== date) parts.push(`📅 ${parsed.date}`);
    return parts.join('  ·  ');
  }, [parsed, date]);

  return (
    <form className="task-form" onSubmit={submit}>
      <div className="task-form-row">
        <div className="task-form-input">
          <input
            placeholder="Add a task… (e.g. “MLOps tomorrow 15:00-23:00”)"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {hint && <span className="parse-hint">{hint}</span>}
        </div>
        <select value={priority ?? 'need_to'} onChange={(e) => setPriority(e.target.value as NewTaskInput['priority'])}>
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>{PRIORITY_META[p].label}</option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORY_KEYS.map((k) => (
            <option key={k} value={k}>{CATEGORY_META[k].icon} {CATEGORY_META[k].label}</option>
          ))}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? '…' : 'Add'}
        </button>
      </div>

      <button type="button" className="plan-toggle" onClick={() => setShowPlan((v) => !v)}>
        {showPlan ? '▾' : '▸'} Has a deadline? Let Lumi plan the work
      </button>

      {showPlan && (
        <div className="plan-fields">
          <label>
            <span>Deadline</span>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <label>
            <span>Est. effort (hours)</span>
            <input
              type="number"
              step="0.5"
              min="0"
              placeholder="3"
              value={estimateHours}
              onChange={(e) => setEstimateHours(e.target.value)}
            />
          </label>

          {workPlan && (
            <div className="plan-offer">
              <div className="plan-offer-head">
                💡 Lumi suggests {workPlan.sessions.length} session
                {workPlan.sessions.length > 1 ? 's' : ''} before the deadline
                {workPlan.tight && <span className="plan-warn"> · tight timeline!</span>}
              </div>
              <div className="plan-sessions">
                {workPlan.sessions.map((s, i) => (
                  <span key={i} className="plan-chip">
                    {s.label} · {Math.round(s.minutes / 60 * 10) / 10}h
                  </span>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                Latest you can start: <b>{workPlan.latestStartDate}</b>. I’ll track your progress rate.
              </div>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
