import { CircleAlert, RotateCw, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function StateIcon({ icon: Icon, tone }: { icon: LucideIcon; tone: 'neutral' | 'danger' }) {
  return (
    <div
      className={cn(
        'mb-4 flex size-11 items-center justify-center rounded-xl border shadow-xs',
        tone === 'danger'
          ? 'border-danger/20 bg-danger-subtle text-danger-foreground'
          : 'border-border bg-surface text-muted-foreground',
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
    </div>
  );
}

/** First-run / no-results state. Always explains what will appear here and, if possible, what to do. */
export function EmptyState({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-sunken/50 px-6 py-12 text-center',
        className,
      )}
    >
      <StateIcon icon={icon} tone="neutral" />
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {children && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{children}</div>
      )}
    </div>
  );
}

/** Recoverable failure with an optional retry that performs a real re-fetch. */
export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  retrying = false,
  className,
}: {
  title?: ReactNode;
  description: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-border bg-surface px-6 py-12 text-center',
        className,
      )}
    >
      <StateIcon icon={CircleAlert} tone="danger" />
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry} loading={retrying}>
          {!retrying && <RotateCw aria-hidden="true" />}
          Try again
        </Button>
      )}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {meta}
        </div>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
