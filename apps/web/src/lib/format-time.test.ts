import { describe, expect, it } from 'vitest';
import { formatRelative } from './format-time';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('formatRelative', () => {
  it('describes recent times relative to now', () => {
    expect(formatRelative(ago(10_000), NOW)).toMatch(/now/);
    expect(formatRelative(ago(5 * MINUTE), NOW)).toMatch(/5 min/);
    expect(formatRelative(ago(3 * 60 * MINUTE), NOW)).toMatch(/3 hr/);
    expect(formatRelative(ago(2 * DAY), NOW)).toMatch(/2 days/);
    expect(formatRelative(new Date(NOW.getTime() + 2 * DAY).toISOString(), NOW)).toMatch(
      /in 2 days/,
    );
  });

  it('shows a date for anything a week or more away', () => {
    const lastWeek = formatRelative(ago(8 * DAY), NOW);
    expect(lastWeek).not.toMatch(/ago|last/);
    expect(lastWeek).toMatch(/18/);
    expect(formatRelative('2025-03-04T12:00:00.000Z', NOW)).toMatch(/2025/);
  });
});
