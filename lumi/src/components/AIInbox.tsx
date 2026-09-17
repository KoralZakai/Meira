// Right-side AI Inbox panel: proactive suggestions, reminders, insights.
// Cyan throughout because this is "AI activity".
import { Bell, Check, Lightbulb, Sparkles, X } from 'lucide-react';
import { useLumi } from '../store';
import { cn } from '../lib/utils';
import type { InboxItem } from '../types';

const ICON: Record<InboxItem['kind'], typeof Bell> = {
  suggestion: Sparkles,
  reminder: Bell,
  insight: Lightbulb,
};

export function AIInbox({ onClose }: { onClose: () => void }) {
  const inbox = useLumi((s) => s.inbox);
  const suggestions = useLumi((s) => s.suggestions);
  const markRead = useLumi((s) => s.markInboxRead);
  const accept = useLumi((s) => s.acceptSuggestion);
  const dismiss = useLumi((s) => s.dismissSuggestion);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-ai" />
          <h2 className="text-sm font-semibold">AI Inbox</h2>
        </div>
        <button className="btn-ghost px-2" onClick={onClose} aria-label="Close inbox">
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Suggestions
          </h3>
          <div className="space-y-2">
            {suggestions.length === 0 && (
              <p className="text-sm text-muted">All caught up. ✨</p>
            )}
            {suggestions.map((s) => (
              <div
                key={s.id}
                className="animate-fade-in rounded-card border border-ai/30 bg-ai/5 p-3"
              >
                <div className="text-sm font-medium text-text">{s.title}</div>
                <p className="mt-1 text-xs text-muted">{s.detail}</p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    onClick={() => accept(s.id)}
                    className="btn bg-ai px-2.5 py-1.5 text-xs font-medium text-bg hover:opacity-90"
                  >
                    <Check size={13} /> Accept
                  </button>
                  <button
                    onClick={() => dismiss(s.id)}
                    className="btn-ghost px-2.5 py-1.5 text-xs"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Activity
          </h3>
          <div className="space-y-1">
            {inbox.map((i) => {
              const Icon = ICON[i.kind];
              return (
                <button
                  key={i.id}
                  onClick={() => markRead(i.id)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-input p-2.5 text-left transition-colors hover:bg-surface-2',
                    i.unread && 'bg-surface-2',
                  )}
                >
                  <Icon size={15} className="mt-0.5 shrink-0 text-ai" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug text-text">{i.text}</p>
                    <span className="num text-xs text-muted">{i.at}</span>
                  </div>
                  {i.unread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ai" />}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </aside>
  );
}
