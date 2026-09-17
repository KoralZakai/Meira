// Left navigation rail (desktop). Cyan dot = AI Inbox has unread items.
import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  Settings,
  Sparkles,
  Timer,
} from 'lucide-react';
import type { ScreenId } from '../types';
import { GradientLogo } from './ui';
import { cn } from '../lib/utils';
import { useLumi } from '../store';

const NAV: { id: ScreenId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Home', icon: LayoutDashboard },
  { id: 'chat', label: 'Lumi AI', icon: MessageSquare },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'focus', label: 'Focus', icon: Timer },
  { id: 'insights', label: 'Insights', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({
  screen,
  onNavigate,
  onToggleInbox,
}: {
  screen: ScreenId;
  onNavigate: (s: ScreenId) => void;
  onToggleInbox: () => void;
}) {
  const profile = useLumi((s) => s.profile);
  const unread = useLumi((s) => s.inbox.filter((i) => i.unread).length);

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-3 p-4">
        <GradientLogo size={36} />
        <div>
          <div className="text-sm font-semibold leading-tight">Lumi</div>
          <div className="text-xs text-muted">AI time management</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              'flex w-full items-center gap-3 rounded-input px-3 py-2 text-sm transition-colors',
              screen === id
                ? 'bg-surface-2 text-text shadow-glow-violet'
                : 'text-muted hover:bg-surface-2 hover:text-text',
            )}
          >
            <Icon size={17} className={cn(id === 'chat' && 'text-ai')} />
            {label}
          </button>
        ))}
      </nav>

      <div className="p-3">
        <button
          onClick={onToggleInbox}
          className="flex w-full items-center gap-3 rounded-input border border-ai/30 bg-ai/5 px-3 py-2.5 text-sm text-ai transition-colors hover:bg-ai/10"
        >
          <Sparkles size={16} />
          AI Inbox
          {unread > 0 && (
            <span className="num ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-ai px-1 text-xs font-semibold text-bg">
              {unread}
            </span>
          )}
        </button>

        <div className="mt-3 flex items-center gap-3 rounded-input px-2 py-2">
          <div className="grid h-8 w-8 place-items-center rounded-full bg-primary/20 text-sm font-semibold text-primary-soft">
            {profile.name[0]}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{profile.name}</div>
            <div className="truncate text-xs text-muted">{profile.role}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
