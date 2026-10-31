import { Prisma } from '@pulsedesk/db';

/**
 * A point in time for comparison with the `timestamp(3)` columns, which hold UTC without a
 * zone. It is sent as ISO text: casting text to `timestamp` ignores the trailing `Z` and keeps
 * the UTC clock time, so the result never depends on the session's TimeZone (unlike SQL
 * `now()`, or a parameter typed `timestamptz`). Background sweeps pass their injected clock's
 * time through this.
 */
export const utcTimestamp = (date: Date) => Prisma.sql`${date.toISOString()}::timestamp(3)`;
