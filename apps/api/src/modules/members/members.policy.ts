import { canManageRole, hasPermission, type Role } from '@pulsedesk/shared';
import type { TenantContext } from '../../http/auth-context.ts';
import { ForbiddenError } from '../../http/errors.ts';

// Resource-level rules on top of the route's coarse permission check
// (docs/architecture/auth-and-sessions.md §6): admins manage admins and agents; only
// owners manage owners or grant ownership.

export function assertCanChangeRole(actor: TenantContext, currentRole: Role, newRole: Role): void {
  if (!canManageRole(actor.role, currentRole) || !canManageRole(actor.role, newRole)) {
    throw new ForbiddenError('Only owners can change an owner’s role or grant ownership.');
  }
}

export function assertCanRemove(actor: TenantContext, targetRole: Role): void {
  if (!hasPermission(actor.role, 'member:remove') || !canManageRole(actor.role, targetRole)) {
    throw new ForbiddenError('Only owners can remove an owner.');
  }
}
