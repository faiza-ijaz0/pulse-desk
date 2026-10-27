import { z } from 'zod';
import { ticketTeamSchema } from './tickets.ts';

export const teamMemberSchema = z.object({ userId: z.uuid(), name: z.string() });
export type TeamMember = z.infer<typeof teamMemberSchema>;

/** A team and its members (ordered by name), all from the active organization. */
export const teamSchema = ticketTeamSchema.extend({ members: z.array(teamMemberSchema) });
export type Team = z.infer<typeof teamSchema>;

/** `GET /api/v1/teams`, ordered by name. */
export const teamListResponseSchema = z.object({ data: z.array(teamSchema) });
export type TeamListResponse = z.infer<typeof teamListResponseSchema>;

const teamNameSchema = z
  .string({ error: 'Enter a team name' })
  .trim()
  .min(1, 'Enter a team name')
  .max(60, 'Team names can be at most 60 characters');

export const createTeamRequestSchema = z.strictObject({ name: teamNameSchema });
export type CreateTeamRequest = z.infer<typeof createTeamRequestSchema>;

export const updateTeamRequestSchema = z.strictObject({ name: teamNameSchema });
export type UpdateTeamRequest = z.infer<typeof updateTeamRequestSchema>;

export const teamParamsSchema = z.object({ teamId: z.uuid({ error: 'Must be a team ID' }) });

export const teamMemberParamsSchema = z.object({
  teamId: z.uuid({ error: 'Must be a team ID' }),
  userId: z.uuid({ error: 'Must be a user ID' }),
});
