// Onboarding: gradient-logo welcome + 3-step setup wizard. Writes into the
// profile and flips `onboarded` so the shell takes over.
import { useState } from 'react';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { useLumi } from '../store';
import { GradientLogo } from '../components/ui';
import { cn } from '../lib/utils';
import type { UserProfile } from '../types';

const ROLES = ['Student', 'Engineer', 'Founder', 'Designer', 'Researcher'];
const FOCUS = [25, 50, 90];

export function Onboarding() {
  const profile = useLumi((s) => s.profile);
  const complete = useLumi((s) => s.completeOnboarding);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<UserProfile>(profile);
  const set = (patch: Partial<UserProfile>) => setDraft((d) => ({ ...d, ...patch }));

  const steps = [
    {
      title: 'Welcome to Lumi',
      body: (
        <div className="space-y-4 text-center">
          <p className="text-muted">
            Your AI scheduler that plans the day around what matters — and protects your focus.
          </p>
          <div className="flex items-center justify-center gap-2 text-sm text-ai">
            <Sparkles size={16} /> Powered by your personal AI agent
          </div>
        </div>
      ),
    },
    {
      title: 'Tell Lumi about you',
      body: (
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1.5 block text-muted">Your name</span>
            <input
              className="input"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <div>
            <span className="mb-1.5 block text-sm text-muted">What do you do?</span>
            <div className="flex flex-wrap gap-2">
              {ROLES.map((r) => (
                <button
                  key={r}
                  onClick={() => set({ role: r })}
                  className={cn(
                    'chip cursor-pointer px-3 py-1.5',
                    draft.role === r && 'border-primary bg-primary/15 text-text',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: 'How do you like to work?',
      body: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1.5 block text-muted">Day starts</span>
              <input
                type="time"
                className="input"
                value={draft.workStart}
                onChange={(e) => set({ workStart: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block text-muted">Day ends</span>
              <input
                type="time"
                className="input"
                value={draft.workEnd}
                onChange={(e) => set({ workEnd: e.target.value })}
              />
            </label>
          </div>
          <div>
            <span className="mb-1.5 block text-sm text-muted">Preferred focus block</span>
            <div className="flex gap-2">
              {FOCUS.map((f) => (
                <button
                  key={f}
                  onClick={() => set({ focusBlockMinutes: f })}
                  className={cn(
                    'chip num cursor-pointer px-4 py-2',
                    draft.focusBlockMinutes === f && 'border-ai bg-ai/15 text-ai',
                  )}
                >
                  {f} min
                </button>
              ))}
            </div>
          </div>
        </div>
      ),
    },
  ];

  const last = step === steps.length - 1;

  return (
    <div className="grid min-h-screen place-items-center bg-bg p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-4">
          <GradientLogo size={64} />
          <div
            className="bg-clip-text text-center text-3xl font-bold text-transparent"
            style={{ backgroundImage: 'linear-gradient(135deg,#7C3AED,#06B6D4)' }}
          >
            Lumi
          </div>
        </div>

        <div className="card animate-fade-in p-6" key={step}>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
            Step {step + 1} of {steps.length}
          </div>
          <h1 className="mb-4 text-xl font-semibold">{steps[step].title}</h1>
          {steps[step].body}

          <div className="mt-6 flex items-center justify-between">
            <div className="flex gap-1.5">
              {steps.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1.5 rounded-full transition-all',
                    i === step ? 'w-6 bg-primary' : 'w-1.5 bg-border',
                  )}
                />
              ))}
            </div>
            <button
              className="btn-primary"
              onClick={() => (last ? complete(draft) : setStep((s) => s + 1))}
            >
              {last ? (
                <>
                  Start <Check size={16} />
                </>
              ) : (
                <>
                  Continue <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </div>

        {step > 0 && (
          <button
            className="mx-auto mt-4 block text-sm text-muted hover:text-text"
            onClick={() => setStep((s) => s - 1)}
          >
            Back
          </button>
        )}
      </div>
    </div>
  );
}
