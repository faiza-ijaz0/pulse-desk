import { useId } from 'react';
import { cn } from '@/lib/utils';

/** PulseDesk mark: a heartbeat trace inside a rounded tile — "the pulse of your support desk". */
export function BrandMark({ className }: { className?: string }) {
  // The mark renders in several places at once (sidebar, top bar, drawer), some hidden with
  // display:none. A shared gradient id would resolve to the first — possibly hidden — copy
  // and leave the others unfilled, so each instance gets its own.
  const gradientId = useId();
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-7 shrink-0', className)}>
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="oklch(0.58 0.2 282)" />
          <stop offset="1" stopColor="oklch(0.47 0.21 274)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7.5"
        fill="none"
        stroke="white"
        strokeOpacity="0.18"
      />
      <path
        d="M6 17h5l2.5-6 4 11 3-8 1.5 3H26"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('text-[0.9375rem] font-semibold tracking-tight', className)}>
      PulseDesk
    </span>
  );
}
