import { AUTO_CLOSE_MAX_MINUTES } from '@pulsedesk/shared';

// The auto-close delay is stored in minutes (1 minute to 1 year). Admins enter it as a number
// of hours or days; these helpers convert both ways and validate with the API's limits.

export type DelayUnit = 'hours' | 'days';

export const MINUTES_PER: Record<DelayUnit, number> = { hours: 60, days: 24 * 60 };

const MAX: Record<DelayUnit, number> = {
  hours: AUTO_CLOSE_MAX_MINUTES / MINUTES_PER.hours, // 8760
  days: AUTO_CLOSE_MAX_MINUTES / MINUTES_PER.days, // 365
};

/** The stored delay as whole days or hours, or null if it is neither (e.g. set to 90 min elsewhere). */
export function delayFromMinutes(minutes: number): { value: number; unit: DelayUnit } | null {
  if (minutes % MINUTES_PER.days === 0) return { value: minutes / MINUTES_PER.days, unit: 'days' };
  if (minutes % MINUTES_PER.hours === 0) {
    return { value: minutes / MINUTES_PER.hours, unit: 'hours' };
  }
  return null;
}

export type DelayInput = { ok: true; minutes: number } | { ok: false; error: string };

/** Validates what the admin typed and converts it to minutes. */
export function minutesFromDelay(value: string, unit: DelayUnit): DelayInput {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'Enter how long to wait.' };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: 'Enter a whole number.' };
  const amount = Number(trimmed);
  if (amount < 1) return { ok: false, error: `Must be at least 1 ${unit.slice(0, -1)}.` };
  if (amount > MAX[unit]) return { ok: false, error: `Must be at most ${MAX[unit]} ${unit}.` };
  return { ok: true, minutes: amount * MINUTES_PER[unit] };
}

/** "4 days", "1 hour", "90 minutes". */
export function describeDelay(minutes: number): string {
  const delay = delayFromMinutes(minutes);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (delay?.unit === 'days') return plural(delay.value, 'day');
  if (delay?.unit === 'hours') return plural(delay.value, 'hour');
  return plural(minutes, 'minute');
}
