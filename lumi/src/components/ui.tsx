// Tiny presentational primitives shared across screens. Intentionally small.
import type { ReactNode } from 'react';
import { CATEGORY_META, PRIORITY_META } from '../data';
import type { Category, Priority } from '../types';
import { cn } from '../lib/utils';

export function GradientLogo({ size = 40 }: { size?: number }) {
  return (
    <div
      className="grid place-items-center rounded-card font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: 'linear-gradient(135deg,#7C3AED,#06B6D4)',
        boxShadow: '0 0 24px -6px rgba(6,182,212,0.6)',
      }}
    >
      L
    </div>
  );
}

export function PriorityDot({ priority }: { priority: Priority }) {
  return (
    <span
      title={`${PRIORITY_META[priority].label} priority`}
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: PRIORITY_META[priority].color }}
    />
  );
}

export function CategoryBadge({ category }: { category: Category }) {
  const m = CATEGORY_META[category];
  return (
    <span
      className="chip border-transparent"
      style={{ background: m.soft, color: m.color }}
    >
      {m.label}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="chip">#{children}</span>;
}

export function StatCard({
  label,
  value,
  hint,
  accent = 'violet',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: 'violet' | 'cyan' | 'green';
}) {
  const ring =
    accent === 'cyan' ? 'shadow-glow' : accent === 'green' ? '' : 'shadow-glow-violet';
  return (
    <div className={cn('card animate-fade-in p-4', ring)}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="num mt-2 text-3xl font-semibold text-text">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function AIBadge({ children }: { children?: ReactNode }) {
  return (
    <span className="chip border-ai/40 bg-ai/10 text-ai">
      <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-ai" />
      {children ?? 'AI'}
    </span>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>
      {right}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}
