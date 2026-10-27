import { prismaErrorCode, type Database, type Prisma, type TransactionClient } from '@pulsedesk/db';
import { withTransactionRetry } from '../../lib/transactions.ts';
import type { StoredEvent } from '../tickets/ticket-event-data.ts';

// The ticket count comes from the same query (a relation count), never one query per tag.
const tagSelect = {
  id: true,
  name: true,
  color: true,
  _count: { select: { tickets: true } },
} as const satisfies Prisma.TagSelect;

export type TagRow = Prisma.TagGetPayload<{ select: typeof tagSelect }>;

export type AuditEntry = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

/** The tag name is taken in this organization (compared case-insensitively). */
export class TagNameTakenError extends Error {}

/** Tag writes, pinned to one organization, inside a transaction holding its row lock. */
function scopedTo(tx: TransactionClient, organizationId: string, audit: AuditEntry) {
  async function log(action: string, tagId: string, metadata: Prisma.InputJsonObject) {
    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: audit.actorUserId,
        action,
        targetType: 'Tag',
        targetId: tagId,
        metadata,
        ipAddress: audit.ipAddress ?? null,
        requestId: audit.requestId,
      },
    });
  }

  return {
    /**
     * The tag, with its row locked FOR UPDATE first. Ticket writes lock the tags they assign
     * FOR KEY SHARE, so a rename or delete waits for them to commit (or they wait for it),
     * and a delete always sees every ticket that carries the tag.
     */
    async find(tagId: string): Promise<TagRow | null> {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Tag"
        WHERE "organizationId" = ${organizationId}::uuid AND "id" = ${tagId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) return null;
      return tx.tag.findUnique({
        where: { organizationId_id: { organizationId, id: tagId } },
        select: tagSelect,
      });
    },

    /** Unique names regardless of case; the per-organization tag lock makes this race-free. */
    async assertNameFree(name: string, exceptTagId?: string): Promise<void> {
      const clash = await tx.tag.findFirst({
        where: {
          organizationId,
          name: { equals: name, mode: 'insensitive' },
          ...(exceptTagId && { id: { not: exceptTagId } }),
        },
        select: { id: true },
      });
      if (clash) throw new TagNameTakenError();
    },

    async create(name: string, color: string | null): Promise<TagRow> {
      const tag = await tx.tag.create({ data: { organizationId, name, color }, select: tagSelect });
      await log('tag.created', tag.id, { name, color });
      return tag;
    },

    /** Applies the changes; one that changes nothing writes nothing (no audit entry). */
    async update(
      tag: TagRow,
      changes: { name?: string | undefined; color?: string | null | undefined },
    ): Promise<TagRow> {
      const unchanged =
        (changes.name === undefined || changes.name === tag.name) &&
        (changes.color === undefined || changes.color === tag.color);
      if (unchanged) return tag;
      const updated = await tx.tag.update({
        where: { organizationId_id: { organizationId, id: tag.id } },
        data: {
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.color !== undefined && { color: changes.color }),
        },
        select: tagSelect,
      });
      await log('tag.updated', tag.id, {
        name: { from: tag.name, to: updated.name },
        color: { from: tag.color, to: updated.color },
      });
      return updated;
    },

    /**
     * Deleting a tag removes it from every ticket (TicketTag cascades). Each affected ticket
     * gets a TAGS_CHANGED event first, so its timeline still shows the tag went away. `tag`
     * must come from `find` (row locked): otherwise a link added concurrently would be
     * removed by the cascade without its event.
     */
    async delete(tag: TagRow, at: Date): Promise<void> {
      const links = await tx.ticketTag.findMany({
        where: { organizationId, tagId: tag.id },
        select: { ticketId: true },
      });
      const ticketIds = links.map((link) => link.ticketId);
      if (ticketIds.length > 0) {
        await tx.ticket.updateMany({
          where: { organizationId, id: { in: ticketIds } },
          data: { updatedAt: at },
        });
        const event: StoredEvent = {
          type: 'TAGS_CHANGED',
          data: { addedTagIds: [], removedTagIds: [tag.id] },
        };
        await tx.ticketEvent.createMany({
          data: ticketIds.map((ticketId) => ({
            organizationId,
            ticketId,
            actorUserId: audit.actorUserId,
            type: event.type,
            data: event.data,
            createdAt: at,
          })),
        });
      }
      await tx.tag.delete({ where: { organizationId_id: { organizationId, id: tag.id } } });
      await log('tag.deleted', tag.id, { name: tag.name, ticketCount: ticketIds.length });
    },
  };
}

export type ScopedTagsRepository = ReturnType<typeof scopedTo>;

export function createTagsRepository(db: Database) {
  return {
    list(organizationId: string): Promise<TagRow[]> {
      return db.tag.findMany({
        where: { organizationId },
        select: tagSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
    },

    /**
     * Runs `fn` in a transaction holding this organization's tag lock (a transaction-scoped
     * advisory lock): tag writes in one organization are serialized, so no two tags can win
     * the same name at once. Ticket writes never take this lock, so it can't deadlock with them.
     */
    async serialized<T>(
      organizationId: string,
      audit: AuditEntry,
      fn: (tags: ScopedTagsRepository) => Promise<T>,
    ): Promise<T> {
      try {
        return await withTransactionRetry(() =>
          db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tags:${organizationId}`}, 0))`;
            return fn(scopedTo(tx, organizationId, audit));
          }),
        );
      } catch (error) {
        // The (organizationId, name) unique index as a backstop for the check above.
        if (prismaErrorCode(error) === 'P2002') throw new TagNameTakenError();
        throw error;
      }
    },
  };
}

export type TagsRepository = ReturnType<typeof createTagsRepository>;
