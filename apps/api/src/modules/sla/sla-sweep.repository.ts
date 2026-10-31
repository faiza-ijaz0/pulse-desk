import { Prisma, type Database, type TicketEventType } from '@pulsedesk/db';
import { utcTimestamp as utc } from '../../lib/sql-time.ts';
import { withTransactionRetry } from '../../lib/transactions.ts';

export type SlaSweepTarget = 'firstResponse' | 'resolution';

/** A ticket that may have missed a target, found through that target's sweep index. */
export type SweepCandidate = {
  id: string;
  organizationId: string;
  /** The due date as PostgreSQL prints it: the keyset cursor, round-tripped as text. */
  dueAt: string;
};

export type SweepCursor = Pick<SweepCandidate, 'id' | 'dueAt'>;

export type BreachEventType = Extract<
  TicketEventType,
  'SLA_FIRST_RESPONSE_BREACHED' | 'SLA_RESOLUTION_BREACHED'
>;

/** What the sweep re-reads under the row lock: everything `evaluateSla` needs. */
const lockedSlaSelect = {
  status: true,
  createdAt: true,
  updatedAt: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  firstRespondedAt: true,
  solvedAt: true,
  closedAt: true,
  firstResponseBreachedAt: true,
  resolutionBreachedAt: true,
} as const satisfies Prisma.TicketSelect;

export type LockedSlaTicket = Prisma.TicketGetPayload<{ select: typeof lockedSlaSelect }>;

/** Writes on one locked ticket, all inside its organization and its transaction. */
export type BreachScope = {
  ticket: LockedSlaTicket;
  hasBreachEvent(type: BreachEventType): Promise<boolean>;
  addBreachEvent(type: BreachEventType, dueAt: Date, at: Date): Promise<void>;
  /** Sets the target's marker unless one is already recorded; true if this call set it. */
  markBreached(target: SlaSweepTarget, at: Date): Promise<boolean>;
};

/**
 * Data access for the SLA breach sweep (docs/architecture/data-model.md, "SLA clocks").
 *
 * The candidate search is the one deliberately cross-organization read in the API: the
 * sweep serves every organization. It is raw SQL (the tenant guard only inspects model
 * queries) and returns IDs only. Every write then goes through Prisma with the ticket's own
 * `organizationId`, so it can never touch another organization's rows.
 */
export function createSlaSweepRepository(db: Database) {
  return {
    /**
     * Tickets whose target is past due at `now` with no breach recorded, in due-date order
     * after `after`. Each query repeats its partial index's predicate exactly
     * (Ticket_first_response_breach_sweep_idx / Ticket_resolution_breach_sweep_idx), so
     * PostgreSQL can use the index; the extra `due < now` bound and the keyset cursor keep
     * the scan to tickets that are actually overdue and not yet seen in this sweep.
     */
    findCandidates(
      target: SlaSweepTarget,
      now: Date,
      after: SweepCursor | null,
      limit: number,
    ): Promise<SweepCandidate[]> {
      if (target === 'firstResponse') {
        const cursor = after
          ? Prisma.sql`AND ("firstResponseDueAt", "id") > (${after.dueAt}::timestamp(3), ${after.id}::uuid)`
          : Prisma.empty;
        return db.$queryRaw<SweepCandidate[]>`
          SELECT "id", "organizationId", "firstResponseDueAt"::text AS "dueAt"
          FROM "Ticket"
          WHERE "firstResponseDueAt" IS NOT NULL
            AND "firstResponseBreachedAt" IS NULL
            AND ("firstRespondedAt" IS NULL OR "firstRespondedAt" > "firstResponseDueAt")
            AND "firstResponseDueAt" < ${utc(now)}
            ${cursor}
          ORDER BY "firstResponseDueAt", "id"
          LIMIT ${limit}`;
      }
      const cursor = after
        ? Prisma.sql`AND ("resolutionDueAt", "id") > (${after.dueAt}::timestamp(3), ${after.id}::uuid)`
        : Prisma.empty;
      return db.$queryRaw<SweepCandidate[]>`
        SELECT "id", "organizationId", "resolutionDueAt"::text AS "dueAt"
        FROM "Ticket"
        WHERE "resolutionDueAt" IS NOT NULL
          AND "resolutionBreachedAt" IS NULL
          AND ("solvedAt" IS NULL OR "solvedAt" > "resolutionDueAt")
          AND "resolutionDueAt" < ${utc(now)}
          ${cursor}
        ORDER BY "resolutionDueAt", "id"
        LIMIT ${limit}`;
    },

    /**
     * Runs `fn` in one transaction with the ticket's row locked, or returns null without
     * waiting if another transaction holds the lock (an agent's write, or a concurrent
     * sweep) or the ticket is gone. SKIP LOCKED means the sweep never queues behind, or
     * deadlocks with, request traffic; a skipped ticket is simply picked up by the next run.
     */
    withLockedTicket<T>(
      candidate: Pick<SweepCandidate, 'id' | 'organizationId'>,
      fn: (scope: BreachScope) => Promise<T>,
    ): Promise<T | null> {
      const { id, organizationId } = candidate;
      return withTransactionRetry(() =>
        db.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Ticket"
            WHERE "organizationId" = ${organizationId}::uuid AND "id" = ${id}::uuid
            FOR UPDATE SKIP LOCKED`;
          if (locked.length === 0) return null;
          const ticket = await tx.ticket.findUnique({
            where: { organizationId_id: { organizationId, id } },
            select: lockedSlaSelect,
          });
          if (!ticket) return null;

          return fn({
            ticket,
            async hasBreachEvent(type) {
              const count = await tx.ticketEvent.count({
                where: { organizationId, ticketId: id, type },
              });
              return count > 0;
            },
            async addBreachEvent(type, dueAt, at) {
              await tx.ticketEvent.create({
                data: {
                  organizationId,
                  ticketId: id,
                  actorType: 'SYSTEM',
                  type,
                  data: { dueAt: dueAt.toISOString() },
                  createdAt: at,
                },
              });
            },
            async markBreached(target, at) {
              // A breach is not an edit: updatedAt keeps its value, so the inbox's "recently
              // updated" order doesn't change when the sweep records one.
              const { count } = await tx.ticket.updateMany({
                where:
                  target === 'firstResponse'
                    ? { organizationId, id, firstResponseBreachedAt: null }
                    : { organizationId, id, resolutionBreachedAt: null },
                data:
                  target === 'firstResponse'
                    ? { firstResponseBreachedAt: at, updatedAt: ticket.updatedAt }
                    : { resolutionBreachedAt: at, updatedAt: ticket.updatedAt },
              });
              return count === 1;
            },
          });
        }),
      );
    },
  };
}

export type SlaSweepRepository = ReturnType<typeof createSlaSweepRepository>;
