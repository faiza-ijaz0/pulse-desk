const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A duration in seconds as a short, readable span: "Under a minute", "42 min", "3 h 12 min",
 * "2 d 4 h". Rounded down to the unit shown, so it never overstates how fast the team was.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < MINUTE) return 'Under a minute';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} min`;
  if (seconds < DAY) {
    const hours = Math.floor(seconds / HOUR);
    const minutes = Math.floor((seconds % HOUR) / MINUTE);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);
  return hours ? `${days} d ${hours} h` : `${days} d`;
}

/** `part` as a whole percentage of `total`, 0 when there is no total (no division by zero). */
export function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}
