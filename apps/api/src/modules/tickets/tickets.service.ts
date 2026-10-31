import {
  encodeTicketCursor,
  evaluateSla,
  type CreateMessageRequest,
  type CreateTicketInput,
  type UpdateTicketInput,
  type ConversationMessage,
  type InternalNote,
  type MessageAuthor,
  type TicketDetailResponse,
  type TicketListQuery,
  type TicketListResponse,
  type TicketSummary,
  type TimelineEvent,
  type TimelineRef,
} from '@pulsedesk/shared';
import type { TenantContext } from '../../http/auth-context.ts';
import { NotFoundError } from '../../http/errors.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../lib/logger.ts';
import { createTicketWrites } from './ticket-writes.ts';
import { parseStoredEvent, type StoredEvent } from './ticket-event-data.ts';
import type {
  ResolvedReferences,
  TicketDetailRow,
  TicketFilters,
  TicketSummaryRow,
  TicketsRepository,
} from './tickets.repository.ts';

const iso = (date: Date | null) => date?.toISOString() ?? null;

/**
 * The response shape of one ticket. `sla` is evaluated at `now` (the caller's injected
 * clock) with the same function the breach sweep uses, so both agree at any moment.
 */
export function toSummary(row: TicketSummaryRow, now: Date): TicketSummary {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    channel: row.channel,
    customer: row.customer,
    assignee: row.assignee && { userId: row.assignee.userId, name: row.assignee.user.name },
    team: row.team,
    tags: row.tags.map(({ tag }) => tag),
    firstResponseDueAt: iso(row.firstResponseDueAt),
    resolutionDueAt: iso(row.resolutionDueAt),
    firstRespondedAt: iso(row.firstRespondedAt),
    solvedAt: iso(row.solvedAt),
    closedAt: iso(row.closedAt),
    firstResponseBreachedAt: iso(row.firstResponseBreachedAt),
    resolutionBreachedAt: iso(row.resolutionBreachedAt),
    sla: evaluateSla(row, now),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type MessageRow = TicketDetailRow['messages'][number];

function authorOf(message: MessageRow): MessageAuthor {
  switch (message.authorType) {
    case 'AGENT':
      return {
        type: 'AGENT',
        userId: message.authorUser?.id ?? null,
        name: message.authorUser?.name ?? null,
      };
    case 'CUSTOMER':
      // Message_author_check guarantees a customer on customer-authored messages.
      if (!message.authorCustomer) throw new Error(`Message ${message.id} has no customer`);
      return {
        type: 'CUSTOMER',
        customerId: message.authorCustomer.id,
        name: message.authorCustomer.name,
        email: message.authorCustomer.email,
      };
    case 'SYSTEM':
      return { type: 'SYSTEM' };
  }
}

function messageFields(message: MessageRow) {
  return {
    id: message.id,
    author: authorOf(message),
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    editedAt: iso(message.editedAt),
  };
}

/** Splits messages by visibility; internal notes never enter the conversation list. */
function splitMessages(messages: MessageRow[]) {
  const conversation: ConversationMessage[] = [];
  const internalNotes: InternalNote[] = [];
  for (const message of messages) {
    if (message.visibility === 'PUBLIC') {
      conversation.push({ ...messageFields(message), visibility: 'PUBLIC' });
    } else {
      internalNotes.push({ ...messageFields(message), visibility: 'INTERNAL' });
    }
  }
  return { conversation, internalNotes };
}

function referencedIds(events: StoredEvent[]) {
  const userIds = new Set<string>();
  const teamIds = new Set<string>();
  const tagIds = new Set<string>();
  const add = (set: Set<string>, id: string | null) => {
    if (id !== null) set.add(id);
  };
  for (const event of events) {
    if (event.type === 'ASSIGNED') {
      add(userIds, event.data.fromUserId);
      add(userIds, event.data.toUserId);
    } else if (event.type === 'TEAM_CHANGED') {
      add(teamIds, event.data.fromTeamId);
      add(teamIds, event.data.toTeamId);
    } else if (event.type === 'TAGS_CHANGED') {
      for (const id of [...event.data.addedTagIds, ...event.data.removedTagIds]) tagIds.add(id);
    }
  }
  return { userIds: [...userIds], teamIds: [...teamIds], tagIds: [...tagIds] };
}

function resolvedData(event: StoredEvent, refs: ResolvedReferences): TimelineEvent['data'] {
  const ref = (names: Map<string, string>, id: string): TimelineRef => ({
    id,
    name: names.get(id) ?? null,
  });
  const optionalRef = (names: Map<string, string>, id: string | null) =>
    id === null ? null : ref(names, id);

  switch (event.type) {
    case 'ASSIGNED':
      return {
        from: optionalRef(refs.users, event.data.fromUserId),
        to: optionalRef(refs.users, event.data.toUserId),
      };
    case 'TEAM_CHANGED':
      return {
        from: optionalRef(refs.teams, event.data.fromTeamId),
        to: optionalRef(refs.teams, event.data.toTeamId),
      };
    case 'TAGS_CHANGED':
      return {
        added: event.data.addedTagIds.map((id) => ref(refs.tags, id)),
        removed: event.data.removedTagIds.map((id) => ref(refs.tags, id)),
      };
    default:
      return event.data;
  }
}

export function createTicketsService({
  repository,
  logger,
  clock,
}: {
  repository: TicketsRepository;
  logger: Logger;
  clock: Clock;
}) {
  const writes = createTicketWrites({ repository, clock });

  async function timelineOf(tenant: TenantContext, ticket: TicketDetailRow) {
    const stored: { row: TicketDetailRow['events'][number]; event: StoredEvent }[] = [];
    for (const row of ticket.events) {
      const event = parseStoredEvent(row.type, row.data);
      if (event) {
        stored.push({ row, event });
      } else {
        // Never echo unvalidated JSON to clients; the event is left out of the timeline.
        logger.warn(
          { organizationId: tenant.organizationId, ticketEventId: row.id, type: row.type },
          'Skipped a ticket event with invalid data',
        );
      }
    }

    const refs = await repository.resolveReferences(
      tenant.organizationId,
      referencedIds(stored.map((s) => s.event)),
    );
    return stored.map(
      ({ row, event }) =>
        // resolvedData returns the data shape that belongs to `event.type`.
        ({
          id: row.id,
          type: event.type,
          createdAt: row.createdAt.toISOString(),
          actorType: row.actorType,
          actor: row.actor,
          data: resolvedData(event, refs),
        }) as TimelineEvent,
    );
  }

  /**
   * A ticket by its per-organization number. Another organization's ticket with the same
   * number is simply not found (404), exactly like a number that was never issued.
   */
  async function get(tenant: TenantContext, number: number): Promise<TicketDetailResponse> {
    const ticket = await repository.findByNumber(tenant.organizationId, number);
    if (!ticket) throw new NotFoundError('Ticket');
    return {
      ticket: toSummary(ticket, clock.now()),
      ...splitMessages(ticket.messages),
      timeline: await timelineOf(tenant, ticket),
    };
  }

  return {
    async list(tenant: TenantContext, query: TicketListQuery): Promise<TicketListResponse> {
      const filters: TicketFilters = {
        status: query.status,
        priority: query.priority,
        assignee:
          query.assignee === undefined || query.assignee === 'unassigned'
            ? query.assignee
            : { userId: query.assignee === 'me' ? tenant.userId : query.assignee },
        team:
          query.team === undefined || query.team === 'none' ? query.team : { teamId: query.team },
        tagId: query.tag,
        customerId: query.customer,
      };
      // One extra row tells whether another page exists without a separate count query.
      const rows = await repository.list(tenant.organizationId, filters, {
        sort: query.sort,
        cursor: query.cursor,
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? encodeTicketCursor({
              sort: query.sort,
              at: (query.sort === 'updated' ? last.updatedAt : last.createdAt).toISOString(),
              number: last.number,
            })
          : null;
      const now = clock.now();
      return { data: page.map((row) => toSummary(row, now)), nextCursor };
    },

    get,

    // Mutations return the updated resource: the ticket as it is after the commit.

    async create(tenant: TenantContext, input: CreateTicketInput): Promise<TicketDetailResponse> {
      return get(tenant, await writes.create(tenant, input));
    },

    async update(
      tenant: TenantContext,
      number: number,
      input: UpdateTicketInput,
    ): Promise<TicketDetailResponse> {
      return get(tenant, await writes.update(tenant, number, input));
    },

    async addMessage(
      tenant: TenantContext,
      number: number,
      input: CreateMessageRequest,
    ): Promise<TicketDetailResponse> {
      return get(tenant, await writes.addMessage(tenant, number, input));
    },
  };
}

export type TicketsService = ReturnType<typeof createTicketsService>;
