import type { Database } from '@pulsedesk/db';

const organizationSelect = { id: true, name: true, slug: true, createdAt: true } as const;

export type AuditEntry = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

export function createOrganizationsRepository(db: Database) {
  return {
    findById(organizationId: string) {
      return db.organization.findUnique({
        where: { id: organizationId },
        select: organizationSelect,
      });
    },

    rename(organizationId: string, name: string, audit: AuditEntry) {
      return db.$transaction(async (tx) => {
        // Lock the row first, so concurrent renames apply in turn and each audit entry's
        // "from" is the name the previous rename left.
        await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
        const before = await tx.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: organizationSelect,
        });
        // Renaming to the current name changes nothing, so nothing is written or audited.
        if (before.name === name) return before;
        const organization = await tx.organization.update({
          where: { id: organizationId },
          data: { name },
          select: organizationSelect,
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: audit.actorUserId,
            action: 'organization.updated',
            targetType: 'Organization',
            targetId: organizationId,
            metadata: { name: { from: before.name, to: name } },
            ipAddress: audit.ipAddress ?? null,
            requestId: audit.requestId,
          },
        });
        return organization;
      });
    },
  };
}

export type OrganizationsRepository = ReturnType<typeof createOrganizationsRepository>;
