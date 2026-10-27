import type { Team } from '@pulsedesk/shared';
import type { RequestMeta, TenantContext } from '../../http/auth-context.ts';
import { ConflictError, NotFoundError } from '../../http/errors.ts';
import type { Clock } from '../../lib/clock.ts';
import {
  TeamNameTakenError,
  type ScopedTeamsRepository,
  type TeamRow,
  type TeamsRepository,
} from './teams.repository.ts';

function toDto(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    members: row.members.map((m) => ({ userId: m.userId, name: m.membership.user.name })),
  };
}

/**
 * Teams of the active organization. Reading is open to everyone who works tickets; every
 * change needs `team:manage` (checked on the route, against the role read on this
 * request). A team or user ID from another organization is not found (404), exactly like
 * one that never existed, and nothing outside the active organization is ever written.
 */
export function createTeamsService({
  repository,
  clock,
}: {
  repository: TeamsRepository;
  clock: Clock;
}) {
  async function write<T>(
    tenant: TenantContext,
    meta: RequestMeta,
    fn: (teams: ScopedTeamsRepository) => Promise<T>,
  ): Promise<T> {
    try {
      return await repository.serialized(
        tenant.organizationId,
        { actorUserId: tenant.userId, ipAddress: meta.ipAddress, requestId: tenant.requestId },
        fn,
      );
    } catch (error) {
      if (error instanceof TeamNameTakenError) {
        throw new ConflictError('A team with this name already exists in this organization.');
      }
      throw error;
    }
  }

  async function existing(
    teams: ScopedTeamsRepository,
    teamId: string,
    lock: 'update' | 'key share',
  ): Promise<TeamRow> {
    const team = await teams.find(teamId, lock);
    if (!team) throw new NotFoundError('Team');
    return team;
  }

  return {
    async list(tenant: TenantContext): Promise<Team[]> {
      return (await repository.list(tenant.organizationId)).map(toDto);
    },

    create(tenant: TenantContext, name: string, meta: RequestMeta): Promise<Team> {
      return write(tenant, meta, async (teams) => {
        await teams.assertNameFree(name);
        return toDto(await teams.create(name));
      });
    },

    rename(tenant: TenantContext, teamId: string, name: string, meta: RequestMeta): Promise<Team> {
      return write(tenant, meta, async (teams) => {
        const team = await existing(teams, teamId, 'update');
        if (team.name === name) return toDto(team);
        await teams.assertNameFree(name, team.id);
        return toDto(await teams.rename(team, name));
      });
    },

    remove(tenant: TenantContext, teamId: string, meta: RequestMeta): Promise<void> {
      return write(tenant, meta, async (teams) => {
        await teams.delete(await existing(teams, teamId, 'update'), clock.now());
      });
    },

    /** Idempotent: adding a current member changes nothing. */
    addMember(
      tenant: TenantContext,
      teamId: string,
      userId: string,
      meta: RequestMeta,
    ): Promise<Team> {
      return write(tenant, meta, async (teams) => {
        const team = await existing(teams, teamId, 'key share');
        if (!(await teams.isMember(userId))) throw new NotFoundError('Member');
        await teams.addMember(team.id, userId);
        return toDto(await existing(teams, team.id, 'key share'));
      });
    },

    /** Idempotent: removing someone who isn't on the team changes nothing. */
    removeMember(
      tenant: TenantContext,
      teamId: string,
      userId: string,
      meta: RequestMeta,
    ): Promise<void> {
      return write(tenant, meta, async (teams) => {
        const team = await existing(teams, teamId, 'key share');
        await teams.removeMember(team.id, userId);
      });
    },
  };
}

export type TeamsService = ReturnType<typeof createTeamsService>;
