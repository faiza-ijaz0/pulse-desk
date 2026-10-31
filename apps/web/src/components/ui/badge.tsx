import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-sunken text-muted-foreground ring-border-strong/70',
        accent: 'bg-accent-subtle text-accent-subtle-foreground ring-accent/20',
        success: 'bg-success-subtle text-success-foreground ring-success/25',
        warning: 'bg-warning-subtle text-warning-foreground ring-warning/35',
        danger: 'bg-danger-subtle text-danger-foreground ring-danger/25',
        info: 'bg-info-subtle text-info-foreground ring-info/25',
        magenta: 'bg-magenta-subtle text-magenta-foreground ring-magenta/25',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const dotColors = {
  neutral: 'bg-subtle-foreground',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  magenta: 'bg-magenta',
} as const;

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({
  className,
  tone = 'neutral',
  dot = false,
  children,
  ...props
}: ComponentProps<'span'> & { tone?: BadgeTone; dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden="true" className={cn('size-1.5 rounded-full', dotColors[tone])} />}
      {children}
    </span>
  );
}
