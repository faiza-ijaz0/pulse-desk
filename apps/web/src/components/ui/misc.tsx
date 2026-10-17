import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn, initials } from '@/lib/utils';

/** Placeholder block for loading states. Hidden from assistive tech; announce loading elsewhere. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-shimmer rounded-md bg-surface-sunken', className)}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border-strong bg-surface px-1 font-mono text-2xs font-medium text-muted-foreground shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function Separator({
  className,
  orientation = 'horizontal',
}: {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  );
}

// Avatar tints come from a fixed set of theme tokens, chosen deterministically from the
// name so a person keeps the same color everywhere (never random per render).
const AVATAR_TONES = [
  'bg-accent-subtle text-accent-subtle-foreground',
  'bg-info-subtle text-info-foreground',
  'bg-success-subtle text-success-foreground',
  'bg-warning-subtle text-warning-foreground',
] as const;

function toneFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0];
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-2 ring-surface',
        size === 'sm' ? 'size-6 text-2xs' : 'size-8 text-xs',
        toneFor(name),
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

const ALERT_TONES = {
  info: { icon: Info, classes: 'border-info/25 bg-info-subtle text-info-foreground' },
  success: {
    icon: CircleCheck,
    classes: 'border-success/25 bg-success-subtle text-success-foreground',
  },
  warning: {
    icon: TriangleAlert,
    classes: 'border-warning/35 bg-warning-subtle text-warning-foreground',
  },
  danger: {
    icon: CircleAlert,
    classes: 'border-danger/25 bg-danger-subtle text-danger-foreground',
  },
} satisfies Record<string, { icon: LucideIcon; classes: string }>;

/**
 * Inline status message. `danger` uses role="alert" (interrupts); other tones use
 * role="status" (polite) so screen readers announce them without stealing focus.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof ALERT_TONES;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, classes } = ALERT_TONES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', classes, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-medium">{title}</p>
        {children && <div className="text-foreground/80">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
