import type { Database, Role, TransactionClient } from '@pulsedesk/db';

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

    async remove(userId: string): Promise<void> {
      // Ticket → assignee is a composite FK with NO ACTION (data-model.md, layer 3), so the
      // member's tickets are unassigned first. Team memberships cascade with the membership.
      await client.ticket.updateMany({
        where: { organizationId, assigneeUserId: userId },
        data: { assigneeUserId: null },
      });
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
     * Runs `fn` in a transaction that holds a row lock on the organization, so concurrent
     * role changes and removals are serialized — two owners demoting each other at once
     * can't leave the organization without an owner.
     */
    withOrganizationLock<T>(
      organizationId: string,
      fn: (members: ScopedMembersRepository) => Promise<T>,
    ): Promise<T> {
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
        return fn(scopedTo(tx, organizationId));
      });
    },
  };
}

export type MembersRepository = ReturnType<typeof createMembersRepository>;
