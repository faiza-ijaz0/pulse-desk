import type { Organization, UpdateOrganizationRequest } from '@pulsedesk/shared';
import type { RequestMeta, TenantContext } from '../../http/auth-context.ts';
import { NotFoundError } from '../../http/errors.ts';
import type { OrganizationsRepository } from './organizations.repository.ts';

type OrganizationRow = { id: string; name: string; slug: string; createdAt: Date };

function toDto(row: OrganizationRow): Organization {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** Operates only on the tenant's own organization; there is no organization ID to tamper with. */
export function createOrganizationsService({
  repository,
}: {
  repository: OrganizationsRepository;
}) {
  return {
    async getCurrent(tenant: TenantContext): Promise<Organization> {
      const organization = await repository.findById(tenant.organizationId);
      if (!organization) throw new NotFoundError('Organization');
      return toDto(organization);
    },

    async update(
      tenant: TenantContext,
      input: UpdateOrganizationRequest,
      meta: RequestMeta,
    ): Promise<Organization> {
      const organization = await repository.rename(tenant.organizationId, input.name, {
        actorUserId: tenant.userId,
        ipAddress: meta.ipAddress,
        requestId: tenant.requestId,
      });
      return toDto(organization);
    },
  };
}

export type OrganizationsService = ReturnType<typeof createOrganizationsService>;
