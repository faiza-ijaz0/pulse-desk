import { Prisma, type Database, type Role, type TicketStatus } from '@pulsedesk/db';
import type { TicketPriority } from '@pulsedesk/shared';
import { utcTimestamp as utc } from '../../lib/sql-time.ts';

/**
 * Whose data an analytics query covers. `organizationId` always comes from the session's
 * tenant context. In the `own` scope `userId` is the caller: ticket metrics cover the
 * tickets assigned to them now, and activity metrics the actions they performed.
 */
export type AnalyticsFilter = { organizationId: string; userId: string | null };

/**
 * The range, cut into buckets: `bounds` holds every bucket's first instant followed by the
 * instant the range ends (excluded), so bucket `i` (1-based, as `width_bucket` numbers it)
 * is [bounds[i - 1], bounds[i]). `now` caps every duration: nothing in the future counts.
 */
export type AnalyticsWindow = { bounds: Date[]; now: Date };

export type CountRow = { bucket: number; created: number };
export type StatusChangeRow = { bucket: number; solved: number; reopened: number };
/** `bucket` is null on the row that totals the whole range (ROLLUP). */
export type DurationRow = {
  bucket: number | null;
  count: number;
  averageSeconds: number | null;
  medianSeconds: number | null;
};
export type SlaOutcomeRow = {
  target: 'firstResponse' | 'resolution';
  priority: TicketPriority;
  outcome: 'met' | 'breached';
  bucket: number;
  count: number;
};
export type ActivityRow = {
  userId: string;
  kind: 'solved' | 'publicReplies' | 'firstResponses';
  count: number;
  averageSeconds: number | null;
};
export type MemberRow = { userId: string; role: Role; user: { name: string } };

export type AnalyticsSnapshot = {
  created: CountRow[];
  statusChanges: StatusChangeRow[];
  firstResponse: DurationRow[];
  resolution: DurationRow[];
  createdByStatus: { status: TicketStatus; count: number }[];
  slaOutcomes: SlaOutcomeRow[];
  activity: ActivityRow[];
  members: MemberRow[];
};

/**
 * The raw-SQL ticket filter. Raw queries bypass the Prisma tenant guard, so every raw
 * statement below filters `"Ticket" t` through this fragment, or (for events and messages,
 * which carry their own organizationId) through `activityScope`.
 */
function ticketScope({ organizationId, userId }: AnalyticsFilter): Prisma.Sql {
  const own = userId === null ? Prisma.empty : Prisma.sql`AND t."assigneeUserId" = ${userId}::uuid`;
  return Prisma.sql`t."organizationId" = ${organizationId}::uuid ${own}`;
}

/** Events or messages (`alias`) in the organization, narrowed to `column` = the caller. */
function activityScope(
  { organizationId, userId }: AnalyticsFilter,
  alias: 'e' | 'm',
  column: 'actorUserId' | 'authorUserId',
): Prisma.Sql {
  const table = Prisma.raw(alias);
  const own =
    userId === null
      ? Prisma.empty
      : Prisma.sql`AND ${table}.${Prisma.raw(`"${column}"`)} = ${userId}::uuid`;
  return Prisma.sql`${table}."organizationId" = ${organizationId}::uuid ${own}`;
}

/**
 * Read-only data access for analytics. Everything is read in one REPEATABLE READ, READ ONLY
 * transaction, so all figures describe the same snapshot.
 *
 * Eight statements per request, whatever the range, the number of members or tickets (no
 * N+1). Bucketing happens in PostgreSQL: `width_bucket` against the sorted array of bucket
 * bounds, computed by the caller in the report's time zone, so the database never needs
 * that zone's rules. Ranges are at most 366 days, so at most 93 buckets.
 */
export function createAnalyticsRepository(db: Database) {
  return {
    snapshot(filter: AnalyticsFilter, window: AnalyticsWindow): Promise<AnalyticsSnapshot> {
      const { bounds, now } = window;
      const first = bounds[0];
      const last = bounds.at(-1);
      if (first === undefined || last === undefined || bounds.length < 2) {
        throw new Error('An analytics window needs at least one bucket');
      }
      const start = utc(first);
      const end = utc(last);
      const at = utc(now);
      const boundsSql = Prisma.sql`${bounds.map((b) => b.toISOString())}::timestamp(3)[]`;
      const bucketOf = (column: Prisma.Sql) => Prisma.sql`width_bucket(${column}, ${boundsSql})`;
      const inRange = (column: Prisma.Sql) =>
        Prisma.sql`${column} >= ${start} AND ${column} < ${end} AND ${column} <= ${at}`;

      /** Durations from creation to `endColumn`, per bucket and (bucket null) in total. */
      const durations = (endColumn: Prisma.Sql, extra: Prisma.Sql) => Prisma.sql`
        WITH d AS (
          SELECT ${bucketOf(endColumn)}::int AS b,
                 EXTRACT(EPOCH FROM ${endColumn} - t."createdAt") AS s
          FROM "Ticket" t
          WHERE ${ticketScope(filter)}
            AND ${inRange(endColumn)}
            AND ${endColumn} >= t."createdAt"
            ${extra}
        )
        SELECT b AS "bucket",
               count(*)::int AS "count",
               avg(s)::float8 AS "averageSeconds",
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY s))::float8 AS "medianSeconds"
        FROM d
        GROUP BY ROLLUP (b)`;

      return db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;

          // 1. Tickets created per bucket (index: organizationId, createdAt).
          const created = await tx.$queryRaw<CountRow[]>`
            SELECT ${bucketOf(Prisma.sql`t."createdAt"`)}::int AS "bucket", count(*)::int AS "created"
            FROM "Ticket" t
            WHERE ${ticketScope(filter)} AND ${inRange(Prisma.sql`t."createdAt"`)}
            GROUP BY 1`;

          // 2. Solves and reopens per bucket, from the append-only timeline (index:
          //    organizationId, type, createdAt). Joined to the ticket for the own scope.
          const statusChanges = await tx.$queryRaw<StatusChangeRow[]>`
            SELECT ${bucketOf(Prisma.sql`e."createdAt"`)}::int AS "bucket",
                   (count(*) FILTER (WHERE e."data"->>'to' = 'SOLVED'))::int AS "solved",
                   (count(*) FILTER (
                     WHERE e."data"->>'from' = 'SOLVED' AND e."data"->>'to' IN ('OPEN', 'PENDING', 'ON_HOLD')
                   ))::int AS "reopened"
            FROM "TicketEvent" e
            JOIN "Ticket" t ON t."organizationId" = e."organizationId" AND t."id" = e."ticketId"
            WHERE e."organizationId" = ${filter.organizationId}::uuid
              AND ${ticketScope(filter)}
              AND e."type" = 'STATUS_CHANGED'
              AND ${inRange(Prisma.sql`e."createdAt"`)}
            GROUP BY 1`;

          // 3–4. Response and resolution times, as the dashboard defines them.
          const firstResponse = await tx.$queryRaw<DurationRow[]>(
            durations(Prisma.sql`t."firstRespondedAt"`, Prisma.empty),
          );
          const resolution = await tx.$queryRaw<DurationRow[]>(
            durations(
              Prisma.sql`t."solvedAt"`,
              Prisma.sql`AND t."status"::text IN ('SOLVED', 'CLOSED')`,
            ),
          );

          // 5. Tickets created in the range by their current status (tenant-guarded).
          const statusGroups = await tx.ticket.groupBy({
            by: ['status'],
            where: {
              organizationId: filter.organizationId,
              ...(filter.userId !== null && { assigneeUserId: filter.userId }),
              createdAt: { gte: first, lt: last },
            },
            _count: { _all: true },
          });

          // 6. SLA outcomes decided in the range. Mirrors evaluateSla (packages/shared sla.ts)
          //    for targets whose clock has stopped: a recorded breach first, then the stop time
          //    against the due date. Running targets have no outcome yet and are left out.
          const solvedOrClosed = Prisma.sql`t."status"::text IN ('SOLVED', 'CLOSED')`;
          const stoppedAt = Prisma.sql`COALESCE(t."solvedAt", t."closedAt")`;
          const slaOutcomes = await tx.$queryRaw<SlaOutcomeRow[]>`
            WITH outcomes AS (
              SELECT 'firstResponse' AS "target", t."priority"::text AS "priority",
                     CASE
                       WHEN t."firstResponseBreachedAt" IS NOT NULL THEN 'breached'
                       WHEN t."firstResponseDueAt" IS NOT NULL AND t."firstRespondedAt" IS NOT NULL THEN
                         CASE WHEN t."firstRespondedAt" <= t."firstResponseDueAt" THEN 'met' ELSE 'breached' END
                     END AS "outcome",
                     COALESCE(
                       t."firstResponseBreachedAt",
                       CASE WHEN t."firstResponseDueAt" IS NOT NULL THEN t."firstRespondedAt" END
                     ) AS "decidedAt"
              FROM "Ticket" t
              WHERE ${ticketScope(filter)}
              UNION ALL
              SELECT 'resolution', t."priority"::text,
                     CASE
                       WHEN t."resolutionBreachedAt" IS NOT NULL THEN 'breached'
                       WHEN t."resolutionDueAt" IS NOT NULL AND ${solvedOrClosed} AND ${stoppedAt} IS NOT NULL THEN
                         CASE WHEN ${stoppedAt} <= t."resolutionDueAt" THEN 'met' ELSE 'breached' END
                     END,
                     COALESCE(
                       t."resolutionBreachedAt",
                       CASE WHEN t."resolutionDueAt" IS NOT NULL AND ${solvedOrClosed} THEN ${stoppedAt} END
                     )
              FROM "Ticket" t
              WHERE ${ticketScope(filter)}
            )
            SELECT "target", "priority", "outcome",
                   ${bucketOf(Prisma.sql`"decidedAt"`)}::int AS "bucket",
                   count(*)::int AS "count"
            FROM outcomes
            WHERE "outcome" IS NOT NULL AND ${inRange(Prisma.sql`"decidedAt"`)}
            GROUP BY 1, 2, 3, 4`;

          // 7. What each member did in the range. The first responder is the author of the
          //    public agent reply written at the ticket's firstRespondedAt: the API writes both
          //    with the same timestamp, under the ticket's row lock.
          const activity = await tx.$queryRaw<ActivityRow[]>`
            SELECT e."actorUserId" AS "userId", 'solved' AS "kind", count(*)::int AS "count",
                   NULL::float8 AS "averageSeconds"
            FROM "TicketEvent" e
            WHERE ${activityScope(filter, 'e', 'actorUserId')}
              AND e."type" = 'STATUS_CHANGED'
              AND e."actorType" = 'USER'
              AND e."actorUserId" IS NOT NULL
              AND e."data"->>'to' = 'SOLVED'
              AND ${inRange(Prisma.sql`e."createdAt"`)}
            GROUP BY 1
            UNION ALL
            SELECT m."authorUserId", 'publicReplies', count(*)::int, NULL::float8
            FROM "Message" m
            WHERE ${activityScope(filter, 'm', 'authorUserId')}
              AND m."authorType" = 'AGENT'
              AND m."visibility" = 'PUBLIC'
              AND m."authorUserId" IS NOT NULL
              AND ${inRange(Prisma.sql`m."createdAt"`)}
            GROUP BY 1
            UNION ALL
            SELECT f."authorUserId", 'firstResponses', count(*)::int, avg(f.s)::float8
            FROM (
              SELECT DISTINCT ON (t."id") m."authorUserId",
                     EXTRACT(EPOCH FROM t."firstRespondedAt" - t."createdAt") AS s
              FROM "Ticket" t
              JOIN "Message" m
                ON m."organizationId" = t."organizationId" AND m."ticketId" = t."id"
               AND m."authorType" = 'AGENT' AND m."visibility" = 'PUBLIC'
               AND m."createdAt" = t."firstRespondedAt"
              WHERE t."organizationId" = ${filter.organizationId}::uuid
                AND ${inRange(Prisma.sql`t."firstRespondedAt"`)}
                AND t."firstRespondedAt" >= t."createdAt"
              ORDER BY t."id", m."id"
            ) f
            WHERE f."authorUserId" IS NOT NULL
              ${filter.userId === null ? Prisma.empty : Prisma.sql`AND f."authorUserId" = ${filter.userId}::uuid`}
            GROUP BY 1`;

          // 8. Members, for names and roles (tenant-guarded).
          const members = await tx.membership.findMany({
            where: {
              organizationId: filter.organizationId,
              ...(filter.userId !== null && { userId: filter.userId }),
            },
            select: { userId: true, role: true, user: { select: { name: true } } },
            orderBy: { createdAt: 'asc' },
          });

          return {
            created,
            statusChanges,
            firstResponse,
            resolution,
            createdByStatus: statusGroups.map((g) => ({
              status: g.status,
              count: g._count._all,
            })),
            slaOutcomes,
            activity,
            members,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  };
}

export type AnalyticsRepository = ReturnType<typeof createAnalyticsRepository>;
