import { useCallback, useState } from 'react';

/** Boolean UI preference persisted to localStorage (tolerates storage being unavailable). */
export function usePersistentFlag(
  key: string,
  initial: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === 'true';
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Preference simply won't survive a reload.
      }
    },
    [key],
  );

  return [value, update];
}
