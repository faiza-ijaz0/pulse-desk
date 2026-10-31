import type { SlaPolicy, SlaPolicyResponse, UpdateSlaPolicyRequest } from '@pulsedesk/shared';
import type { RequestMeta, TenantContext } from '../../http/auth-context.ts';
import type { SlaPoliciesRepository, SlaPolicyRow } from './sla-policies.repository.ts';

function toDto(row: SlaPolicyRow): SlaPolicy {
  const target = (priority: SlaPolicyRow['targets'][number]['priority']) => {
    const stored = row.targets.find((t) => t.priority === priority);
    return stored
      ? {
          firstResponseMinutes: stored.firstResponseMinutes,
          resolutionMinutes: stored.resolutionMinutes,
        }
      : null;
  };
  return {
    id: row.id,
    name: row.name,
    updatedAt: row.updatedAt.toISOString(),
    targets: {
      URGENT: target('URGENT'),
      HIGH: target('HIGH'),
      NORMAL: target('NORMAL'),
      LOW: target('LOW'),
    },
  };
}

/** Operates only on the tenant's own default policy; there is no policy or organization ID to tamper with. */
export function createSlaPoliciesService({ repository }: { repository: SlaPoliciesRepository }) {
  return {
    async getDefault(tenant: TenantContext): Promise<SlaPolicyResponse> {
      const policy = await repository.findDefault(tenant.organizationId);
      return { policy: policy && toDto(policy) };
    },

    async saveDefault(
      tenant: TenantContext,
      input: UpdateSlaPolicyRequest,
      meta: RequestMeta,
    ): Promise<SlaPolicyResponse> {
      const policy = await repository.saveDefault(tenant.organizationId, input.targets, {
        actorUserId: tenant.userId,
        ipAddress: meta.ipAddress,
        requestId: tenant.requestId,
      });
      return { policy: toDto(policy) };
    },
  };
}

export type SlaPoliciesService = ReturnType<typeof createSlaPoliciesService>;
