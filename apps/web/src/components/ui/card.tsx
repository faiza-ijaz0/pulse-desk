import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** A layered surface: hairline border, soft midnight-tinted shadow, generous radius. */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-surface shadow-[var(--highlight),var(--elevation-sm)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, children, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn('text-base font-semibold tracking-tight text-foreground', className)}
      {...props}
    >
      {children}
    </h2>
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-border px-5 py-3', className)}
      {...props}
    />
  );
}
