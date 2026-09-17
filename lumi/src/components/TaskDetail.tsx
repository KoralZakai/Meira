// Slide-over detail panel: Notes / Subtasks / Activity tabs + an "Ask AI"
// command bar that runs the scripted engine against this task.
import { useState } from 'react';
import { Check, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useLumi } from '../store';
import { scriptedEngine } from '../ai/engine';
import { CategoryBadge, PriorityDot } from './ui';
import { cn, durationLabel, endTime } from '../lib/utils';
import type { Priority } from '../types';

type Tab = 'notes' | 'subtasks' | 'activity';

export function TaskDetail() {
  const id = useLumi((s) => s.selectedTaskId);
  const task = useLumi((s) => s.tasks.find((t) => t.id === s.selectedTaskId));
  const selectTask = useLumi((s) => s.selectTask);
  const updateTask = useLumi((s) => s.updateTask);
  const toggleSubtask = useLumi((s) => s.toggleSubtask);
  const addSubtask = useLumi((s) => s.addSubtask);
  const deleteTask = useLumi((s) => s.deleteTask);
  const applyAction = useLumi((s) => s.applyAction);

  const [tab, setTab] = useState<Tab>('subtasks');
  const [sub, setSub] = useState('');
  const [ask, setAsk] = useState('');
  const [aiReply, setAiReply] = useState<string | null>(null);

  if (!id || !task) return null;

  const runAsk = async () => {
    if (!ask.trim()) return;
    const res = await scriptedEngine.respond(ask, { tasks: useLumi.getState().tasks });
    res.actions.forEach((a) => applyAction(a));
    setAiReply(res.reply);
    setAsk('');
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 animate-fade-in"
        onClick={() => selectTask(null)}
      />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md animate-slide-in flex-col border-l border-border bg-surface">
        <header className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <PriorityDot priority={task.priority} />
              <CategoryBadge category={task.category} />
              {task.due && (
                <span className="chip border-danger/40 bg-danger/10 text-danger">⏰ {task.due}</span>
              )}
            </div>
            <h2 className="text-lg font-semibold leading-snug">{task.title}</h2>
            <p className="num mt-1 text-sm text-muted">
              {task.start ? `${task.start}–${endTime(task.start, task.durationMinutes)} · ` : ''}
              {durationLabel(task.durationMinutes)}
            </p>
          </div>
          <button className="btn-ghost px-2" onClick={() => selectTask(null)} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        {/* quick controls */}
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <select
            className="input w-auto"
            value={task.priority}
            onChange={(e) => updateTask(task.id, { priority: e.target.value as Priority })}
          >
            <option value="high">High priority</option>
            <option value="medium">Medium priority</option>
            <option value="low">Low priority</option>
          </select>
          <input
            type="time"
            className="input w-auto"
            value={task.start ?? ''}
            onChange={(e) => updateTask(task.id, { start: e.target.value || undefined })}
          />
          <button
            className="btn-ghost ml-auto text-danger hover:bg-danger/10"
            onClick={() => deleteTask(task.id)}
          >
            <Trash2 size={15} /> Delete
          </button>
        </div>

        {/* tabs */}
        <nav className="flex gap-1 border-b border-border px-3">
          {(['subtasks', 'notes', 'activity'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'relative px-3 py-2.5 text-sm capitalize transition-colors',
                tab === t ? 'text-text' : 'text-muted hover:text-text',
              )}
            >
              {t}
              {tab === t && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-primary" />
              )}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'subtasks' && (
            <div className="space-y-2">
              {task.subtasks.map((s) => (
                <button
                  key={s.id}
                  onClick={() => toggleSubtask(task.id, s.id)}
                  className="flex w-full items-center gap-3 rounded-input border border-border bg-bg p-2.5 text-left text-sm hover:border-primary/50"
                >
                  <span
                    className={cn(
                      'grid h-5 w-5 place-items-center rounded-md border',
                      s.done ? 'border-success bg-success text-bg' : 'border-border text-transparent',
                    )}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span className={cn(s.done && 'text-muted line-through')}>{s.text}</span>
                </button>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (sub.trim()) {
                    addSubtask(task.id, sub.trim());
                    setSub('');
                  }
                }}
                className="flex gap-2 pt-1"
              >
                <input
                  className="input"
                  placeholder="Add a subtask…"
                  value={sub}
                  onChange={(e) => setSub(e.target.value)}
                />
                <button className="btn-primary px-3" type="submit">
                  <Plus size={16} />
                </button>
              </form>
            </div>
          )}

          {tab === 'notes' && (
            <textarea
              className="input min-h-[200px] resize-y leading-relaxed"
              value={task.notes}
              placeholder="Notes…"
              onChange={(e) => updateTask(task.id, { notes: e.target.value })}
            />
          )}

          {tab === 'activity' && (
            <ul className="space-y-3">
              {task.activity.length === 0 && (
                <li className="text-sm text-muted">No activity yet.</li>
              )}
              {task.activity.map((a) => (
                <li key={a.id} className="flex gap-3 text-sm">
                  <span
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      a.source === 'ai' ? 'bg-ai' : 'bg-primary',
                    )}
                  />
                  <div>
                    <span className="text-text">{a.text}</span>
                    <span className="num ml-2 text-xs text-muted">{a.at}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Ask AI command bar */}
        <div className="border-t border-border p-3">
          {aiReply && (
            <div className="mb-2 flex items-start gap-2 rounded-input border border-ai/40 bg-ai/10 p-2.5 text-sm text-ai">
              <Sparkles size={15} className="mt-0.5 shrink-0" />
              <span>{aiReply}</span>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runAsk();
            }}
            className="flex items-center gap-2 rounded-input border border-border bg-bg px-2.5 focus-within:border-ai"
          >
            <Sparkles size={16} className="text-ai" />
            <input
              className="flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted"
              placeholder="Ask AI about this task…"
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
            />
            <button className="btn-ghost px-2 text-ai" type="submit">
              Send
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
