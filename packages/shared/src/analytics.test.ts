import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_MAX_RANGE_DAYS,
  addCalendarDays,
  analyticsBuckets,
  analyticsQuerySchema,
  analyticsReportResponseSchema,
  calendarDateIn,
  calendarDaysInclusive,
  isCalendarDate,
  isTimeZone,
  startOfDayIn,
} from './analytics.ts';

describe('calendar dates', () => {
  it('accepts only real days written as YYYY-MM-DD', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '20260101', '', 'today']) {
      expect(isCalendarDate(bad)).toBe(false);
    }
  });

  it('adds days across month and year ends, and counts inclusive ranges', () => {
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(calendarDaysInclusive('2026-11-07', '2026-11-07')).toBe(1);
    expect(calendarDaysInclusive('2026-01-01', '2026-12-31')).toBe(365);
  });
});

describe('time zones', () => {
  it('knows IANA zones and rejects anything else', () => {
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('America/Chicago')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone("UTC'; DROP TABLE x;--")).toBe(false);
  });

  it.each([
    ['UTC', '2026-11-07', '2026-11-07T00:00:00.000Z'],
    ['America/Chicago', '2026-11-07', '2026-11-07T06:00:00.000Z'], // CST, UTC−6
    ['America/Chicago', '2026-07-01', '2026-07-01T05:00:00.000Z'], // CDT, UTC−5
    ['Asia/Kolkata', '2026-11-07', '2026-11-06T18:30:00.000Z'], // UTC+5:30
    ['Pacific/Kiritimati', '2026-11-07', '2026-11-06T10:00:00.000Z'], // UTC+14
    // The days DST starts and ends: midnight is before the 02:00 switch either way.
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z'],
    ['America/New_York', '2026-11-01', '2026-11-01T04:00:00.000Z'],
    ['Europe/Berlin', '2026-03-29', '2026-03-28T23:00:00.000Z'],
  ])('starts %s %s at %s', (zone, date, expected) => {
    expect(startOfDayIn(date, zone).toISOString()).toBe(expected);
  });

  it('starts a day whose midnight is skipped at the first local time that exists', () => {
    // Chile moves 00:00 → 01:00 on 2026-09-06: the day begins at 01:00 −03 (04:00 UTC).
    const start = startOfDayIn('2026-09-06', 'America/Santiago');
    expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(calendarDateIn(start, 'America/Santiago')).toBe('2026-09-06');
    expect(calendarDateIn(new Date(start.getTime() - 1000), 'America/Santiago')).toBe('2026-09-05');
  });

  it('reads the calendar date in a zone', () => {
    const instant = new Date('2026-11-07T03:00:00.000Z');
    expect(calendarDateIn(instant, 'UTC')).toBe('2026-11-07');
    expect(calendarDateIn(instant, 'America/Chicago')).toBe('2026-11-06');
  });
});

describe('analyticsBuckets', () => {
  it('uses one bucket per local day for short ranges, back to back', () => {
    const { granularity, buckets, end } = analyticsBuckets({
      from: '2026-10-31',
      to: '2026-11-02',
      timeZone: 'America/New_York',
    });
    expect(granularity).toBe('day');
    // DST ends on 2026-11-01, so that day is 25 hours long.
    expect(buckets.map((b) => [b.start, b.startsAt.toISOString()])).toEqual([
      ['2026-10-31', '2026-10-31T04:00:00.000Z'],
      ['2026-11-01', '2026-11-01T04:00:00.000Z'],
      ['2026-11-02', '2026-11-02T05:00:00.000Z'],
    ]);
    expect(end.toISOString()).toBe('2026-11-03T05:00:00.000Z');
  });

  it('switches to 7-day buckets above 92 days, the last one shorter', () => {
    const daily = analyticsBuckets({ from: '2026-01-01', to: '2026-04-02', timeZone: 'UTC' });
    expect(daily.granularity).toBe('day');
    expect(daily.buckets).toHaveLength(92);

    const weekly = analyticsBuckets({ from: '2026-01-01', to: '2026-04-03', timeZone: 'UTC' });
    expect(weekly.granularity).toBe('week');
    expect(weekly.buckets).toHaveLength(14); // 93 days: 13 full weeks and 2 days
    expect(weekly.buckets.at(-1)?.start).toBe('2026-04-02');
    expect(weekly.end.toISOString()).toBe('2026-04-04T00:00:00.000Z');
  });

  it('covers the longest allowed range in 53 buckets', () => {
    const { buckets } = analyticsBuckets({ from: '2027-01-01', to: '2028-01-01', timeZone: 'UTC' });
    expect(calendarDaysInclusive('2027-01-01', '2028-01-01')).toBe(366);
    expect(buckets).toHaveLength(53);
  });
});

describe('analyticsQuerySchema', () => {
  it('accepts an empty query (the API fills in the defaults) and a full one', () => {
    expect(analyticsQuerySchema.parse({})).toEqual({});
    const query = { from: '2026-10-09', to: '2026-11-07', tz: 'Europe/Berlin' };
    expect(analyticsQuerySchema.parse(query)).toEqual(query);
  });

  it('rejects invalid dates, zones, repeated values and unknown parameters', () => {
    for (const query of [
      { from: '2026-02-30' },
      { to: 'yesterday' },
      { from: '1999-12-31' },
      { tz: 'Nowhere/Special' },
      { tz: ['UTC', 'Europe/Berlin'] },
      { organizationId: '6f1c2b7e-0000-4000-8000-000000000000' },
    ]) {
      expect(analyticsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('rejects a reversed range and one longer than the maximum', () => {
    const reversed = analyticsQuerySchema.safeParse({ from: '2026-11-08', to: '2026-11-07' });
    expect(reversed.error?.issues[0]).toMatchObject({ path: ['from'] });

    const to = '2026-11-07';
    const longest = addCalendarDays(to, -(ANALYTICS_MAX_RANGE_DAYS - 1));
    expect(analyticsQuerySchema.safeParse({ from: longest, to }).success).toBe(true);
    const tooLong = analyticsQuerySchema.safeParse({ from: addCalendarDays(longest, -1), to });
    expect(tooLong.error?.issues[0]?.message).toMatch(/at most 366 days/);
  });
});

describe('analyticsReportResponseSchema', () => {
  const outcomes = { met: 0, breached: 0 };
  const noTime = { count: 0, averageSeconds: null };
  const EMPTY = {
    scope: 'organization',
    generatedAt: '2026-11-07T12:00:00.000Z',
    range: {
      from: '2026-11-07',
      to: '2026-11-07',
      timeZone: 'UTC',
      granularity: 'day',
      startsAt: '2026-11-07T00:00:00.000Z',
      endsAt: '2026-11-08T00:00:00.000Z',
    },
    buckets: [
      {
        start: '2026-11-07',
        end: '2026-11-07',
        created: 0,
        solved: 0,
        reopened: 0,
        firstResponse: noTime,
        resolution: noTime,
        firstResponseBreaches: 0,
        resolutionBreaches: 0,
      },
    ],
    totals: { created: 0, solved: 0, reopened: 0 },
    createdByCurrentStatus: { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 },
    responseTimes: {
      firstResponse: { count: 0, averageSeconds: null, medianSeconds: null },
      resolution: { count: 0, averageSeconds: null, medianSeconds: null },
    },
    sla: {
      firstResponse: outcomes,
      resolution: outcomes,
      byPriority: ['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((priority) => ({
        priority,
        firstResponse: outcomes,
        resolution: outcomes,
      })),
    },
    agents: [],
  };

  it('accepts an empty organization: zero counts, no averages or medians', () => {
    expect(analyticsReportResponseSchema.parse(EMPTY)).toEqual(EMPTY);
  });

  it('reports "no data" as null, never as a zero average or median', () => {
    const zeroAverage = {
      ...EMPTY,
      responseTimes: {
        ...EMPTY.responseTimes,
        firstResponse: { count: 0, averageSeconds: 0, medianSeconds: 0 },
      },
    };
    expect(analyticsReportResponseSchema.safeParse(zeroAverage).success).toBe(false);
    const missingMedian = {
      ...EMPTY,
      responseTimes: {
        ...EMPTY.responseTimes,
        resolution: { count: 2, averageSeconds: 60, medianSeconds: null },
      },
    };
    expect(analyticsReportResponseSchema.safeParse(missingMedian).success).toBe(false);
  });

  it('needs at least one bucket and every priority', () => {
    expect(analyticsReportResponseSchema.safeParse({ ...EMPTY, buckets: [] }).success).toBe(false);
    const threePriorities = {
      ...EMPTY,
      sla: { ...EMPTY.sla, byPriority: EMPTY.sla.byPriority.slice(1) },
    };
    expect(analyticsReportResponseSchema.safeParse(threePriorities).success).toBe(false);
  });
});
