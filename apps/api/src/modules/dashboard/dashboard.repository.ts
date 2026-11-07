import {
  Prisma,
  type Database,
  type Role,
  type TicketPriority,
  type TicketStatus,
} from '@pulsedesk/db';
import {
  ACTIVE_TICKET_STATUSES,
  DASHBOARD_ATTENTION_LIMIT,
  SLA_AT_RISK_REMAINING_FRACTION,
  type SlaStatus,
} from '@pulsedesk/shared';
import { utcTimestamp as utc } from '../../lib/sql-time.ts';

/**
 * Whose tickets a dashboard query covers. `organizationId` always comes from the session's
 * tenant context; `assigneeUserId` narrows it to one member's tickets (the `own` scope).
 */
export type DashboardFilter = { organizationId: string; assigneeUserId: string | null };

/** Active tickets per assignee (`null` = unassigned), with their SLA states at `now`. */
export type WorkloadRow = {
  assigneeUserId: string | null;
  active: number;
  open: number;
  pending: number;
  onHold: number;
  awaitingFirstResponse: number;
} & Record<SlaStatus, number>;

export type AttentionRow = {
  number: number;
  subject: string;
  priority: TicketPriority;
  status: 'at_risk' | 'first_response_breached' | 'resolution_breached';
  target: 'firstResponse' | 'resolution';
  dueAt: Date | null;
};

export type TimingRow = {
  firstResponseCount: number;
  firstResponseAverageSeconds: number | null;
  resolutionCount: number;
  resolutionAverageSeconds: number | null;
};

export type MemberRow = { userId: string; role: Role; user: { name: string } };

export type DashboardSnapshot = {
  statusCounts: { status: TicketStatus; count: number }[];
  workload: WorkloadRow[];
  attention: AttentionRow[];
  timing: TimingRow;
  members: MemberRow[];
};

/**
 * The raw-SQL tenant filter. Raw queries bypass the Prisma tenant guard, so every raw
 * statement below starts from this fragment: there is no code path without it.
 */
function scope({ organizationId, assigneeUserId }: DashboardFilter): Prisma.Sql {
  const own =
    assigneeUserId === null
      ? Prisma.empty
      : Prisma.sql`AND t."assigneeUserId" = ${assigneeUserId}::uuid`;
  return Prisma.sql`t."organizationId" = ${organizationId}::uuid ${own}`;
}

/**
 * One SLA target's state at `now`, mirroring `evaluateTarget` in packages/shared/src/sla.ts
 * branch for branch: a recorded breach first, then no due date, then a stopped clock (met at
 * or before the due date), then past due (breached one millisecond later), then the at-risk
 * share of the window from creation to the due date. The columns are `timestamp(3)`, so the
 * comparisons are as exact as the JavaScript ones; `EXTRACT(EPOCH …)` returns exact numerics.
 * The integration suite checks this against `evaluateSla` ticket by ticket.
 */
function targetState(
  dueAt: Prisma.Sql,
  stoppedAt: Prisma.Sql | null,
  breachedAt: Prisma.Sql,
  now: Prisma.Sql,
): Prisma.Sql {
  const stopped = stoppedAt
    ? Prisma.sql`WHEN ${stoppedAt} IS NOT NULL THEN CASE WHEN ${stoppedAt} <= ${dueAt} THEN 'met' ELSE 'breached' END`
    : Prisma.empty;
  return Prisma.sql`CASE
      WHEN ${breachedAt} IS NOT NULL THEN 'breached'
      WHEN ${dueAt} IS NULL THEN 'none'
      ${stopped}
      WHEN ${dueAt} < ${now} THEN 'breached'
      WHEN EXTRACT(EPOCH FROM ${dueAt} - ${now})
        <= EXTRACT(EPOCH FROM ${dueAt} - t."createdAt") * ${SLA_AT_RISK_REMAINING_FRACTION}::numeric
        THEN 'at_risk'
      ELSE 'on_track'
    END`;
}

/**
 * Active tickets in scope with their per-target and overall SLA state (`overallStatus` in
 * sla.ts: a resolution breach first, then a first-response breach, at risk, on track, met,
 * none). Active tickets never have a stopped resolution clock, so that branch is omitted.
 */
function classifiedActiveTickets(filter: DashboardFilter, now: Date): Prisma.Sql {
  const at = utc(now);
  const firstResponse = targetState(
    Prisma.sql`t."firstResponseDueAt"`,
    Prisma.sql`t."firstRespondedAt"`,
    Prisma.sql`t."firstResponseBreachedAt"`,
    at,
  );
  const resolution = targetState(
    Prisma.sql`t."resolutionDueAt"`,
    null,
    Prisma.sql`t."resolutionBreachedAt"`,
    at,
  );
  return Prisma.sql`
    WITH targets AS (
      SELECT t."number", t."subject", t."priority", t."status", t."assigneeUserId",
             t."firstRespondedAt", t."firstResponseDueAt", t."resolutionDueAt",
             ${firstResponse} AS fr, ${resolution} AS res
      FROM "Ticket" t
      WHERE ${scope(filter)}
        AND t."status"::text IN (${Prisma.join(ACTIVE_TICKET_STATUSES)})
    ),
    classified AS (
      SELECT *, CASE
          WHEN res = 'breached' THEN 'resolution_breached'
          WHEN fr = 'breached' THEN 'first_response_breached'
          WHEN 'at_risk' IN (fr, res) THEN 'at_risk'
          WHEN 'on_track' IN (fr, res) THEN 'on_track'
          WHEN 'met' IN (fr, res) THEN 'met'
          ELSE 'none'
        END AS sla
      FROM targets
    )`;
}

/**
 * Read-only data access for the dashboard. Everything is read in one REPEATABLE READ,
 * READ ONLY transaction, so all figures describe the same snapshot (the per-status totals
 * and the per-assignee totals can't drift apart under concurrent writes).
 *
 * Query plan, independent of the number of members or tickets (no N+1):
 * 1. status counts: Prisma `groupBy` (tenant-guarded), index (organizationId, status, …);
 * 2. workload: one aggregate over active tickets, grouped by assignee;
 * 3. attention: the same classification, at most DASHBOARD_ATTENTION_LIMIT rows;
 * 4. response times: one aggregate over tickets answered or solved inside the window;
 * 5. members: Prisma `findMany` (tenant-guarded), for names and roles.
 */
export function createDashboardRepository(db: Database) {
  return {
    snapshot(filter: DashboardFilter, now: Date, windowStart: Date): Promise<DashboardSnapshot> {
      return db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;

          const statusGroups = await tx.ticket.groupBy({
            by: ['status'],
            where: {
              organizationId: filter.organizationId,
              ...(filter.assigneeUserId !== null && { assigneeUserId: filter.assigneeUserId }),
            },
            _count: { _all: true },
          });

          const classified = classifiedActiveTickets(filter, now);
          const workload = await tx.$queryRaw<WorkloadRow[]>`
            ${classified}
            SELECT "assigneeUserId",
                   count(*)::int AS "active",
                   (count(*) FILTER (WHERE "status" = 'OPEN'))::int AS "open",
                   (count(*) FILTER (WHERE "status" = 'PENDING'))::int AS "pending",
                   (count(*) FILTER (WHERE "status" = 'ON_HOLD'))::int AS "onHold",
                   (count(*) FILTER (WHERE "firstRespondedAt" IS NULL))::int AS "awaitingFirstResponse",
                   (count(*) FILTER (WHERE sla = 'none'))::int AS "none",
                   (count(*) FILTER (WHERE sla = 'met'))::int AS "met",
                   (count(*) FILTER (WHERE sla = 'on_track'))::int AS "on_track",
                   (count(*) FILTER (WHERE sla = 'at_risk'))::int AS "at_risk",
                   (count(*) FILTER (WHERE sla = 'first_response_breached'))::int AS "first_response_breached",
                   (count(*) FILTER (WHERE sla = 'resolution_breached'))::int AS "resolution_breached"
            FROM classified
            GROUP BY "assigneeUserId"`;

          // Breaches first (most overdue first), then at-risk tickets by the earliest due date.
          const attention = await tx.$queryRaw<AttentionRow[]>`
            ${classified},
            urgent AS (
              SELECT "number", "subject", "priority", sla AS "status",
                     "firstResponseDueAt", "resolutionDueAt",
                     CASE
                       WHEN sla = 'resolution_breached' THEN 'resolution'
                       WHEN sla = 'first_response_breached' THEN 'firstResponse'
                       WHEN fr = 'at_risk' AND (res <> 'at_risk' OR "firstResponseDueAt" <= "resolutionDueAt")
                         THEN 'firstResponse'
                       ELSE 'resolution'
                     END AS "target"
              FROM classified
              WHERE sla IN ('at_risk', 'first_response_breached', 'resolution_breached')
            ),
            dated AS (
              SELECT "number", "subject", "priority", "status", "target",
                     CASE WHEN "target" = 'firstResponse' THEN "firstResponseDueAt" ELSE "resolutionDueAt" END
                       AS "dueAt"
              FROM urgent
            )
            SELECT * FROM dated
            ORDER BY ("status" = 'at_risk'), "dueAt" ASC NULLS LAST, "number"
            LIMIT ${DASHBOARD_ATTENTION_LIMIT}`;

          // A duration counts only when it is a real, completed interval: the end inside the
          // window, not in the future, and not before the ticket was created.
          const timing = await tx.$queryRaw<TimingRow[]>`
            WITH windowed AS (
              SELECT t."createdAt", t."firstRespondedAt", t."solvedAt",
                     (t."firstRespondedAt" >= ${utc(windowStart)} AND t."firstRespondedAt" <= ${utc(now)}
                       AND t."firstRespondedAt" >= t."createdAt") AS fr_ok,
                     (t."solvedAt" >= ${utc(windowStart)} AND t."solvedAt" <= ${utc(now)}
                       AND t."solvedAt" >= t."createdAt"
                       AND t."status"::text IN ('SOLVED', 'CLOSED')) AS res_ok
              FROM "Ticket" t
              WHERE ${scope(filter)}
                AND (t."firstRespondedAt" >= ${utc(windowStart)} OR t."solvedAt" >= ${utc(windowStart)})
            )
            SELECT (count(*) FILTER (WHERE fr_ok))::int AS "firstResponseCount",
                   (avg(EXTRACT(EPOCH FROM "firstRespondedAt" - "createdAt")) FILTER (WHERE fr_ok))::float8
                     AS "firstResponseAverageSeconds",
                   (count(*) FILTER (WHERE res_ok))::int AS "resolutionCount",
                   (avg(EXTRACT(EPOCH FROM "solvedAt" - "createdAt")) FILTER (WHERE res_ok))::float8
                     AS "resolutionAverageSeconds"
            FROM windowed`;

          const members = await tx.membership.findMany({
            where: {
              organizationId: filter.organizationId,
              ...(filter.assigneeUserId !== null && { userId: filter.assigneeUserId }),
            },
            select: { userId: true, role: true, user: { select: { name: true } } },
            orderBy: { createdAt: 'asc' },
          });

          return {
            statusCounts: statusGroups.map((g) => ({ status: g.status, count: g._count._all })),
            workload,
            attention,
            // An aggregate without GROUP BY always returns exactly one row.
            timing: timing[0] ?? {
              firstResponseCount: 0,
              firstResponseAverageSeconds: null,
              resolutionCount: 0,
              resolutionAverageSeconds: null,
            },
            members,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  };
}

export type DashboardRepository = ReturnType<typeof createDashboardRepository>;
