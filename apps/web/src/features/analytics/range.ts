import {
  ANALYTICS_MAX_RANGE_DAYS,
  addCalendarDays,
  analyticsQuerySchema,
  calendarDaysInclusive,
  isTimeZone,
} from '@pulsedesk/shared';

/** An inclusive range of calendar days, as the URL and the API name it. */
export type AnalyticsRange = { from: string; to: string };

export const RANGE_PRESETS = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '12m', label: '12 months', days: 365 },
] as const;
export type RangePresetId = (typeof RANGE_PRESETS)[number]['id'];

export const DEFAULT_PRESET = RANGE_PRESETS[1];

/** The viewer's time zone, which the days are cut by; UTC if the browser can't say. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The last `days` days, today included. */
export function presetRange(days: number, today: string): AnalyticsRange {
  return { from: addCalendarDays(today, -(days - 1)), to: today };
}

/** The preset a range is, if it ends today and has a preset's length. */
export function presetOf(range: AnalyticsRange, today: string): RangePresetId | null {
  if (range.to !== today) return null;
  const days = calendarDaysInclusive(range.from, range.to);
  return RANGE_PRESETS.find((preset) => preset.days === days)?.id ?? null;
}

/**
 * Why a custom range can't be used, or null when it can: the API's own checks (real dates,
 * order, at most a year) plus "not after today", which the API checks against its clock.
 */
export function rangeProblem(range: AnalyticsRange, today: string): string | null {
  const parsed = analyticsQuerySchema.safeParse(range);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid range';
    return message.includes('`to`') ? 'The start date must be on or before the end date.' : message;
  }
  if (range.to > today) return 'The end date can’t be in the future.';
  if (calendarDaysInclusive(range.from, range.to) > ANALYTICS_MAX_RANGE_DAYS) {
    return `Choose at most ${ANALYTICS_MAX_RANGE_DAYS} days.`;
  }
  return null;
}

/** The range in the page URL (`?from=…&to=…`), or the default when absent or invalid. */
export function rangeFromSearchParams(params: URLSearchParams, today: string): AnalyticsRange {
  const from = params.get('from');
  const to = params.get('to');
  if (from !== null && to !== null && rangeProblem({ from, to }, today) === null) {
    return { from, to };
  }
  return presetRange(DEFAULT_PRESET.days, today);
}

/** `GET /api/v1/analytics` for a range, cut into days in `timeZone`. */
export function analyticsPath(range: AnalyticsRange, timeZone: string): string {
  const params = new URLSearchParams({ from: range.from, to: range.to, tz: timeZone });
  return `/api/v1/analytics?${params.toString()}`;
}
