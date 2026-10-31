import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from './spinner';

export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap select-none',
    'transition-[background-color,border-color,color,box-shadow,scale] duration-150 ease-out',
    'active:not-disabled:scale-[0.98]',
    'disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        // Solid violet (AA for its label in both states); the glow is the only flourish.
        primary:
          'bg-accent text-accent-foreground shadow-[var(--highlight),var(--elevation-sm)] hover:bg-accent-hover hover:shadow-[var(--highlight),var(--glow)]',
        secondary:
          'border border-border-strong bg-surface text-foreground shadow-xs hover:border-accent/35 hover:bg-surface-hover',
        ghost: 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
        danger:
          'bg-danger text-white shadow-[var(--highlight),var(--elevation-sm)] hover:bg-danger-hover',
        link: 'h-auto px-0 text-accent-subtle-foreground underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-2.5 text-sm',
        md: 'h-9 px-3.5 text-sm',
        lg: 'h-10 px-4 text-base',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (e.g. a router Link) with button styling. */
    asChild?: boolean;
    /** Shows a spinner, sets aria-busy and blocks interaction while keeping the label for layout stability. */
    loading?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);

  if (asChild) {
    return (
      <Slot.Root className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
