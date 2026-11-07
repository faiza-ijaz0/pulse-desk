import {
  ANALYTICS_DEFAULT_RANGE_DAYS,
  ANALYTICS_MAX_RANGE_DAYS,
  TICKET_PRIORITIES,
  addCalendarDays,
  analyticsBuckets,
  calendarDateIn,
  calendarDaysInclusive,
  hasPermission,
  type AnalyticsAgentPerformance,
  type AnalyticsQuery,
  type AnalyticsReport,
  type AnalyticsScope,
  type AnalyticsSlaOutcomes,
  type FieldError,
  type Role,
  type TicketPriority,
} from '@pulsedesk/shared';
import type { TenantContext } from '../../http/auth-context.ts';
import { ValidationError } from '../../http/errors.ts';
import type { Clock } from '../../lib/clock.ts';
import type { AnalyticsRepository, DurationRow } from './analytics.repository.ts';

/**
 * Whose data the caller's analytics cover, by the same rule as the dashboard: owners and
 * admins (`analytics:read-all`) see the organization, everyone else (`analytics:read-own`,
 * checked by the route) their own tickets and actions.
 */
export function analyticsScope(role: Role): AnalyticsScope {
  return hasPermission(role, 'analytics:read-all') ? 'organization' : 'own';
}

export type ResolvedRange = { from: string; to: string; timeZone: string };

/**
 * Fills in the query's defaults (UTC, ending today, ANALYTICS_DEFAULT_RANGE_DAYS long) and
 * checks what the schema can't: that the range doesn't end after today in its time zone,
 * and that defaults didn't produce a reversed or over-long range.
 */
export function resolveRange(query: AnalyticsQuery, now: Date): ResolvedRange {
  const timeZone = query.tz ?? 'UTC';
  const today = calendarDateIn(now, timeZone);
  const to = query.to ?? today;
  const from = query.from ?? addCalendarDays(to, -(ANALYTICS_DEFAULT_RANGE_DAYS - 1));

  const errors: FieldError[] = [];
  if (to > today) {
    errors.push({ path: 'query.to', message: `Must not be after today (${today} in ${timeZone})` });
  }
  if (from > to) {
    errors.push({ path: 'query.from', message: 'Must not be after `to`' });
  } else if (calendarDaysInclusive(from, to) > ANALYTICS_MAX_RANGE_DAYS) {
    errors.push({
      path: 'query.from',
      message: `The range can cover at most ${ANALYTICS_MAX_RANGE_DAYS} days`,
    });
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return { from, to, timeZone };
}

const none = (): AnalyticsSlaOutcomes => ({ met: 0, breached: 0 });

function average(row: DurationRow | undefined) {
  const count = row?.count ?? 0;
  return { count, averageSeconds: count > 0 ? (row?.averageSeconds ?? null) : null };
}

function stats(row: DurationRow | undefined) {
  const count = row?.count ?? 0;
  return {
    count,
    averageSeconds: count > 0 ? (row?.averageSeconds ?? null) : null,
    medianSeconds: count > 0 ? (row?.medianSeconds ?? null) : null,
  };
}

/** Historical analytics (docs/architecture/analytics.md), read from one database snapshot. */
export function createAnalyticsService(deps: { repository: AnalyticsRepository; clock: Clock }) {
  return {
    async report(tenant: TenantContext, query: AnalyticsQuery): Promise<AnalyticsReport> {
      const scope = analyticsScope(tenant.role);
      const now = deps.clock.now();
      const range = resolveRange(query, now);
      const { granularity, buckets: bounds, end } = analyticsBuckets(range);
      const startsAt = bounds[0]?.startsAt;
      // A valid range is at least one day, so there is always a first bucket.
      if (startsAt === undefined) throw new Error('An analytics range has at least one bucket');

      const snapshot = await deps.repository.snapshot(
        { organizationId: tenant.organizationId, userId: scope === 'own' ? tenant.userId : null },
        { bounds: [...bounds.map((b) => b.startsAt), end], now },
      );

      // Dense buckets: `width_bucket` numbers them from 1; a bucket with no rows is a real 0.
      const buckets = bounds.map((bound, index) => {
        const next = bounds[index + 1];
        return {
          start: bound.start,
          end: next ? addCalendarDays(next.start, -1) : range.to,
          created: 0,
          solved: 0,
          reopened: 0,
          firstResponse: average(undefined),
          resolution: average(undefined),
          firstResponseBreaches: 0,
          resolutionBreaches: 0,
        };
      });
      const bucketAt = (bucket: number | null) =>
        bucket === null ? undefined : buckets[bucket - 1];

      for (const row of snapshot.created) {
        const bucket = bucketAt(row.bucket);
        if (bucket) bucket.created = row.created;
      }
      for (const row of snapshot.statusChanges) {
        const bucket = bucketAt(row.bucket);
        if (!bucket) continue;
        bucket.solved = row.solved;
        bucket.reopened = row.reopened;
      }
      for (const row of snapshot.firstResponse) {
        const bucket = bucketAt(row.bucket);
        if (bucket) bucket.firstResponse = average(row);
      }
      for (const row of snapshot.resolution) {
        const bucket = bucketAt(row.bucket);
        if (bucket) bucket.resolution = average(row);
      }

      const sla = {
        firstResponse: none(),
        resolution: none(),
        byPriority: new Map<
          TicketPriority,
          { firstResponse: AnalyticsSlaOutcomes; resolution: AnalyticsSlaOutcomes }
        >(
          TICKET_PRIORITIES.map((priority) => [
            priority,
            { firstResponse: none(), resolution: none() },
          ]),
        ),
      };
      for (const row of snapshot.slaOutcomes) {
        sla[row.target][row.outcome] += row.count;
        const perPriority = sla.byPriority.get(row.priority);
        if (perPriority) perPriority[row.target][row.outcome] += row.count;
        const bucket = bucketAt(row.bucket);
        if (bucket && row.outcome === 'breached') {
          if (row.target === 'firstResponse') bucket.firstResponseBreaches += row.count;
          else bucket.resolutionBreaches += row.count;
        }
      }

      const createdByCurrentStatus = { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 };
      for (const { status, count } of snapshot.createdByStatus) {
        createdByCurrentStatus[status] = count;
      }

      const activity = new Map<
        string,
        Omit<AnalyticsAgentPerformance, 'userId' | 'name' | 'role'>
      >();
      for (const row of snapshot.activity) {
        const entry = activity.get(row.userId) ?? {
          solved: 0,
          publicReplies: 0,
          firstResponses: average(undefined),
        };
        if (row.kind === 'solved') entry.solved = row.count;
        else if (row.kind === 'publicReplies') entry.publicReplies = row.count;
        else
          entry.firstResponses = average({
            bucket: null,
            count: row.count,
            averageSeconds: row.averageSeconds,
            medianSeconds: null,
          });
        activity.set(row.userId, entry);
      }
      // Members only: a former member's past actions stay in the totals but get no row.
      const agents = snapshot.members
        .map(({ userId, role, user }) => ({
          userId,
          name: user.name,
          role,
          ...(activity.get(userId) ?? {
            solved: 0,
            publicReplies: 0,
            firstResponses: average(undefined),
          }),
        }))
        .sort(
          (a, b) =>
            b.solved - a.solved ||
            b.publicReplies - a.publicReplies ||
            a.name.localeCompare(b.name),
        );

      const total = (rows: DurationRow[]) => rows.find((row) => row.bucket === null);
      return {
        scope,
        generatedAt: now.toISOString(),
        range: {
          ...range,
          granularity,
          startsAt: startsAt.toISOString(),
          endsAt: end.toISOString(),
        },
        buckets,
        totals: {
          created: buckets.reduce((sum, b) => sum + b.created, 0),
          solved: buckets.reduce((sum, b) => sum + b.solved, 0),
          reopened: buckets.reduce((sum, b) => sum + b.reopened, 0),
        },
        createdByCurrentStatus,
        responseTimes: {
          firstResponse: stats(total(snapshot.firstResponse)),
          resolution: stats(total(snapshot.resolution)),
        },
        sla: {
          firstResponse: sla.firstResponse,
          resolution: sla.resolution,
          byPriority: TICKET_PRIORITIES.map((priority) => ({
            priority,
            ...(sla.byPriority.get(priority) ?? { firstResponse: none(), resolution: none() }),
          })),
        },
        agents,
      };
    },
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
