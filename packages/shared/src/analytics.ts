import { z } from 'zod';
import { dashboardScopeSchema } from './dashboard.ts';
import { roleSchema } from './roles.ts';
import { TICKET_PRIORITIES, ticketPrioritySchema } from './tickets.ts';

/**
 * `GET /api/v1/analytics`: historical trends for the session's active organization over a
 * bounded range of calendar days, read from PostgreSQL at request time. The dashboard
 * (`GET /api/v1/dashboard`) is the "right now" view; this is the "over time" one.
 * Definitions: docs/architecture/analytics.md.
 */

/** The longest range one request may cover, in days (a leap year). */
export const ANALYTICS_MAX_RANGE_DAYS = 366;
/** Ranges up to this many days get one bucket per day; longer ones one per 7 days. */
export const ANALYTICS_DAILY_MAX_DAYS = 92;
/** The range the API uses when the request names none: the last 30 days, today included. */
export const ANALYTICS_DEFAULT_RANGE_DAYS = 30;
/** No range may start before this date (a sanity bound, long before any PulseDesk data). */
export const ANALYTICS_EARLIEST_DATE = '2000-01-01';

/** Whose tickets the report covers; the same rule as the dashboard's scope. */
export const analyticsScopeSchema = dashboardScopeSchema;
export type AnalyticsScope = z.infer<typeof analyticsScopeSchema>;

export const ANALYTICS_GRANULARITIES = ['day', 'week'] as const;
export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];

/* ─── Calendar dates and time zones ──────────────────────────────────────────── */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` that names a real day (no 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function dateToUtcMs(value: string): number {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** The calendar date `days` after `value` (negative: before). */
export function addCalendarDays(value: string, days: number): string {
  return new Date(dateToUtcMs(value) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included: 1 for a single day. */
export function calendarDaysInclusive(from: string, to: string): number {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / DAY_MS) + 1;
}

/** An IANA time zone this runtime knows (`Europe/Berlin`, `UTC`). */
export function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock time in `timeZone` at `instant`, as if it were UTC (milliseconds dropped). */
function wallClockMs(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** The calendar date in `timeZone` at `instant`. */
export function calendarDateIn(instant: Date, timeZone: string): string {
  return new Date(wallClockMs(instant.getTime(), timeZone)).toISOString().slice(0, 10);
}

/**
 * The instant a calendar day starts in `timeZone`: local midnight, with daylight-saving
 * changes applied (a zone that skips midnight starts the day at the first local time that
 * exists). Exact to the second, which is all IANA offsets need.
 */
export function startOfDayIn(date: string, timeZone: string): Date {
  const target = dateToUtcMs(date);
  const whole = (ms: number) => Math.floor(ms / 1000) * 1000;
  // Two refinements settle on the offset in force at that local time.
  let instant = target - (wallClockMs(target, timeZone) - target);
  instant = target - (wallClockMs(instant, timeZone) - whole(instant));
  // A skipped local midnight (DST at 00:00) maps to an instant on the previous local day;
  // move forward to the first instant of the requested day.
  if (calendarDateIn(new Date(instant), timeZone) < date) {
    instant += (target + DAY_MS - wallClockMs(instant, timeZone)) % DAY_MS;
  }
  return new Date(instant);
}

/** One bucket of the report: its first calendar day and the instant it starts. */
export type AnalyticsBucketBound = { start: string; startsAt: Date };

/**
 * The buckets for an inclusive range of calendar days in `timeZone`: one per day up to
 * ANALYTICS_DAILY_MAX_DAYS days, else one per 7 days from `from` (the last may be shorter).
 * `end` is the start of the day after `to`, so every bucket is [startsAt, next startsAt).
 */
export function analyticsBuckets(range: { from: string; to: string; timeZone: string }): {
  granularity: AnalyticsGranularity;
  buckets: AnalyticsBucketBound[];
  end: Date;
} {
  const days = calendarDaysInclusive(range.from, range.to);
  const granularity: AnalyticsGranularity = days <= ANALYTICS_DAILY_MAX_DAYS ? 'day' : 'week';
  const step = granularity === 'day' ? 1 : 7;
  const buckets: AnalyticsBucketBound[] = [];
  for (let offset = 0; offset < days; offset += step) {
    const start = addCalendarDays(range.from, offset);
    buckets.push({ start, startsAt: startOfDayIn(start, range.timeZone) });
  }
  return { granularity, buckets, end: startOfDayIn(addCalendarDays(range.to, 1), range.timeZone) };
}

/* ─── Request ───────────────────────────────────────────────────────────────── */

const calendarDate = z
  .string({ error: 'Must be a single value' })
  .refine(isCalendarDate, { error: 'Must be a date as YYYY-MM-DD' })
  .refine((value) => value >= ANALYTICS_EARLIEST_DATE, {
    error: `Must be ${ANALYTICS_EARLIEST_DATE} or later`,
  });

/**
 * The query string. Every field is optional: without `tz` the days are UTC days; without
 * `to` the range ends today (in `tz`); without `from` it covers ANALYTICS_DEFAULT_RANGE_DAYS
 * days. Whether `to` is in the future depends on the server's clock, so the API checks that.
 * Unknown parameters (an `organizationId`, say) are rejected, never silently used.
 */
export const analyticsQuerySchema = z
  .strictObject({
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    tz: z
      .string({ error: 'Must be a single value' })
      .refine(isTimeZone, { error: 'Must be an IANA time zone, such as Europe/Berlin' })
      .optional(),
  })
  .superRefine((query, ctx) => {
    if (query.from === undefined || query.to === undefined) return;
    if (query.from > query.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'Must not be after `to`' });
    } else if (calendarDaysInclusive(query.from, query.to) > ANALYTICS_MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: `The range can cover at most ${ANALYTICS_MAX_RANGE_DAYS} days`,
      });
    }
  });
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/* ─── Response ──────────────────────────────────────────────────────────────── */

const count = z.number().int().nonnegative();
const seconds = z.number().nonnegative();

/** An average over `count` durations; `null` exactly when there were none (never 0). */
const durationAverageSchema = z
  .object({ count, averageSeconds: seconds.nullable() })
  .refine((value) => (value.count === 0) === (value.averageSeconds === null), {
    message: 'averageSeconds is null exactly when count is 0',
  });

/** Average and median over `count` durations; both `null` exactly when there were none. */
const durationStatsSchema = z
  .object({ count, averageSeconds: seconds.nullable(), medianSeconds: seconds.nullable() })
  .refine(
    (value) =>
      (value.count === 0) === (value.averageSeconds === null) &&
      (value.count === 0) === (value.medianSeconds === null),
    { message: 'averageSeconds and medianSeconds are null exactly when count is 0' },
  );

/** SLA target outcomes decided in a period. Compliance is met / (met + breached). */
const slaOutcomesSchema = z.object({ met: count, breached: count });
export type AnalyticsSlaOutcomes = z.infer<typeof slaOutcomesSchema>;

const bucketSchema = z.object({
  /** The bucket's first calendar day (in the report's time zone). */
  start: z.string().refine(isCalendarDate),
  /** The bucket's last calendar day: `start` for daily buckets. */
  end: z.string().refine(isCalendarDate),
  /** Tickets created. */
  created: count,
  /** Solve actions (status changed to Solved); a ticket solved twice counts twice. */
  solved: count,
  /** Reopens (status changed from Solved back to an active status). */
  reopened: count,
  /** First replies sent, by the reply's time. */
  firstResponse: durationAverageSchema,
  /** Solves of tickets that are still solved or closed, by the latest solve's time. */
  resolution: durationAverageSchema,
  /** SLA targets breached, by when the breach was decided. */
  firstResponseBreaches: count,
  resolutionBreaches: count,
});
export type AnalyticsBucket = z.infer<typeof bucketSchema>;

const agentPerformanceSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: roleSchema,
  /** Tickets this member changed to Solved. */
  solved: count,
  /** Public replies this member wrote (internal notes excluded). */
  publicReplies: count,
  /** First replies on tickets that this member wrote, and how long the customer waited. */
  firstResponses: durationAverageSchema,
});
export type AnalyticsAgentPerformance = z.infer<typeof agentPerformanceSchema>;

export const analyticsReportResponseSchema = z.object({
  scope: analyticsScopeSchema,
  generatedAt: z.iso.datetime(),
  range: z.object({
    from: z.string().refine(isCalendarDate),
    to: z.string().refine(isCalendarDate),
    timeZone: z.string(),
    granularity: z.enum(ANALYTICS_GRANULARITIES),
    /** The first and the first-excluded instant of the range. */
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  }),
  buckets: z.array(bucketSchema).min(1),
  totals: z.object({ created: count, solved: count, reopened: count }),
  /** Tickets created in the range, by their status now (not their status at the time). */
  createdByCurrentStatus: z.object({
    OPEN: count,
    PENDING: count,
    ON_HOLD: count,
    SOLVED: count,
    CLOSED: count,
  }),
  responseTimes: z.object({
    firstResponse: durationStatsSchema,
    resolution: durationStatsSchema,
  }),
  sla: z.object({
    firstResponse: slaOutcomesSchema,
    resolution: slaOutcomesSchema,
    /** Per ticket priority (the current one), in TICKET_PRIORITIES order. */
    byPriority: z
      .array(
        z.object({
          priority: ticketPrioritySchema,
          firstResponse: slaOutcomesSchema,
          resolution: slaOutcomesSchema,
        }),
      )
      .length(TICKET_PRIORITIES.length),
  }),
  /**
   * Members and what they did in the range, most solves first. Every member in the
   * `organization` scope (also those with no activity), only the caller in the `own` scope.
   */
  agents: z.array(agentPerformanceSchema),
});
export type AnalyticsReport = z.infer<typeof analyticsReportResponseSchema>;
