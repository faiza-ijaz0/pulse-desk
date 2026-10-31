import { SLA_TARGET_MAX_MINUTES } from '@pulsedesk/shared';

// SLA targets are stored in minutes (1 minute to 1 year). Admins enter them as a number of
// minutes, hours or days; these helpers convert both ways and validate with the API's limits.

export type DurationUnit = 'minutes' | 'hours' | 'days';

export const DURATION_UNITS: readonly DurationUnit[] = ['minutes', 'hours', 'days'];

const MINUTES_PER: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

const MAX: Record<DurationUnit, number> = {
  minutes: SLA_TARGET_MAX_MINUTES, // 525600
  hours: SLA_TARGET_MAX_MINUTES / MINUTES_PER.hours, // 8760
  days: SLA_TARGET_MAX_MINUTES / MINUTES_PER.days, // 365
};

/** The stored target in the largest unit it is a whole number of: 1440 → 1 day, 90 → 90 minutes. */
export function durationFromMinutes(minutes: number): { value: number; unit: DurationUnit } {
  if (minutes % MINUTES_PER.days === 0) return { value: minutes / MINUTES_PER.days, unit: 'days' };
  if (minutes % MINUTES_PER.hours === 0) {
    return { value: minutes / MINUTES_PER.hours, unit: 'hours' };
  }
  return { value: minutes, unit: 'minutes' };
}

export type DurationInput = { ok: true; minutes: number } | { ok: false; error: string };

/** Validates what the admin typed and converts it to minutes. */
export function minutesFromDuration(value: string, unit: DurationUnit): DurationInput {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a target.' };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: 'Enter a whole number.' };
  const amount = Number(trimmed);
  if (amount < 1) return { ok: false, error: `Must be at least 1 ${unit.slice(0, -1)}.` };
  if (amount > MAX[unit]) return { ok: false, error: `Must be at most ${MAX[unit]} ${unit}.` };
  return { ok: true, minutes: amount * MINUTES_PER[unit] };
}
