import { z } from 'zod';
import { organizationNameSchema } from './auth.ts';
import { roleSchema } from './roles.ts';

// Contracts for the active organization and its members. The organization is always the
// session's active one; its ID never appears in these URLs (docs/conventions.md).

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.iso.datetime(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const updateOrganizationRequestSchema = z.object({
  name: organizationNameSchema,
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
