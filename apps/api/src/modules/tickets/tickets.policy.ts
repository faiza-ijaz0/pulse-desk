import { hasPermission } from '@pulsedesk/shared';
import type { TenantContext } from '../../http/auth-context.ts';
import { ForbiddenError } from '../../http/errors.ts';

// Field-level rules on top of the route's coarse check (`ticket:reply`). Who owns a ticket
// is an assignment decision: every current role holds `ticket:assign`, and this check
// keeps a future role without it from reassigning tickets through create or update.

type AssignmentFields = {
  assigneeUserId?: string | null | undefined;
  teamId?: string | null | undefined;
};

export function assertCanAssign(actor: TenantContext, input: AssignmentFields): void {
  const assigns = input.assigneeUserId !== undefined || input.teamId !== undefined;
  if (assigns && !hasPermission(actor.role, 'ticket:assign')) {
    throw new ForbiddenError('Your role in this organization does not allow assigning tickets.');
  }
}
