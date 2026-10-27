import { prismaErrorCode, type Database, type Prisma, type TransactionClient } from '@pulsedesk/db';
import { withTransactionRetry } from '../../lib/transactions.ts';
import type { StoredEvent } from '../tickets/ticket-event-data.ts';

const teamSelect = {
  id: true,
  name: true,
  members: {
    select: { userId: true, membership: { select: { user: { select: { name: true } } } } },
    orderBy: { membership: { user: { name: 'asc' } } },
  },
} as const;

export type TeamRow = {
  id: string;
  name: string;
  members: { userId: string; membership: { user: { name: string } } }[];
};

export type AuditEntry = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

/** The team name is taken in this organization (compared case-insensitively). */
export class TeamNameTakenError extends Error {}

/** Team writes, pinned to one organization, inside a transaction holding its row lock. */
function scopedTo(tx: TransactionClient, organizationId: string, audit: AuditEntry) {
  async function log(action: string, teamId: string, metadata: Prisma.InputJsonObject) {
    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: audit.actorUserId,
        action,
        targetType: 'Team',
        targetId: teamId,
        metadata,
        ipAddress: audit.ipAddress ?? null,
        requestId: audit.requestId,
      },
    });
  }

  return {
    /**
     * The team, optionally locking its row first: `update` before renaming or deleting it
     * (ticket writers referencing it then wait, or wait for us), `key share` before adding
     * members (it can't be deleted underneath). Without a lock, a plain read.
     */
    async find(teamId: string, lock?: 'update' | 'key share'): Promise<TeamRow | null> {
      if (lock) {
        const locked =
          lock === 'update'
            ? await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "Team"
                WHERE "organizationId" = ${organizationId}::uuid AND "id" = ${teamId}::uuid
                FOR UPDATE`
            : await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "Team"
                WHERE "organizationId" = ${organizationId}::uuid AND "id" = ${teamId}::uuid
                FOR KEY SHARE`;
        if (locked.length === 0) return null;
      }
      return tx.team.findUnique({
        where: { organizationId_id: { organizationId, id: teamId } },
        select: teamSelect,
      });
    },

    /** Unique names regardless of case; the per-organization team lock makes this race-free. */
    async assertNameFree(name: string, exceptTeamId?: string): Promise<void> {
      const clash = await tx.team.findFirst({
        where: {
          organizationId,
          name: { equals: name, mode: 'insensitive' },
          ...(exceptTeamId && { id: { not: exceptTeamId } }),
        },
        select: { id: true },
      });
      if (clash) throw new TeamNameTakenError();
    },

    async create(name: string): Promise<TeamRow> {
      const team = await tx.team.create({ data: { organizationId, name }, select: teamSelect });
      await log('team.created', team.id, { name });
      return team;
    },

    async rename(team: TeamRow, name: string): Promise<TeamRow> {
      const renamed = await tx.team.update({
        where: { organizationId_id: { organizationId, id: team.id } },
        data: { name },
        select: teamSelect,
      });
      await log('team.renamed', team.id, { name: { from: team.name, to: name } });
      return renamed;
    },

    /** Whether the user is a member here, locking that membership against removal meanwhile. */
    async isMember(userId: string): Promise<boolean> {
      const rows = await tx.$queryRaw<{ userId: string }[]>`
        SELECT "userId" FROM "Membership"
        WHERE "organizationId" = ${organizationId}::uuid AND "userId" = ${userId}::uuid
        FOR KEY SHARE`;
      return rows.length > 0;
    },

    async addMember(teamId: string, userId: string): Promise<void> {
      const { count } = await tx.teamMember.createMany({
        data: [{ organizationId, teamId, userId }],
        skipDuplicates: true,
      });
      if (count > 0) await log('team.member_added', teamId, { userId });
    },

    async removeMember(teamId: string, userId: string): Promise<void> {
      const { count } = await tx.teamMember.deleteMany({
        where: { organizationId, teamId, userId },
      });
      if (count > 0) await log('team.member_removed', teamId, { userId });
    },

    /**
     * Ticket → Team is a NO ACTION foreign key, so the team's tickets are unassigned first;
     * each gets a TEAM_CHANGED event, so its timeline explains where the team went. The
     * caller must have loaded `team` with `find(id, 'update')`: with the row locked, no
     * ticket write can add a reference between collecting the tickets and the delete.
     */
    async delete(team: TeamRow, at: Date): Promise<void> {
      const tickets = await tx.ticket.findMany({
        where: { organizationId, teamId: team.id },
        select: { id: true },
      });
      if (tickets.length > 0) {
        const ids = tickets.map((t) => t.id);
        await tx.ticket.updateMany({
          where: { organizationId, id: { in: ids } },
          data: { teamId: null, updatedAt: at },
        });
        const event: StoredEvent = {
          type: 'TEAM_CHANGED',
          data: { fromTeamId: team.id, toTeamId: null },
        };
        await tx.ticketEvent.createMany({
          data: ids.map((ticketId) => ({
            organizationId,
            ticketId,
            actorUserId: audit.actorUserId,
            type: event.type,
            data: event.data,
            createdAt: at,
          })),
        });
      }
      await tx.team.delete({ where: { organizationId_id: { organizationId, id: team.id } } });
      await log('team.deleted', team.id, { name: team.name, ticketCount: tickets.length });
    },
  };
}

export type ScopedTeamsRepository = ReturnType<typeof scopedTo>;

export function createTeamsRepository(db: Database) {
  return {
    list(organizationId: string): Promise<TeamRow[]> {
      return db.team.findMany({
        where: { organizationId },
        select: teamSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
    },

    /**
     * Runs `fn` in a transaction holding this organization's team lock (a transaction-scoped
     * advisory lock), so team writes in one organization are serialized — no two teams can
     * win the same name at once. Ticket writes never take this lock, so it can't deadlock
     * with them; it replaces the Organization row lock, which ticket creation also takes.
     */
    async serialized<T>(
      organizationId: string,
      audit: AuditEntry,
      fn: (teams: ScopedTeamsRepository) => Promise<T>,
    ): Promise<T> {
      try {
        return await withTransactionRetry(() =>
          db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`teams:${organizationId}`}, 0))`;
            return fn(scopedTo(tx, organizationId, audit));
          }),
        );
      } catch (error) {
        // The (organizationId, name) unique index as a backstop for the check above.
        if (prismaErrorCode(error) === 'P2002') throw new TeamNameTakenError();
        throw error;
      }
    },
  };
}

export type TeamsRepository = ReturnType<typeof createTeamsRepository>;
