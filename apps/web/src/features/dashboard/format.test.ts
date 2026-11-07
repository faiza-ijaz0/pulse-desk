import { describe, expect, it } from 'vitest';
import { formatDuration, percentOf } from './format';

describe('formatDuration', () => {
  it.each([
    [0, 'Under a minute'],
    [59.9, 'Under a minute'],
    [60, '1 min'],
    [2700, '45 min'],
    [3599, '59 min'],
    [3600, '1 h'],
    [3 * 3600 + 12 * 60 + 59, '3 h 12 min'],
    [86_400, '1 d'],
    [93_600, '1 d 2 h'],
    [10 * 86_400 + 5 * 3600 + 3599, '10 d 5 h'],
  ])('%s s → %s (rounded down, never overstating speed)', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  it('treats a non-finite value as under a minute instead of printing NaN', () => {
    expect(formatDuration(Number.NaN)).toBe('Under a minute');
  });
});

describe('percentOf', () => {
  it('rounds to a whole percentage', () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
  });

  it('is 0 without a total, never NaN or Infinity', () => {
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(5, 0)).toBe(0);
  });
});
