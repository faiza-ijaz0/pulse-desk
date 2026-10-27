import {
  transitionTicketStatus,
  type CreateMessageRequest,
  type CreateTicketInput,
  type UpdateTicketInput,
} from '@pulsedesk/shared';
import type { TenantContext } from '../../http/auth-context.ts';
import {
  InvalidStatusTransitionError,
  NotFoundError,
  TicketClosedError,
  ValidationError,
} from '../../http/errors.ts';
import type { Clock } from '../../lib/clock.ts';
import type { StoredEvent } from './ticket-event-data.ts';
import { assertCanAssign } from './tickets.policy.ts';
import type {
  LockedTicket,
  SlaTarget,
  TicketChanges,
  TicketsRepository,
  TicketWriteScope,
} from './tickets.repository.ts';

const MINUTE = 60_000;

/** Due dates for a ticket opened at `openedAt` under `target` (calendar time, v1). */
function dueDates(openedAt: Date, target: SlaTarget | null) {
  if (!target) return { firstResponseDueAt: null, resolutionDueAt: null };
  return {
    firstResponseDueAt: new Date(openedAt.getTime() + target.firstResponseMinutes * MINUTE),
    resolutionDueAt: new Date(openedAt.getTime() + target.resolutionMinutes * MINUTE),
  };
}

type References = {
  assigneeUserId?: string | null | undefined;
  teamId?: string | null | undefined;
  tagIds?: string[] | undefined;
};

/**
 * Rejects assignee, team and tag IDs that don't exist in the active organization. A
 * foreign ID gets the same answer as one that never existed, so nothing about other
 * tenants can be learned from it.
 */
async function assertReferencesExist(scope: TicketWriteScope, refs: References): Promise<void> {
  const existing = await scope.existingReferences({
    userIds: refs.assigneeUserId ? [refs.assigneeUserId] : [],
    teamIds: refs.teamId ? [refs.teamId] : [],
    tagIds: refs.tagIds ?? [],
  });
  const errors = [];
  if (refs.assigneeUserId && !existing.userIds.has(refs.assigneeUserId)) {
    errors.push({
      path: 'body.assigneeUserId',
      message: 'No member of this organization has this ID',
    });
  }
  if (refs.teamId && !existing.teamIds.has(refs.teamId)) {
    errors.push({ path: 'body.teamId', message: 'No team in this organization has this ID' });
  }
  if (refs.tagIds?.some((id) => !existing.tagIds.has(id))) {
    errors.push({ path: 'body.tagIds', message: 'Every tag must exist in this organization' });
  }
  if (errors.length > 0) throw new ValidationError(errors);
}

async function lockOpenTicket(scope: TicketWriteScope, number: number): Promise<LockedTicket> {
  const ticket = await scope.lockTicket(number);
  if (!ticket) throw new NotFoundError('Ticket');
  if (ticket.status === 'CLOSED') throw new TicketClosedError();
  return ticket;
}

/**
 * The write half of the tickets service. Each operation runs in one transaction: the
 * ticket, its tags and messages, and the timeline events describing the change commit or
 * roll back together. Each returns the ticket number, which the caller re-reads.
 */
export function createTicketWrites({
  repository,
  clock,
}: {
  repository: TicketsRepository;
  clock: Clock;
}) {
  return {
    create(tenant: TenantContext, input: CreateTicketInput): Promise<number> {
      assertCanAssign(tenant, input);
      return repository.write(tenant.organizationId, async (scope) => {
        // Validate before taking a number, so a rejected request leaves no gap.
        await assertReferencesExist(scope, input);
        const now = clock.now();
        const customer = await scope.upsertCustomer(input.customer.email, input.customer.name);
        const sla = await scope.defaultSlaTarget(input.priority);
        const number = await scope.nextTicketNumber();
        const ticket = await scope.createTicket({
          number,
          subject: input.subject,
          priority: input.priority,
          channel: input.channel,
          customerId: customer.id,
          assigneeUserId: input.assigneeUserId ?? null,
          teamId: input.teamId ?? null,
          slaPolicyId: sla?.slaPolicyId ?? null,
          ...dueDates(now, sla),
          createdAt: now,
        });
        await scope.changeTags(ticket.id, input.tagIds, []);
        // The request text is the customer's: it opens the conversation as their message.
        await scope.createMessage({
          ticketId: ticket.id,
          authorType: 'CUSTOMER',
          authorCustomerId: customer.id,
          visibility: 'PUBLIC',
          body: input.message,
          createdAt: now,
        });
        await scope.addEvents(ticket.id, tenant.userId, now, [{ type: 'CREATED', data: {} }]);
        return number;
      });
    },

    update(tenant: TenantContext, number: number, input: UpdateTicketInput): Promise<number> {
      assertCanAssign(tenant, input);
      return repository.write(tenant.organizationId, async (scope) => {
        // References first, then the ticket row: the lock order every writer follows.
        await assertReferencesExist(scope, input);
        const ticket = await lockOpenTicket(scope, number);
        const now = clock.now();
        const changes: TicketChanges = {};
        const events: StoredEvent[] = [];

        if (input.status !== undefined && input.status !== ticket.status) {
          const { status, solvedAt, closedAt } = ticket;
          const result = transitionTicketStatus(
            { status, solvedAt, closedAt },
            input.status,
            'agent',
            now,
          );
          if (!result.ok) throw new InvalidStatusTransitionError(result.reason);
          Object.assign(changes, result.state);
          events.push({ type: 'STATUS_CHANGED', data: { from: ticket.status, to: input.status } });
        }

        if (input.priority !== undefined && input.priority !== ticket.priority) {
          changes.priority = input.priority;
          events.push({
            type: 'PRIORITY_CHANGED',
            data: { from: ticket.priority, to: input.priority },
          });
          // Targets that are still open follow the new priority; met ones are history.
          const target = ticket.slaPolicyId
            ? await scope.slaTarget(ticket.slaPolicyId, input.priority)
            : null;
          if (target) {
            const due = dueDates(ticket.createdAt, target);
            if (ticket.firstRespondedAt === null) {
              changes.firstResponseDueAt = due.firstResponseDueAt;
            }
            if (ticket.solvedAt === null) changes.resolutionDueAt = due.resolutionDueAt;
          }
        }

        if (input.assigneeUserId !== undefined && input.assigneeUserId !== ticket.assigneeUserId) {
          changes.assigneeUserId = input.assigneeUserId;
          events.push({
            type: 'ASSIGNED',
            data: { fromUserId: ticket.assigneeUserId, toUserId: input.assigneeUserId },
          });
        }

        if (input.teamId !== undefined && input.teamId !== ticket.teamId) {
          changes.teamId = input.teamId;
          events.push({
            type: 'TEAM_CHANGED',
            data: { fromTeamId: ticket.teamId, toTeamId: input.teamId },
          });
        }

        let addedTagIds: string[] = [];
        let removedTagIds: string[] = [];
        if (input.tagIds !== undefined) {
          const current = new Set(ticket.tags.map((t) => t.tagId));
          const next = new Set(input.tagIds);
          addedTagIds = input.tagIds.filter((id) => !current.has(id));
          removedTagIds = [...current].filter((id) => !next.has(id));
          if (addedTagIds.length > 0 || removedTagIds.length > 0) {
            events.push({ type: 'TAGS_CHANGED', data: { addedTagIds, removedTagIds } });
          }
        }

        // A request that changes nothing writes nothing — not even updatedAt.
        if (events.length === 0) return number;
        await scope.updateTicket(ticket.id, { ...changes, updatedAt: now });
        await scope.changeTags(ticket.id, addedTagIds, removedTagIds);
        await scope.addEvents(ticket.id, tenant.userId, now, events);
        return number;
      });
    },

    addMessage(
      tenant: TenantContext,
      number: number,
      input: CreateMessageRequest,
    ): Promise<number> {
      return repository.write(tenant.organizationId, async (scope) => {
        const ticket = await lockOpenTicket(scope, number);
        const now = clock.now();
        const message = await scope.createMessage({
          ticketId: ticket.id,
          authorType: 'AGENT',
          authorUserId: tenant.userId,
          visibility: input.visibility,
          body: input.body,
          createdAt: now,
        });
        // The first public agent reply meets the first-response target; notes never do.
        // The row lock makes "first" exact even when replies arrive at the same moment.
        const firstResponse = input.visibility === 'PUBLIC' && ticket.firstRespondedAt === null;
        await scope.updateTicket(ticket.id, {
          updatedAt: now,
          ...(firstResponse && { firstRespondedAt: now }),
        });
        await scope.addEvents(ticket.id, tenant.userId, now, [
          { type: 'MESSAGE_ADDED', data: { messageId: message.id, visibility: input.visibility } },
        ]);
        return number;
      });
    },
  };
}
