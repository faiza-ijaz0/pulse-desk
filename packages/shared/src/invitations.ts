import { z } from 'zod';
import { emailSchema, passwordSchema, personNameSchema } from './auth.ts';

// Contracts for invitations (docs/architecture/auth-and-sessions.md, "Invitations"). Admins and
// owners invite into the session's active organization; the invitee accepts with the link's
// token, which travels in request bodies only (never in a URL path or query string).

/** Ownership is never granted by invitation: an owner promotes a member instead. */
export const INVITABLE_ROLES = ['ADMIN', 'AGENT'] as const;
export const invitableRoleSchema = z.enum(INVITABLE_ROLES, {
  error: 'Choose Admin or Agent',
});
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

/** How long an invitation link works. */
export const INVITATION_TTL_DAYS = 7;

/** The shape of an invitation token: 32 random bytes, base64url (43 characters). */
export const invitationTokenSchema = z
  .string({ error: 'This invitation link is incomplete' })
  .regex(/^[A-Za-z0-9_-]{43}$/, { error: 'This invitation link is incomplete' });

export const createInvitationRequestSchema = z.object({
  email: emailSchema,
  role: invitableRoleSchema,
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const invitationParamsSchema = z.object({
  invitationId: z.uuid({ error: 'Must be a valid invitation ID' }),
});

/**
 * An invitation as its organization's admins see it. Only open invitations (neither accepted
 * nor revoked) are listed; `expired` ones stay listed until revoked or replaced.
 */
export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: invitableRoleSchema,
  status: z.enum(['pending', 'expired']),
  invitedBy: z.object({ userId: z.uuid(), name: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const invitationListResponseSchema = z.object({ data: z.array(invitationSchema) });
export type InvitationListResponse = z.infer<typeof invitationListResponseSchema>;

/**
 * The new invitation and its token, returned once: only a hash is stored, so the link can't
 * be shown again (inviting the same email again issues a new one and revokes the old).
 */
export const createInvitationResponseSchema = z.object({
  invitation: invitationSchema,
  token: invitationTokenSchema,
});
export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;

export const invitationTokenRequestSchema = z.object({ token: invitationTokenSchema });
export type InvitationTokenRequest = z.infer<typeof invitationTokenRequestSchema>;

/** What the holder of a valid link sees before accepting. */
export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  email: z.string(),
  role: invitableRoleSchema,
  invitedByName: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/** A new account created from an invitation: its email is the invitation's, never chosen. */
export const registerWithInvitationRequestSchema = z.object({
  token: invitationTokenSchema,
  name: personNameSchema,
  password: passwordSchema,
});
export type RegisterWithInvitationRequest = z.infer<typeof registerWithInvitationRequestSchema>;
