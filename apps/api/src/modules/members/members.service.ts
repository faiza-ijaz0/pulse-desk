import type { Member, Role } from '@pulsedesk/shared';
import type { RequestMeta, TenantContext } from '../../http/auth-context.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { LastOwnerError, NoActiveOrganizationError, NotFoundError } from '../../http/errors.ts';
import type {
  MemberRow,
  MembersRepository,
  ScopedMembersRepository,
} from './members.repository.ts';
import { assertCanChangeRole, assertCanRemove } from './members.policy.ts';

function toDto(row: MemberRow): Member {
  return {
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    joinedAt: row.createdAt.toISOString(),
  };
}

/**
 * The actor's role as of now, read under the organization lock. The role resolved at the
 * start of the request may be stale if a concurrent request just demoted or removed them.
 */
async function lockedActor(
  members: ScopedMembersRepository,
  tenant: TenantContext,
): Promise<TenantContext> {
  const actor = await members.find(tenant.userId);
  if (!actor) throw new NoActiveOrganizationError();
  return { ...tenant, role: actor.role };
}

/**
 * Members of the caller's active organization. A user ID from another organization is
 * simply not found here (404), never a 403, so its existence isn't revealed.
 */
export function createMembersService({
  repository,
  clock = systemClock,
}: {
  repository: MembersRepository;
  clock?: Clock;
}) {
  return {
    async list(tenant: TenantContext): Promise<Member[]> {
      return (await repository.list(tenant.organizationId)).map(toDto);
    },

    changeRole(
      tenant: TenantContext,
      targetUserId: string,
      role: Role,
      meta: RequestMeta,
    ): Promise<Member> {
      return repository.withMemberLock(
        tenant.organizationId,
        { userId: targetUserId, mode: 'no key update' },
        async (members) => {
          const actor = await lockedActor(members, tenant);
          const target = await members.find(targetUserId);
          if (!target) throw new NotFoundError('Member');
          assertCanChangeRole(actor, target.role, role);
          if (target.role === role) return toDto(target);
          if (target.role === 'OWNER' && (await members.countOwners()) <= 1) {
            throw new LastOwnerError();
          }

          const updated = await members.updateRole(targetUserId, role);
          await members.audit(
            'membership.role_changed',
            targetUserId,
            { from: target.role, to: role },
            { actorUserId: tenant.userId, ipAddress: meta.ipAddress, requestId: tenant.requestId },
          );
          return toDto(updated);
        },
      );
    },

    remove(tenant: TenantContext, targetUserId: string, meta: RequestMeta): Promise<void> {
      return repository.withMemberLock(
        tenant.organizationId,
        { userId: targetUserId, mode: 'update' },
        async (members) => {
          const actor = await lockedActor(members, tenant);
          const target = await members.find(targetUserId);
          if (!target) throw new NotFoundError('Member');
          assertCanRemove(actor, target.role);
          if (target.role === 'OWNER' && (await members.countOwners()) <= 1) {
            throw new LastOwnerError();
          }

          await members.remove(targetUserId, tenant.userId, clock.now());
          await members.audit(
            'membership.removed',
            targetUserId,
            { role: target.role },
            { actorUserId: tenant.userId, ipAddress: meta.ipAddress, requestId: tenant.requestId },
          );
        },
      );
    },
  };
}

export type MembersService = ReturnType<typeof createMembersService>;
