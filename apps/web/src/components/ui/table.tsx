import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** True while the element's content is wider than its box (i.e. it can scroll horizontally). */
function useHorizontalOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);

  return [ref, overflowing] as const;
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  const [scrollRef, overflowing] = useHorizontalOverflow<HTMLDivElement>();

  return (
    // A table wider than its container becomes a labelled, focusable region so keyboard
    // users can scroll it with the arrow keys (WCAG 2.1.1). Tables that fit add no tab stop.
    <div
      ref={scrollRef}
      className="relative w-full overflow-x-auto"
      {...(overflowing && {
        role: 'region',
        tabIndex: 0,
        'aria-labelledby': props['aria-labelledby'],
        'aria-label': props['aria-labelledby'] ? undefined : (props['aria-label'] ?? 'Table'),
      })}
    >
      <table
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors hover:bg-surface-hover/60',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('h-12 px-3 align-middle first:pl-5 last:pr-5', className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('mt-3 text-xs text-muted-foreground', className)} {...props} />;
}
