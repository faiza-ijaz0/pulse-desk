import { describe, expect, it } from 'vitest';
import { durationFromMinutes, minutesFromDuration } from './sla-duration';

describe('SLA target durations', () => {
  it('shows a stored target in the largest whole unit', () => {
    expect(durationFromMinutes(30)).toEqual({ value: 30, unit: 'minutes' });
    expect(durationFromMinutes(90)).toEqual({ value: 90, unit: 'minutes' });
    expect(durationFromMinutes(240)).toEqual({ value: 4, unit: 'hours' });
    expect(durationFromMinutes(36 * 60)).toEqual({ value: 36, unit: 'hours' });
    expect(durationFromMinutes(72 * 60)).toEqual({ value: 3, unit: 'days' });
    expect(durationFromMinutes(1)).toEqual({ value: 1, unit: 'minutes' });
  });

  it('converts and validates what the admin enters, within the API limits', () => {
    expect(minutesFromDuration('30', 'minutes')).toEqual({ ok: true, minutes: 30 });
    expect(minutesFromDuration(' 8 ', 'hours')).toEqual({ ok: true, minutes: 480 });
    expect(minutesFromDuration('3', 'days')).toEqual({ ok: true, minutes: 4320 });
    expect(minutesFromDuration('365', 'days')).toEqual({ ok: true, minutes: 525_600 });
    expect(minutesFromDuration('8760', 'hours')).toEqual({ ok: true, minutes: 525_600 });
    expect(minutesFromDuration('525600', 'minutes')).toEqual({ ok: true, minutes: 525_600 });
    expect(minutesFromDuration('366', 'days')).toEqual({
      ok: false,
      error: 'Must be at most 365 days.',
    });
    expect(minutesFromDuration('525601', 'minutes')).toMatchObject({ ok: false });
    expect(minutesFromDuration('0', 'minutes')).toEqual({
      ok: false,
      error: 'Must be at least 1 minute.',
    });
    expect(minutesFromDuration('', 'hours')).toEqual({ ok: false, error: 'Enter a target.' });
    for (const value of ['1.5', '-1', '1e3', 'abc', '2 days']) {
      expect(minutesFromDuration(value, 'hours')).toEqual({
        ok: false,
        error: 'Enter a whole number.',
      });
    }
  });
});
