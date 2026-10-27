import type {
  Database,
  MessageAuthorType,
  MessageVisibility,
  Prisma,
  TicketChannel,
  TicketPriority,
  TicketStatus,
  TransactionClient,
} from '@pulsedesk/db';
import type { TicketCursor, TicketSort } from '@pulsedesk/shared';
import { literalContains } from '../../lib/like.ts';
import { withTransactionRetry } from '../../lib/transactions.ts';
import type { StoredEvent } from './ticket-event-data.ts';

const ticketSummarySelect = {
  id: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  channel: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  firstRespondedAt: true,
  solvedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  // Customer, assignee, team and tags are joined through composite (organizationId, id)
  // foreign keys, so they always belong to the ticket's own organization.
  customer: { select: { id: true, name: true, email: true } },
  assignee: { select: { userId: true, user: { select: { name: true } } } },
  team: { select: { id: true, name: true } },
  tags: {
    select: { tag: { select: { id: true, name: true, color: true } } },
    orderBy: { tag: { name: 'asc' } },
  },
} as const satisfies Prisma.TicketSelect;

export type TicketSummaryRow = Prisma.TicketGetPayload<{ select: typeof ticketSummarySelect }>;

const ticketDetailSelect = {
  ...ticketSummarySelect,
  messages: {
    select: {
      id: true,
      authorType: true,
      visibility: true,
      body: true,
      createdAt: true,
      editedAt: true,
      authorUser: { select: { id: true, name: true } },
      authorCustomer: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  events: {
    select: {
      id: true,
      type: true,
      data: true,
      createdAt: true,
      actor: { select: { id: true, name: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.TicketSelect;

export type TicketDetailRow = Prisma.TicketGetPayload<{ select: typeof ticketDetailSelect }>;

/** Filters after the service has resolved `assignee=me` to a user ID. */
export type TicketFilters = {
  status?: TicketStatus[] | undefined;
  priority?: TicketPriority[] | undefined;
  assignee?: { userId: string } | 'unassigned' | undefined;
  team?: { teamId: string } | 'none' | undefined;
  tagId?: string | undefined;
  customerId?: string | undefined;
};

export type TicketPage = { sort: TicketSort; cursor: TicketCursor | undefined; take: number };

const SORT_FIELD = { newest: 'createdAt', oldest: 'createdAt', updated: 'updatedAt' } as const;

/**
 * Keyset ordering: the sort timestamp, then the ticket number, which is unique within an
 * organization — so the order is total and a page boundary is never ambiguous.
 */
export function orderFor(sort: TicketSort): Prisma.TicketOrderByWithRelationInput[] {
  const direction = sort === 'oldest' ? 'asc' : 'desc';
  return [{ [SORT_FIELD[sort]]: direction }, { number: direction }];
}

/** Rows strictly after the cursor's position in `sort` order. */
export function afterCursor(cursor: TicketCursor): Prisma.TicketWhereInput {
  const field = SORT_FIELD[cursor.sort];
  const beyond = cursor.sort === 'oldest' ? 'gt' : 'lt';
  const at = new Date(cursor.at);
  return {
    OR: [{ [field]: { [beyond]: at } }, { [field]: at, number: { [beyond]: cursor.number } }],
  };
}

function filterConditions(filters: TicketFilters): Prisma.TicketWhereInput[] {
  const conditions: Prisma.TicketWhereInput[] = [];
  if (filters.status) conditions.push({ status: { in: filters.status } });
  if (filters.priority) conditions.push({ priority: { in: filters.priority } });
  if (filters.assignee === 'unassigned') conditions.push({ assigneeUserId: null });
  else if (filters.assignee) conditions.push({ assigneeUserId: filters.assignee.userId });
  if (filters.team === 'none') conditions.push({ teamId: null });
  else if (filters.team) conditions.push({ teamId: filters.team.teamId });
  if (filters.tagId) conditions.push({ tags: { some: { tagId: filters.tagId } } });
  if (filters.customerId) conditions.push({ customerId: filters.customerId });
  return conditions;
}

/** The fields a ticket write reads, under a row lock. */
const lockedTicketSelect = {
  id: true,
  number: true,
  status: true,
  priority: true,
  assigneeUserId: true,
  teamId: true,
  slaPolicyId: true,
  createdAt: true,
  firstRespondedAt: true,
  solvedAt: true,
  closedAt: true,
  tags: { select: { tagId: true } },
} as const satisfies Prisma.TicketSelect;

export type LockedTicket = Prisma.TicketGetPayload<{ select: typeof lockedTicketSelect }>;

export type SlaTarget = {
  slaPolicyId: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
};

export type NewTicket = {
  number: number;
  subject: string;
  priority: TicketPriority;
  channel: TicketChannel;
  customerId: string;
  assigneeUserId: string | null;
  teamId: string | null;
  slaPolicyId: string | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  createdAt: Date;
};

export type TicketChanges = Partial<{
  status: TicketStatus;
  priority: TicketPriority;
  assigneeUserId: string | null;
  teamId: string | null;
  firstRespondedAt: Date;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  solvedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
}>;

export type NewMessage = {
  ticketId: string;
  authorType: MessageAuthorType;
  authorUserId?: string;
  authorCustomerId?: string;
  visibility: MessageVisibility;
  body: string;
  createdAt: Date;
};

/**
 * Writes inside one transaction, every query pinned to one organization. A service makes
 * all of a mutation's changes — ticket, tags, messages and timeline events — through one
 * scope, so they commit or roll back together.
 */
function writeScope(tx: TransactionClient, organizationId: string) {
  async function slaTarget(
    slaPolicyId: string,
    priority: TicketPriority,
  ): Promise<SlaTarget | null> {
    const target = await tx.slaTarget.findFirst({
      where: { organizationId, slaPolicyId, priority },
      select: { firstResponseMinutes: true, resolutionMinutes: true },
    });
    return target && { slaPolicyId, ...target };
  }

  return {
    /**
     * Next per-organization ticket number. The increment locks the organization row until
     * the transaction ends, so concurrent creations get distinct, gap-free numbers.
     */
    async nextTicketNumber(): Promise<number> {
      const organization = await tx.organization.update({
        where: { id: organizationId },
        data: { ticketSequence: { increment: 1 } },
        select: { ticketSequence: true },
      });
      return organization.ticketSequence;
    },

    /**
     * The customer with this (normalized) email, created if new; an existing customer's
     * name is never overwritten. The insert is ON CONFLICT DO NOTHING, which waits for a
     * concurrent insert of the same email to finish, so simultaneous tickets for one new
     * email produce a single customer. (Prisma's `upsert` isn't a native upsert here and
     * fails such races with a unique violation.)
     */
    async upsertCustomer(email: string, name: string | undefined): Promise<{ id: string }> {
      await tx.customer.createMany({
        data: [{ organizationId, email, name: name ?? null }],
        skipDuplicates: true,
      });
      return tx.customer.findUniqueOrThrow({
        where: { organizationId_email: { organizationId, email } },
        select: { id: true },
      });
    },

    async defaultSlaTarget(priority: TicketPriority): Promise<SlaTarget | null> {
      const policy = await tx.slaPolicy.findFirst({
        where: { organizationId, isDefault: true },
        select: { id: true },
      });
      return policy ? slaTarget(policy.id, priority) : null;
    },

    slaTarget,

    /**
     * Which of these IDs exist in this organization (members by user ID), locking each
     * found row FOR KEY SHARE until the transaction ends. A concurrent delete of the team or
     * tag, or removal of the member, needs a stronger lock on that row, so it waits for this
     * write to commit — and then sees (and unassigns) the reference it made. If the delete
     * got there first, the row is gone and validation fails as for any unknown ID.
     *
     * Call this before locking the ticket row: the deleters lock their row first and the
     * tickets second, and both sides must take locks in that order (no deadlock).
     */
    async existingReferences(ids: { userIds: string[]; teamIds: string[]; tagIds: string[] }) {
      const sorted = (values: string[]) => [...new Set(values)].sort();
      const userIds = sorted(ids.userIds);
      const teamIds = sorted(ids.teamIds);
      const tagIds = sorted(ids.tagIds);
      // One table at a time, rows in ID order: a stable locking order across writers.
      const members =
        userIds.length === 0
          ? []
          : await tx.$queryRaw<{ userId: string }[]>`
              SELECT "userId" FROM "Membership"
              WHERE "organizationId" = ${organizationId}::uuid AND "userId" = ANY(${userIds}::uuid[])
              ORDER BY "userId" FOR KEY SHARE`;
      const teams =
        teamIds.length === 0
          ? []
          : await tx.$queryRaw<{ id: string }[]>`
              SELECT "id" FROM "Team"
              WHERE "organizationId" = ${organizationId}::uuid AND "id" = ANY(${teamIds}::uuid[])
              ORDER BY "id" FOR KEY SHARE`;
      const tags =
        tagIds.length === 0
          ? []
          : await tx.$queryRaw<{ id: string }[]>`
              SELECT "id" FROM "Tag"
              WHERE "organizationId" = ${organizationId}::uuid AND "id" = ANY(${tagIds}::uuid[])
              ORDER BY "id" FOR KEY SHARE`;
      return {
        userIds: new Set(members.map((m) => m.userId)),
        teamIds: new Set(teams.map((t) => t.id)),
        tagIds: new Set(tags.map((t) => t.id)),
      };
    },

    createTicket(ticket: NewTicket): Promise<{ id: string }> {
      return tx.ticket.create({
        data: { organizationId, ...ticket, updatedAt: ticket.createdAt },
        select: { id: true },
      });
    },

    /**
     * Locks the ticket row for the rest of the transaction and reads its current state, so
     * concurrent writes to one ticket apply one after another, each against fresh values.
     */
    async lockTicket(number: number): Promise<LockedTicket | null> {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Ticket"
        WHERE "organizationId" = ${organizationId}::uuid AND "number" = ${number}
        FOR UPDATE`;
      if (locked.length === 0) return null;
      return tx.ticket.findUnique({
        where: { organizationId_number: { organizationId, number } },
        select: lockedTicketSelect,
      });
    },

    async updateTicket(ticketId: string, changes: TicketChanges): Promise<void> {
      await tx.ticket.update({
        where: { organizationId_id: { organizationId, id: ticketId } },
        data: changes,
      });
    },

    async changeTags(ticketId: string, added: string[], removed: string[]): Promise<void> {
      if (removed.length > 0) {
        await tx.ticketTag.deleteMany({
          where: { organizationId, ticketId, tagId: { in: removed } },
        });
      }
      if (added.length > 0) {
        await tx.ticketTag.createMany({
          data: added.map((tagId) => ({ organizationId, ticketId, tagId })),
        });
      }
    },

    createMessage(message: NewMessage): Promise<{ id: string }> {
      return tx.message.create({ data: { organizationId, ...message }, select: { id: true } });
    },

    /**
     * Appends one mutation's timeline events. They are stamped 1 ms apart from `createdAt`
     * so the timeline (ordered by time) keeps them in the order they were recorded.
     */
    async addEvents(
      ticketId: string,
      actorUserId: string,
      createdAt: Date,
      events: StoredEvent[],
    ): Promise<void> {
      if (events.length === 0) return;
      await tx.ticketEvent.createMany({
        data: events.map((event, index) => ({
          organizationId,
          ticketId,
          actorUserId,
          type: event.type,
          data: event.data,
          createdAt: new Date(createdAt.getTime() + index),
        })),
      });
    },
  };
}

export type TicketWriteScope = ReturnType<typeof writeScope>;

/** Every query is pinned to the caller's organization; IDs from elsewhere simply match nothing. */
export function createTicketsRepository(db: Database) {
  return {
    /**
     * Runs `fn` in one transaction; everything it writes commits or rolls back together. A
     * transaction aborted by a deadlock or a raced foreign key is re-run from scratch.
     */
    write<T>(organizationId: string, fn: (scope: TicketWriteScope) => Promise<T>): Promise<T> {
      return withTransactionRetry(() =>
        db.$transaction((tx) => fn(writeScope(tx, organizationId))),
      );
    },

    list(
      organizationId: string,
      filters: TicketFilters,
      page: TicketPage,
    ): Promise<TicketSummaryRow[]> {
      const conditions = filterConditions(filters);
      if (page.cursor) conditions.push(afterCursor(page.cursor));
      return db.ticket.findMany({
        where: { organizationId, AND: conditions },
        select: ticketSummarySelect,
        orderBy: orderFor(page.sort),
        take: page.take,
      });
    },

    /**
     * Tickets matching typed text: the ticket with that number (if the text is one), then
     * subject matches, most recently updated first. `text` is matched literally.
     */
    async search(
      organizationId: string,
      text: string,
      number: number | null,
      limit: number,
    ): Promise<TicketSummaryRow[]> {
      const [byNumber, bySubject] = await Promise.all([
        number === null
          ? null
          : db.ticket.findUnique({
              where: { organizationId_number: { organizationId, number } },
              select: ticketSummarySelect,
            }),
        db.ticket.findMany({
          where: {
            organizationId,
            subject: { contains: literalContains(text), mode: 'insensitive' },
          },
          select: ticketSummarySelect,
          orderBy: [{ updatedAt: 'desc' }, { number: 'desc' }],
          take: limit,
        }),
      ]);
      const rest = bySubject.filter((row) => row.id !== byNumber?.id);
      return (byNumber ? [byNumber, ...rest] : rest).slice(0, limit);
    },

    findByNumber(organizationId: string, number: number): Promise<TicketDetailRow | null> {
      return db.ticket.findUnique({
        where: { organizationId_number: { organizationId, number } },
        select: ticketDetailSelect,
      });
    },

    /**
     * Names for IDs found in event data, which has no foreign keys. Each lookup is scoped
     * to the organization, so an ID from another tenant resolves to nothing.
     */
    async resolveReferences(
      organizationId: string,
      ids: { userIds: string[]; teamIds: string[]; tagIds: string[] },
    ) {
      const [members, teams, tags] = await Promise.all([
        ids.userIds.length === 0
          ? []
          : db.membership.findMany({
              where: { organizationId, userId: { in: ids.userIds } },
              select: { userId: true, user: { select: { name: true } } },
            }),
        ids.teamIds.length === 0
          ? []
          : db.team.findMany({
              where: { organizationId, id: { in: ids.teamIds } },
              select: { id: true, name: true },
            }),
        ids.tagIds.length === 0
          ? []
          : db.tag.findMany({
              where: { organizationId, id: { in: ids.tagIds } },
              select: { id: true, name: true },
            }),
      ]);
      return {
        users: new Map(members.map((m) => [m.userId, m.user.name])),
        teams: new Map(teams.map((t) => [t.id, t.name])),
        tags: new Map(tags.map((t) => [t.id, t.name])),
      };
    },
  };
}

export type TicketsRepository = ReturnType<typeof createTicketsRepository>;
export type ResolvedReferences = Awaited<ReturnType<TicketsRepository['resolveReferences']>>;
