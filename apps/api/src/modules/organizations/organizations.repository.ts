import type { Database, Prisma } from '@pulsedesk/db';

const organizationSelect = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  autoCloseEnabled: true,
  autoCloseAfterMinutes: true,
} as const;

export type AuditEntry = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

/** The settings an organization's admins may change; undefined means "leave as is". */
export type OrganizationChanges = {
  name?: string | undefined;
  autoCloseEnabled?: boolean | undefined;
  autoCloseAfterMinutes?: number | undefined;
};

const CHANGEABLE = ['name', 'autoCloseEnabled', 'autoCloseAfterMinutes'] as const;

export function createOrganizationsRepository(db: Database) {
  return {
    findById(organizationId: string) {
      return db.organization.findUnique({
        where: { id: organizationId },
        select: organizationSelect,
      });
    },

    /**
     * Applies the given settings in one transaction with one audit entry listing exactly
     * what changed (`{ field: { from, to } }`). Values equal to the current ones change
     * nothing, so a no-op save writes and audits nothing.
     */
    update(organizationId: string, changes: OrganizationChanges, audit: AuditEntry) {
      return db.$transaction(async (tx) => {
        // Lock the row first, so concurrent updates apply in turn and each audit entry's
        // "from" is the value the previous update left.
        await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
        const before = await tx.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: organizationSelect,
        });

        const data: Prisma.OrganizationUpdateInput = {};
        const metadata: Record<
          string,
          { from: string | number | boolean; to: string | number | boolean }
        > = {};
        for (const field of CHANGEABLE) {
          const next = changes[field];
          if (next === undefined || next === before[field]) continue;
          Object.assign(data, { [field]: next });
          metadata[field] = { from: before[field], to: next };
        }
        if (Object.keys(metadata).length === 0) return before;

        const organization = await tx.organization.update({
          where: { id: organizationId },
          data,
          select: organizationSelect,
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: audit.actorUserId,
            action: 'organization.updated',
            targetType: 'Organization',
            targetId: organizationId,
            metadata,
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
