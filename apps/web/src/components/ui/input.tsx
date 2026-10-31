import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const inputStyles = cn(
  'h-9 w-full min-w-0 rounded-lg border border-input bg-surface px-3 text-sm text-foreground shadow-xs',
  'placeholder:text-subtle-foreground',
  'transition-[border-color,box-shadow] duration-150',
  'hover:border-accent/35',
  'focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/18 focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted-foreground',
  'aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/20',
  'read-only:bg-surface-sunken',
);

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input type={type} className={cn(inputStyles, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea className={cn(inputStyles, 'h-auto min-h-20 resize-y py-2', className)} {...props} />
  );
}
