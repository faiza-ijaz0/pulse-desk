const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const shortDateWithYear = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const WEEK = 7 * 24 * 60 * 60_000;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 24 * 60 * 60_000],
  ['hour', 60 * 60_000],
  ['minute', 60_000],
];

/** e.g. "Oct 20, 2026, 9:00 AM" in the viewer's locale and time zone. */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

/**
 * Recent times relative ("3 hr. ago", "in 2 days", "now"); anything a week or more away
 * as a short date ("Oct 18", with the year when it differs), which reads more precisely.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const diff = date.getTime() - now.getTime();
  if (Math.abs(diff) >= WEEK) {
    const format = date.getFullYear() === now.getFullYear() ? shortDate : shortDateWithYear;
    return format.format(date);
  }
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return relative.format(Math.trunc(diff / size), unit);
  }
  return relative.format(0, 'second');
}
