import { describe, expect, it } from 'vitest';
import { delayFromMinutes, describeDelay, minutesFromDelay } from './auto-close-delay';

describe('auto-close delay', () => {
  it('shows whole days as days and whole hours as hours', () => {
    expect(delayFromMinutes(5760)).toEqual({ value: 4, unit: 'days' });
    expect(delayFromMinutes(1440)).toEqual({ value: 1, unit: 'days' });
    expect(delayFromMinutes(60)).toEqual({ value: 1, unit: 'hours' });
    expect(delayFromMinutes(36 * 60)).toEqual({ value: 36, unit: 'hours' });
    expect(delayFromMinutes(90)).toBeNull();
    expect(delayFromMinutes(1)).toBeNull();
  });

  it('converts and validates what the admin enters, within the API limits', () => {
    expect(minutesFromDelay('4', 'days')).toEqual({ ok: true, minutes: 5760 });
    expect(minutesFromDelay(' 12 ', 'hours')).toEqual({ ok: true, minutes: 720 });
    expect(minutesFromDelay('365', 'days')).toEqual({ ok: true, minutes: 525_600 });
    expect(minutesFromDelay('8760', 'hours')).toEqual({ ok: true, minutes: 525_600 });
    expect(minutesFromDelay('366', 'days')).toMatchObject({
      ok: false,
      error: 'Must be at most 365 days.',
    });
    expect(minutesFromDelay('8761', 'hours')).toMatchObject({ ok: false });
    expect(minutesFromDelay('0', 'hours')).toMatchObject({
      ok: false,
      error: 'Must be at least 1 hour.',
    });
    expect(minutesFromDelay('', 'days')).toMatchObject({
      ok: false,
      error: 'Enter how long to wait.',
    });
    expect(minutesFromDelay('1.5', 'days')).toMatchObject({
      ok: false,
      error: 'Enter a whole number.',
    });
    expect(minutesFromDelay('-2', 'days')).toMatchObject({ ok: false });
  });

  it('describes a delay in words', () => {
    expect(describeDelay(5760)).toBe('4 days');
    expect(describeDelay(1440)).toBe('1 day');
    expect(describeDelay(60)).toBe('1 hour');
    expect(describeDelay(90)).toBe('90 minutes');
    expect(describeDelay(1)).toBe('1 minute');
  });
});
