import {
  INVITATION_TTL_DAYS,
  canManageRole,
  type CreateInvitationRequest,
  type CreateInvitationResponse,
  type Invitation,
  type InvitationPreview,
  type RegisterWithInvitationRequest,
} from '@pulsedesk/shared';
import type { AuthContext, RequestMeta, TenantContext } from '../../http/auth-context.ts';
import {
  ForbiddenError,
  InvitationEmailMismatchError,
  InvitationInvalidError,
  ValidationError,
} from '../../http/errors.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../lib/logger.ts';
import type { AuthService, IssuedSession } from '../auth/auth.service.ts';
import { hashPassword } from '../auth/password.ts';
import { generateInvitationToken, hashInvitationToken } from './invitation-token.ts';
import {
  invitationProblem,
  type InvitationRow,
  type InvitationsRepository,
} from './invitations.repository.ts';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Invitations into an organization (docs/architecture/auth-and-sessions.md, "Invitations").
 * Management acts on the session's active organization only; the public steps (preview,
 * accept, sign up) find the invitation by its token's hash and act on that invitation's own
 * organization. Tokens are never logged, stored or returned except once, to the inviter.
 */
export function createInvitationsService({
  repository,
  auth,
  clock,
  logger,
  sessionSecret,
}: {
  repository: InvitationsRepository;
  auth: AuthService;
  clock: Clock;
  logger: Logger;
  sessionSecret: string;
}) {
  const hashOf = (token: string) => hashInvitationToken(sessionSecret, token);

  function toDto(row: InvitationRow, now: Date): Invitation {
    return {
      id: row.id,
      email: row.email,
      // The database refuses OWNER invitations (Invitation_role_check).
      role: row.role === 'ADMIN' ? 'ADMIN' : 'AGENT',
      status: row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending',
      invitedBy: row.invitedBy && { userId: row.invitedBy.id, name: row.invitedBy.name },
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  const auditOf = (tenant: TenantContext, meta: RequestMeta) => ({
    actorUserId: tenant.userId,
    ipAddress: meta.ipAddress,
    requestId: tenant.requestId,
  });

  return {
    async list(tenant: TenantContext): Promise<Invitation[]> {
      const now = clock.now();
      return (await repository.listOpen(tenant.organizationId)).map((row) => toDto(row, now));
    },

    async create(
      tenant: TenantContext,
      input: CreateInvitationRequest,
      meta: RequestMeta,
    ): Promise<CreateInvitationResponse> {
      // The route requires member:invite; inviting someone into a role you couldn't give
      // them by a role change is refused too (owners are never invitable at all).
      if (!canManageRole(tenant.role, input.role)) {
        throw new ForbiddenError('You can’t invite members with this role.');
      }
      const now = clock.now();
      const token = generateInvitationToken();
      const row = await repository.create(
        tenant.organizationId,
        {
          email: input.email,
          role: input.role,
          tokenHash: hashOf(token),
          expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * DAY),
        },
        now,
        auditOf(tenant, meta),
      );
      logger.info(
        { organizationId: tenant.organizationId, invitationId: row.id },
        'Invitation created',
      );
      return { invitation: toDto(row, now), token };
    },

    revoke(tenant: TenantContext, invitationId: string, meta: RequestMeta): Promise<void> {
      return repository.revoke(
        tenant.organizationId,
        invitationId,
        clock.now(),
        auditOf(tenant, meta),
      );
    },

    async preview(token: string): Promise<InvitationPreview> {
      const invitation = await repository.findByTokenHash(hashOf(token));
      const problem = invitationProblem(invitation, clock.now());
      if (problem !== null || !invitation) throw new InvitationInvalidError(problem ?? 'unknown');
      return {
        organizationName: invitation.organizationName,
        email: invitation.email,
        role: invitation.role === 'ADMIN' ? 'ADMIN' : 'AGENT',
        invitedByName: invitation.invitedByName,
        expiresAt: invitation.expiresAt.toISOString(),
      };
    },

    /**
     * The signed-in user accepts, then their session is rotated into the organization (a new
     * token: a membership is a privilege change). Only the invited email may accept.
     */
    async accept(
      authContext: AuthContext,
      token: string,
      meta: RequestMeta,
    ): Promise<IssuedSession> {
      const outcome = await repository.acceptAsUser(hashOf(token), authContext.user, clock.now(), {
        ipAddress: meta.ipAddress,
        requestId: meta.requestId,
      });
      if (outcome.kind === 'email_mismatch') {
        await repository.recordRefusal(
          outcome.organizationId,
          outcome.invitationId,
          authContext.user.id,
          'email_mismatch',
          { ipAddress: meta.ipAddress, requestId: meta.requestId },
        );
        throw new InvitationEmailMismatchError();
      }
      logger.info(
        { userId: authContext.user.id, organizationId: outcome.organizationId },
        'Invitation accepted',
      );
      return auth.switchOrganization(authContext, outcome.organizationId, meta);
    },

    /** A new account with the invitation's email, its membership and its first session. */
    async register(
      input: RegisterWithInvitationRequest,
      meta: RequestMeta,
    ): Promise<IssuedSession> {
      const tokenHash = hashOf(input.token);
      const invitation = await repository.findByTokenHash(tokenHash);
      const problem = invitationProblem(invitation, clock.now());
      if (problem !== null || !invitation) throw new InvitationInvalidError(problem ?? 'unknown');
      if (input.password.trim().toLowerCase() === invitation.email) {
        throw new ValidationError([
          { path: 'body.password', message: 'Your password can’t be your email address' },
        ]);
      }

      // Hashing is slow, so it happens before the transaction, which re-checks everything.
      const passwordHash = await hashPassword(input.password);
      const { user, organizationId } = await repository.registerAndAccept(
        tokenHash,
        { name: input.name, passwordHash },
        clock.now(),
        { ipAddress: meta.ipAddress, requestId: meta.requestId },
      );
      logger.info({ userId: user.id, organizationId }, 'Account registered from invitation');
      // A separate step: if it failed, the account exists and its owner simply signs in.
      return auth.startSession(user, organizationId, meta);
    },
  };
}

export type InvitationsService = ReturnType<typeof createInvitationsService>;
