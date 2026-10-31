import { z } from 'zod';
import { organizationNameSchema } from './auth.ts';
import { roleSchema } from './roles.ts';

// Contracts for the active organization and its members. The organization is always the
// session's active one; its ID never appears in these URLs (docs/conventions.md).

/**
 * Solved tickets close automatically this long after both their solve and their last update
 * (docs/architecture/data-model.md, "Auto-close"). The bounds match
 * Organization_autoCloseAfterMinutes_check: 1 minute to 1 year.
 */
export const AUTO_CLOSE_MIN_MINUTES = 1;
export const AUTO_CLOSE_MAX_MINUTES = 365 * 24 * 60;

export const autoCloseAfterMinutesSchema = z
  .int({ error: 'Must be a whole number of minutes' })
  .min(AUTO_CLOSE_MIN_MINUTES, { error: 'Must be at least 1 minute' })
  .max(AUTO_CLOSE_MAX_MINUTES, { error: 'Must be at most 365 days' });

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.iso.datetime(),
  autoCloseEnabled: z.boolean(),
  autoCloseAfterMinutes: autoCloseAfterMinutesSchema,
});
export type Organization = z.infer<typeof organizationSchema>;

/** Any subset of the organization's settings; an empty change is refused. */
export const updateOrganizationRequestSchema = z
  .object({
    name: organizationNameSchema.optional(),
    autoCloseEnabled: z.boolean({ error: 'Must be true or false' }).optional(),
    autoCloseAfterMinutes: autoCloseAfterMinutesSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    error: 'Change at least one setting',
  });
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;

export const memberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  joinedAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const memberListResponseSchema = z.object({ data: z.array(memberSchema) });
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

export const memberParamsSchema = z.object({
  userId: z.uuid({ error: 'Must be a valid user ID' }),
});

export const changeMemberRoleRequestSchema = z.object({ role: roleSchema });
export type ChangeMemberRoleRequest = z.infer<typeof changeMemberRoleRequestSchema>;
