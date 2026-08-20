import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Gentelella's `tile_count`: a label, a large figure, and a qualifier.
 *
 * `hint` exists so a figure can carry its own caveat. A number that needs
 * explaining and does not get to is how a dashboard misleads.
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  icon?: React.ReactNode;
}) {
  return (
    <div className="x-panel px-5 py-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-subtle">
        {icon ? <span className="text-accent">{icon}</span> : null}
        {label}
      </div>
      <div
        className={cn(
          'tabular mt-2 text-[1.75rem] font-semibold leading-none tracking-tight',
          tone === 'good' && 'text-good',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-1.5 text-xs text-subtle">{hint}</div> : null}
    </div>
  );
}

/** Shown in place of an empty panel, saying why rather than sitting blank. */
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-border bg-muted px-5 py-6 text-sm text-subtle">
      {children}
    </div>
  );
}

/** A progress bar for funnel and ranking rows. */
export function Bar({ pct, tone = 'accent' }: { pct: number; tone?: 'accent' | 'bad' }) {
  return (
    <span className="block h-2 w-full overflow-hidden rounded-full bg-muted">
      <span
        className={cn('block h-full rounded-full', tone === 'bad' ? 'bg-bad' : 'bg-accent')}
        style={{ width: `${Math.max(1.5, Math.min(100, pct))}%` }}
      />
    </span>
  );
}
