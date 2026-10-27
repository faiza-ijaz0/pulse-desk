import { prismaErrorCode, type Database } from '@pulsedesk/db';
import { ACTIVE_TICKET_STATUSES, type CustomerCursor } from '@pulsedesk/shared';
import { literalContains } from '../../lib/like.ts';

const customerSelect = { id: true, name: true, email: true, createdAt: true } as const;

export type CustomerRow = { id: string; name: string | null; email: string; createdAt: Date };
export type TicketCounts = { ticketCount: number; activeTicketCount: number };

export type AuditEntry = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

/** Thrown inside an update when the new email belongs to another customer. */
export class CustomerEmailTakenError extends Error {}

/** Every query is pinned to one organization; another tenant's IDs simply match nothing. */
export function createCustomersRepository(db: Database) {
  return {
    /**
     * Customers ordered by email, which is unique per organization: a total order, so
     * keyset pagination never skips or repeats a row. `text` matches name or email.
     */
    list(
      organizationId: string,
      options: { text?: string | undefined; after?: CustomerCursor | undefined; take: number },
    ): Promise<CustomerRow[]> {
      const pattern = options.text === undefined ? undefined : literalContains(options.text);
      return db.customer.findMany({
        where: {
          organizationId,
          AND: [
            pattern === undefined
              ? {}
              : {
                  OR: [
                    { name: { contains: pattern, mode: 'insensitive' } },
                    { email: { contains: pattern, mode: 'insensitive' } },
                  ],
                },
            options.after === undefined ? {} : { email: { gt: options.after.email } },
          ],
        },
        select: customerSelect,
        orderBy: { email: 'asc' },
        take: options.take,
      });
    },

    find(organizationId: string, customerId: string): Promise<CustomerRow | null> {
      return db.customer.findUnique({
        where: { organizationId_id: { organizationId, id: customerId } },
        select: customerSelect,
      });
    },

    /**
     * Ticket counts for a page of customers in one grouped query (never one per customer).
     * Customers without tickets are simply absent from the map.
     */
    async ticketCounts(
      organizationId: string,
      customerIds: string[],
    ): Promise<Map<string, TicketCounts>> {
      const counts = new Map<string, TicketCounts>();
      if (customerIds.length === 0) return counts;
      const groups = await db.ticket.groupBy({
        by: ['customerId', 'status'],
        where: { organizationId, customerId: { in: customerIds } },
        _count: { _all: true },
      });
      for (const group of groups) {
        const current = counts.get(group.customerId) ?? { ticketCount: 0, activeTicketCount: 0 };
        current.ticketCount += group._count._all;
        if (ACTIVE_TICKET_STATUSES.includes(group.status)) {
          current.activeTicketCount += group._count._all;
        }
        counts.set(group.customerId, current);
      }
      return counts;
    },

    /** Updates contact details and audits the change, in one transaction; no-ops write nothing. */
    async update(
      organizationId: string,
      customerId: string,
      changes: { name?: string | null | undefined; email?: string | undefined },
      audit: AuditEntry,
    ): Promise<CustomerRow | null> {
      try {
        return await db.$transaction(async (tx) => {
          // Lock the row first, so concurrent edits apply in turn and each audit entry's
          // "from" is the value the previous edit left.
          await tx.$queryRaw`
            SELECT 1 FROM "Customer"
            WHERE "organizationId" = ${organizationId}::uuid AND "id" = ${customerId}::uuid
            FOR UPDATE`;
          const before = await tx.customer.findUnique({
            where: { organizationId_id: { organizationId, id: customerId } },
            select: customerSelect,
          });
          if (!before) return null;
          // A request that changes nothing writes nothing — not even an audit entry.
          const unchanged =
            (changes.name === undefined || changes.name === before.name) &&
            (changes.email === undefined || changes.email === before.email);
          if (unchanged) return before;
          const after = await tx.customer.update({
            where: { organizationId_id: { organizationId, id: customerId } },
            data: {
              ...(changes.name !== undefined && { name: changes.name }),
              ...(changes.email !== undefined && { email: changes.email }),
            },
            select: customerSelect,
          });
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: audit.actorUserId,
              action: 'customer.updated',
              targetType: 'Customer',
              targetId: customerId,
              metadata: {
                name: { from: before.name, to: after.name },
                email: { from: before.email, to: after.email },
              },
              ipAddress: audit.ipAddress ?? null,
              requestId: audit.requestId,
            },
          });
          return after;
        });
      } catch (error) {
        // (organizationId, email) is unique: another customer here already has this email.
        if (prismaErrorCode(error) === 'P2002') throw new CustomerEmailTakenError();
        throw error;
      }
    },
  };
}

export type CustomersRepository = ReturnType<typeof createCustomersRepository>;
