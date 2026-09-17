// Presentational task card. Pure — no drag logic here (sortable wrappers add
// that) so it can be reused in lists, the schedule, and the kanban board.
import { Check, Clock, MapPin, Video } from 'lucide-react';
import type { Task } from '../types';
import { CategoryBadge, PriorityDot, Tag } from './ui';
import { cn, durationLabel, endTime } from '../lib/utils';
import { useLumi } from '../store';

export function TaskCard({
  task,
  onOpen,
  compact = false,
  dragging = false,
}: {
  task: Task;
  onOpen?: (id: string) => void;
  compact?: boolean;
  dragging?: boolean;
}) {
  const toggleStatus = useLumi((s) => s.toggleStatus);
  const lastTouched = useLumi((s) => s.lastTouchedId);
  const done = task.status === 'done';
  const subDone = task.subtasks.filter((s) => s.done).length;

  return (
    <div
      onClick={() => onOpen?.(task.id)}
      className={cn(
        'card group cursor-pointer p-3 transition-all hover:border-primary/60',
        done && 'opacity-60',
        dragging && 'shadow-glow-violet ring-1 ring-primary',
        lastTouched === task.id && 'animate-pop-in ai-glow',
      )}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleStatus(task.id);
          }}
          className={cn(
            'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors',
            done ? 'border-success bg-success text-bg' : 'border-border text-transparent hover:border-success',
          )}
          aria-label={done ? 'Mark not done' : 'Mark done'}
        >
          <Check size={13} strokeWidth={3} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PriorityDot priority={task.priority} />
            <span className={cn('truncate text-sm font-medium', done && 'line-through')}>
              {task.title}
            </span>
          </div>

          {!compact && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              {task.start && (
                <span className="num inline-flex items-center gap-1">
                  <Clock size={12} />
                  {task.start}–{endTime(task.start, task.durationMinutes)}
                </span>
              )}
              <span className="num">{durationLabel(task.durationMinutes)}</span>
              <CategoryBadge category={task.category} />
              {task.inPerson && task.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={12} /> {task.location}
                </span>
              )}
              {task.inPerson === false && task.location && (
                <span className="inline-flex items-center gap-1">
                  <Video size={12} /> {task.location}
                </span>
              )}
            </div>
          )}

          {!compact && (task.tags.length > 0 || task.subtasks.length > 0 || task.due) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {task.due && (
                <span className="chip border-danger/40 bg-danger/10 text-danger">⏰ {task.due}</span>
              )}
              {task.subtasks.length > 0 && (
                <span className="num chip">
                  {subDone}/{task.subtasks.length} subtasks
                </span>
              )}
              {task.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
