import type { Database, Role, TransactionClient } from '@pulsedesk/db';
import { withTransactionRetry } from '../../lib/transactions.ts';
import type { StoredEvent } from '../tickets/ticket-event-data.ts';

const memberSelect = {
  userId: true,
  role: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
} as const;

export type MemberRow = {
  userId: string;
  role: Role;
  createdAt: Date;
  user: { name: string; email: string };
};

export type MemberAudit = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

/** Every query here is pinned to one organization: the caller's tenant. */
function scopedTo(client: TransactionClient, organizationId: string) {
  const key = (userId: string) => ({ organizationId_userId: { organizationId, userId } });

  return {
    find(userId: string): Promise<MemberRow | null> {
      return client.membership.findUnique({ where: key(userId), select: memberSelect });
    },

    countOwners(): Promise<number> {
      return client.membership.count({ where: { organizationId, role: 'OWNER' } });
    },

    updateRole(userId: string, role: Role): Promise<MemberRow> {
      return client.membership.update({ where: key(userId), data: { role }, select: memberSelect });
    },

    /**
     * Ticket → assignee is a composite FK with NO ACTION (data-model.md, layer 3), so the
     * member's tickets are unassigned first, each with an ASSIGNED event so its timeline
     * says who unassigned it. Team memberships cascade with the membership.
     */
    async remove(userId: string, actorUserId: string, at: Date): Promise<void> {
      const tickets = await client.ticket.findMany({
        where: { organizationId, assigneeUserId: userId },
        select: { id: true },
      });
      if (tickets.length > 0) {
        const ids = tickets.map((t) => t.id);
        await client.ticket.updateMany({
          where: { organizationId, id: { in: ids } },
          data: { assigneeUserId: null, updatedAt: at },
        });
        const event: StoredEvent = {
          type: 'ASSIGNED',
          data: { fromUserId: userId, toUserId: null },
        };
        await client.ticketEvent.createMany({
          data: ids.map((ticketId) => ({
            organizationId,
            ticketId,
            actorUserId,
            type: event.type,
            data: event.data,
            createdAt: at,
          })),
        });
      }
      await client.membership.delete({ where: key(userId) });
    },

    async audit(
      action: string,
      targetUserId: string,
      metadata: Record<string, string>,
      entry: MemberAudit,
    ): Promise<void> {
      await client.auditLog.create({
        data: {
          organizationId,
          actorUserId: entry.actorUserId,
          action,
          targetType: 'Membership',
          targetId: targetUserId,
          metadata,
          ipAddress: entry.ipAddress ?? null,
          requestId: entry.requestId,
        },
      });
    },
  };
}

export type ScopedMembersRepository = ReturnType<typeof scopedTo>;

export function createMembersRepository(db: Database) {
  return {
    list(organizationId: string): Promise<MemberRow[]> {
      return db.membership.findMany({
        where: { organizationId },
        select: memberSelect,
        orderBy: { createdAt: 'asc' },
      });
    },

    /**
     * Runs `fn` in a transaction that first locks the target membership row, then the
     * organization row:
     * - the organization lock serializes role changes and removals, so two owners demoting
     *   each other at once can't leave the organization without an owner;
     * - the membership lock comes first because ticket writes lock the members they assign
     *   (FOR KEY SHARE) before anything else. Removal (`update`) then waits for in-flight
     *   assignments and unassigns them; an assignment arriving later sees no member. A role
     *   change (`no key update`) doesn't conflict with assignments at all.
     * Taking the two locks in the same order as every other writer avoids deadlocks.
     */
    withMemberLock<T>(
      organizationId: string,
      target: { userId: string; mode: 'update' | 'no key update' },
      fn: (members: ScopedMembersRepository) => Promise<T>,
    ): Promise<T> {
      return withTransactionRetry(() =>
        db.$transaction(async (tx) => {
          if (target.mode === 'update') {
            await tx.$queryRaw`
              SELECT 1 FROM "Membership"
              WHERE "organizationId" = ${organizationId}::uuid AND "userId" = ${target.userId}::uuid
              FOR UPDATE`;
          } else {
            await tx.$queryRaw`
              SELECT 1 FROM "Membership"
              WHERE "organizationId" = ${organizationId}::uuid AND "userId" = ${target.userId}::uuid
              FOR NO KEY UPDATE`;
          }
          await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
          return fn(scopedTo(tx, organizationId));
        }),
      );
    },
  };
}

export type MembersRepository = ReturnType<typeof createMembersRepository>;
