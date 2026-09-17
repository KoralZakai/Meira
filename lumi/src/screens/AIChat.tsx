// AI Chat: split screen. Left = conversation with the scripted agent. Right =
// a live task board that animates (cards pop/flash) as the agent applies
// actions. The engine is swappable (see ai/engine.ts).
import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { useLumi } from '../store';
import { scriptedEngine, SUGGESTED_PROMPTS } from '../ai/engine';
import { TODAY } from '../data';
import { TaskCard } from '../components/TaskCard';
import { GradientLogo } from '../components/ui';
import { cn, sleep } from '../lib/utils';

const COLS: { key: 'today' | 'in_progress' | 'done'; label: string }[] = [
  { key: 'today', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
];

export function AIChat() {
  const chat = useLumi((s) => s.chat);
  const tasks = useLumi((s) => s.tasks);
  const pushChat = useLumi((s) => s.pushChat);
  const updateChat = useLumi((s) => s.updateChat);
  const applyAction = useLumi((s) => s.applyAction);
  const selectTask = useLumi((s) => s.selectTask);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setInput('');
    pushChat({ role: 'user', text });
    const aiId = pushChat({ role: 'ai', text: '', pending: true });

    const res = await scriptedEngine.respond(text, { tasks: useLumi.getState().tasks });
    await sleep(650); // "thinking"
    updateChat(aiId, { text: res.reply, pending: false });

    // apply each action with a beat so the board visibly animates
    for (const a of res.actions) {
      await sleep(550);
      applyAction(a);
    }
    setBusy(false);
  };

  const todayTasks = tasks.filter((t) => t.date === TODAY);

  return (
    <div className="flex h-screen">
      {/* chat column */}
      <section className="flex w-full max-w-xl flex-col border-r border-border">
        <header className="flex items-center gap-3 border-b border-border p-4">
          <GradientLogo size={34} />
          <div>
            <div className="text-sm font-semibold">Lumi AI</div>
            <div className="flex items-center gap-1.5 text-xs text-ai">
              <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-ai" />
              online · scripted demo
            </div>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {chat.map((m) => (
            <div
              key={m.id}
              className={cn('flex gap-2.5', m.role === 'user' && 'flex-row-reverse')}
            >
              {m.role === 'ai' && (
                <div className="grid h-7 w-7 shrink-0 place-items-center self-end rounded-full bg-ai/15 text-ai">
                  <Sparkles size={14} />
                </div>
              )}
              <div
                className={cn(
                  'max-w-[80%] animate-fade-in rounded-card px-3.5 py-2.5 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'bg-primary text-white'
                    : 'border border-ai/25 bg-ai/5 text-text',
                )}
              >
                {m.pending ? <TypingDots /> : m.text}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div className="border-t border-border p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((p) => (
              <button
                key={p}
                disabled={busy}
                onClick={() => send(p)}
                className="chip cursor-pointer border-ai/30 text-ai hover:bg-ai/10 disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-center gap-2 rounded-input border border-border bg-bg px-2.5 focus-within:border-ai"
          >
            <input
              className="flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted"
              placeholder="Ask Lumi to plan, schedule, or break down a task…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button className="btn-primary px-3" disabled={busy} type="submit">
              <Send size={15} />
            </button>
          </form>
        </div>
      </section>

      {/* live board column */}
      <section className="hidden flex-1 flex-col overflow-hidden bg-bg lg:flex">
        <header className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-sm font-semibold">Today’s board</h2>
          <span className="flex items-center gap-1.5 text-xs text-ai">
            <Sparkles size={13} /> live
          </span>
        </header>
        <div className="grid flex-1 grid-cols-3 gap-3 overflow-y-auto p-4">
          {COLS.map((c) => {
            const list = todayTasks.filter((t) =>
              c.key === 'today' ? t.column === 'today' || t.column === 'backlog' : t.column === c.key,
            );
            return (
              <div key={c.key} className="flex flex-col gap-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {c.label}
                  </span>
                  <span className="num text-xs text-muted">{list.length}</span>
                </div>
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} onOpen={selectTask} compact />
                ))}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-ai"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}
