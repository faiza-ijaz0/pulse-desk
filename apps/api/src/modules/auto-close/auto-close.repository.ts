import { Prisma, type Database, type TicketStatus } from '@pulsedesk/db';
import { utcTimestamp } from '../../lib/sql-time.ts';
import { withTransactionRetry } from '../../lib/transactions.ts';

const MINUTE = 60_000;

/** A solved ticket that may be due to close, found through Ticket_auto_close_sweep_idx. */
export type AutoCloseCandidate = {
  id: string;
  organizationId: string;
  /** `solvedAt` as PostgreSQL prints it: the keyset cursor, round-tripped as text. */
  solvedAt: string;
};

export type AutoCloseCursor = Pick<AutoCloseCandidate, 'id' | 'solvedAt'>;

/** What the sweep re-reads under the row lock. */
export type LockedClosable = {
  ticket: { status: TicketStatus; solvedAt: Date | null; closedAt: Date | null; updatedAt: Date };
  settings: { autoCloseEnabled: boolean; autoCloseAfterMinutes: number };
};

export type CloseScope = LockedClosable & {
  /**
   * Closes the ticket at `at` and records the SYSTEM `STATUS_CHANGED` event, both in this
   * transaction. The update is conditional on the ticket still being SOLVED; it returns false
   * (and writes no event) if it wasn't.
   */
  close(at: Date): Promise<boolean>;
};

/**
 * Data access for the auto-close sweep (docs/architecture/data-model.md, "Auto-close").
 * The candidate search is a deliberately cross-organization read (the sweep serves every
 * organization) in raw SQL, returning IDs only; every write then goes through Prisma with
 * the ticket's own `organizationId`.
 */
export function createAutoCloseRepository(db: Database) {
  return {
    /**
     * Solved tickets of organizations with auto-close on, whose solve and last update are
     * both at least the organization's delay before `now`, in `solvedAt` order after
     * `after`. `"status" = 'SOLVED'` repeats the partial index's predicate, and the
     * `solvedAt <= now − 1 minute` bound (the shortest possible delay) lets PostgreSQL
     * range-scan it before applying each organization's delay.
     */
    findCandidates(
      now: Date,
      after: AutoCloseCursor | null,
      limit: number,
    ): Promise<AutoCloseCandidate[]> {
      const cursor = after
        ? Prisma.sql`AND (t."solvedAt", t."id") > (${after.solvedAt}::timestamp(3), ${after.id}::uuid)`
        : Prisma.empty;
      return db.$queryRaw<AutoCloseCandidate[]>`
        SELECT t."id", t."organizationId", t."solvedAt"::text AS "solvedAt"
        FROM "Ticket" t
        JOIN "Organization" o ON o."id" = t."organizationId"
        WHERE t."status" = 'SOLVED'
          AND t."solvedAt" IS NOT NULL
          AND t."solvedAt" <= ${utcTimestamp(new Date(now.getTime() - MINUTE))}
          AND o."autoCloseEnabled"
          AND t."solvedAt" + o."autoCloseAfterMinutes" * interval '1 minute' <= ${utcTimestamp(now)}
          AND t."updatedAt" + o."autoCloseAfterMinutes" * interval '1 minute' <= ${utcTimestamp(now)}
          ${cursor}
        ORDER BY t."solvedAt", t."id"
        LIMIT ${limit}`;
    },

    /**
     * Runs `fn` in one transaction with the ticket's row locked, or returns null without
     * waiting if another transaction holds it (an agent reopening or editing the ticket, or a
     * concurrent sweep) or the ticket is gone. The organization's settings are re-read in the
     * same transaction, so turning auto-close off takes effect for every ticket not yet closed.
     */
    withLockedTicket<T>(
      candidate: Pick<AutoCloseCandidate, 'id' | 'organizationId'>,
      fn: (scope: CloseScope) => Promise<T>,
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
            select: { status: true, solvedAt: true, closedAt: true, updatedAt: true },
          });
          const settings = await tx.organization.findUnique({
            where: { id: organizationId },
            select: { autoCloseEnabled: true, autoCloseAfterMinutes: true },
          });
          if (!ticket || !settings) return null;

          return fn({
            ticket,
            settings,
            async close(at) {
              // Closure is a real state change, like an agent's: updatedAt moves with it.
              const { count } = await tx.ticket.updateMany({
                where: { organizationId, id, status: 'SOLVED' },
                data: { status: 'CLOSED', closedAt: at, updatedAt: at },
              });
              if (count !== 1) return false;
              await tx.ticketEvent.create({
                data: {
                  organizationId,
                  ticketId: id,
                  actorType: 'SYSTEM',
                  type: 'STATUS_CHANGED',
                  data: { from: 'SOLVED', to: 'CLOSED' },
                  createdAt: at,
                },
              });
              return true;
            },
          });
        }),
      );
    },
  };
}

export type AutoCloseRepository = ReturnType<typeof createAutoCloseRepository>;
