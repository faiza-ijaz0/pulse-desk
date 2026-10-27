import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { inputStyles } from './input';

/**
 * A styled native select: fully keyboard operable, announced correctly by screen readers
 * and rendered as the platform picker on touch devices.
 */
export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative min-w-0">
      <select
        className={cn(inputStyles, 'h-8 cursor-pointer appearance-none pr-8 text-sm', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-subtle-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
