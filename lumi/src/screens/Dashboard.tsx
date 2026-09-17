// Dashboard: greeting, AI summary banner, 3 stat cards, and a vertical
// time-blocked schedule with a live "now" line. The schedule is drag-sortable.
import { useMemo } from 'react';
import { Flame, Sparkles, Target, TrendingUp } from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useLumi } from '../store';
import { NOW, TODAY, TODAY_LABEL } from '../data';
import { PageHeader, StatCard } from '../components/ui';
import { TaskCard } from '../components/TaskCard';
import { SortableRow } from '../components/Sortable';
import { cn, durationLabel, endTime, greeting, toMinutes } from '../lib/utils';

export function Dashboard() {
  const profile = useLumi((s) => s.profile);
  const tasks = useLumi((s) => s.tasks);
  const selectTask = useLumi((s) => s.selectTask);
  const reorderTasks = useLumi((s) => s.reorderTasks);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const today = useMemo(
    () =>
      tasks
        .filter((t) => t.date === TODAY && t.start)
        .sort((a, b) => toMinutes(a.start!) - toMinutes(b.start!)),
    [tasks],
  );

  const doneCount = today.filter((t) => t.status === 'done').length;
  const focusMin = today
    .filter((t) => t.category === 'focus' || t.category === 'learning')
    .reduce((s, t) => s + t.durationMinutes, 0);
  const nowMin = toMinutes(NOW);
  const nextUp = today.find((t) => t.status !== 'done' && toMinutes(t.start!) >= nowMin);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = today.map((t) => t.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    reorderTasks(next);
  };

  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8">
      <PageHeader
        title={`${greeting()}, ${profile.name}`}
        subtitle={TODAY_LABEL}
      />

      {/* AI summary banner */}
      <div className="mb-6 flex items-start gap-3 rounded-card border border-ai/30 bg-gradient-to-r from-ai/10 to-primary/10 p-4 shadow-glow">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ai/20 text-ai">
          <Sparkles size={18} />
        </div>
        <div className="text-sm leading-relaxed">
          <span className="font-medium text-text">You have {today.length} blocks today. </span>
          <span className="text-muted">
            HW2 is due 23:59 — your only high-priority item. I’ve kept the afternoon clear so you can
            submit on time.{' '}
          </span>
          {nextUp && (
            <span className="text-ai">Next up: {nextUp.title} at {nextUp.start}.</span>
          )}
        </div>
      </div>

      {/* stat cards */}
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Tasks done"
          value={`${doneCount}/${today.length}`}
          hint="today"
          accent="violet"
        />
        <StatCard
          label="Focus time"
          value={durationLabel(focusMin)}
          hint="deep work scheduled"
          accent="cyan"
        />
        <StatCard label="Streak" value={<span>7🔥</span>} hint="days planned" accent="green" />
      </div>

      {/* schedule */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Schedule</h2>
        <span className="num text-xs text-muted">drag to reorder</span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={today.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="relative space-y-2">
            {today.map((t, i) => {
              const start = toMinutes(t.start!);
              const showNow =
                start > nowMin && (i === 0 || toMinutes(today[i - 1].start!) <= nowMin);
              return (
                <div key={t.id}>
                  {showNow && <NowLine />}
                  <div className="flex gap-3">
                    <div className="num w-12 shrink-0 pt-3 text-right text-xs text-muted">
                      {t.start}
                    </div>
                    <div className="flex-1">
                      <SortableRow id={t.id}>
                        {(dragging) => (
                          <TaskCard task={t} onOpen={selectTask} dragging={dragging} />
                        )}
                      </SortableRow>
                    </div>
                  </div>
                  {/* trailing now-line if now is after the last task */}
                  {i === today.length - 1 && start <= nowMin && nowMin < toMinutes(endTime(t.start!, t.durationMinutes)) && (
                    <div className="ml-12 pl-3">
                      <span className="num text-xs text-success">● in progress</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function NowLine() {
  return (
    <div className={cn('flex items-center gap-2 py-1')}>
      <span className="num w-12 shrink-0 text-right text-xs font-semibold text-danger">{NOW}</span>
      <span className="h-2 w-2 rounded-full bg-danger shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
      <span className="h-px flex-1 bg-gradient-to-r from-danger/80 to-transparent" />
    </div>
  );
}
