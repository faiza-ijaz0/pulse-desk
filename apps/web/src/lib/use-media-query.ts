import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Matches Tailwind's `lg` breakpoint: the full, user-collapsible sidebar is shown at this width. */
export const DESKTOP_QUERY = '(min-width: 1024px)';
/** Matches Tailwind's `md` breakpoint: below it, navigation moves into a drawer. */
export const TABLET_QUERY = '(min-width: 768px)';
