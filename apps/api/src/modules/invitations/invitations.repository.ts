import {
  Prisma,
  prismaErrorCode,
  type Database,
  type Role,
  type TransactionClient,
} from '@pulsedesk/db';
import type { InvitableRole } from '@pulsedesk/shared';
import {
  AlreadyMemberError,
  ConflictError,
  EmailTakenError,
  InvitationInvalidError,
  NotFoundError,
  type InvitationProblem,
} from '../../http/errors.ts';
import { withTransactionRetry } from '../../lib/transactions.ts';

export type AuditEntry = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

const invitationSelect = {
  id: true,
  email: true,
  role: true,
  createdAt: true,
  expiresAt: true,
  invitedBy: { select: { id: true, name: true } },
} as const;

export type InvitationRow = {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
  invitedBy: { id: string; name: string } | null;
};

/** An invitation found by its token hash, with what its holder may see. */
export type TokenInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: Role;
  invitedByName: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

/** Why a token's invitation can't be accepted at `now`, or null if it can. */
export function invitationProblem(
  invitation: TokenInvitation | null,
  now: Date,
): InvitationProblem | null {
  if (!invitation) return 'unknown';
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.revokedAt !== null) return 'revoked';
  // At exactly its expiry an invitation no longer works.
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'expired';
  return null;
}

/**
 * The one read keyed by something other than the tenant: the token's hash, a 256-bit secret
 * only its holder knows. Raw SQL because no organization ID is known yet (the tenant guard
 * would refuse an unscoped Prisma query); every write after it carries the row's own
 * organization ID. `lock` holds the row FOR UPDATE until the transaction ends, so concurrent
 * acceptances and revocations of one invitation take turns.
 */
async function findByTokenHash(
  client: Database | TransactionClient,
  tokenHash: string,
  lock: boolean,
): Promise<TokenInvitation | null> {
  const rows = await client.$queryRaw<TokenInvitation[]>`
    SELECT i."id", i."organizationId", o."name" AS "organizationName", i."email", i."role"::text AS "role",
           u."name" AS "invitedByName", i."expiresAt", i."acceptedAt", i."revokedAt"
      FROM "Invitation" i
      JOIN "Organization" o ON o."id" = i."organizationId"
      LEFT JOIN "User" u ON u."id" = i."invitedByUserId"
     WHERE i."tokenHash" = ${tokenHash}
     ${lock ? Prisma.sql`FOR UPDATE OF i` : Prisma.empty}`;
  return rows[0] ?? null;
}

export type AcceptOutcome =
  | { kind: 'accepted'; organizationId: string }
  | { kind: 'email_mismatch'; organizationId: string; invitationId: string };

/**
 * Lock order (docs/architecture/data-model.md, "Concurrency"): the Organization row first, then
 * invitation rows. Member removals and demotions lock the organization FOR UPDATE and then
 * revoke the member's invitations; every invitation write takes FOR KEY SHARE on the
 * organization before it touches an invitation row, so the two wait for each other instead of
 * deadlocking (an insert's foreign-key check would otherwise take that lock last).
 */
async function lockOrganization(tx: TransactionClient, organizationId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${organizationId}::uuid FOR KEY SHARE`;
}

export function createInvitationsRepository(db: Database) {
  /** Locks the token's invitation (after its organization) and checks it can still be used. */
  async function lockOpen(
    tx: TransactionClient,
    tokenHash: string,
    now: Date,
  ): Promise<TokenInvitation> {
    const unlocked = await findByTokenHash(tx, tokenHash, false);
    if (unlocked) await lockOrganization(tx, unlocked.organizationId);
    const invitation = await findByTokenHash(tx, tokenHash, true);
    const problem = invitationProblem(invitation, now);
    if (problem !== null || !invitation) throw new InvitationInvalidError(problem ?? 'unknown');
    return invitation;
  }

  /**
   * Adds the membership and marks the (locked, open) invitation accepted, in the caller's
   * transaction. An existing membership is AlreadyMemberError; the membership's unique key is
   * the backstop, so no race can create a second one.
   */
  async function join(
    tx: TransactionClient,
    invitation: TokenInvitation,
    user: { id: string },
    now: Date,
    meta: { ipAddress: string | undefined; requestId: string; newAccount: boolean },
  ): Promise<void> {
    const { organizationId } = invitation;
    const existing = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      select: { id: true },
    });
    if (existing) throw new AlreadyMemberError();
    await tx.membership.create({
      data: { organizationId, userId: user.id, role: invitation.role },
    });
    await tx.invitation.update({
      where: { id: invitation.id, organizationId },
      data: { acceptedAt: now, acceptedByUserId: user.id },
    });
    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: user.id,
        action: 'invitation.accepted',
        targetType: 'Invitation',
        targetId: invitation.id,
        metadata: { email: invitation.email, role: invitation.role, newAccount: meta.newAccount },
        ipAddress: meta.ipAddress ?? null,
        requestId: meta.requestId,
      },
    });
  }

  /** Runs `fn` in a (retried) transaction, turning a unique violation into `onUnique()`. */
  async function transaction<T>(
    fn: (tx: TransactionClient) => Promise<T>,
    onUnique: () => Error,
  ): Promise<T> {
    try {
      return await withTransactionRetry(() => db.$transaction(fn));
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') throw onUnique();
      throw error;
    }
  }

  return {
    /** Open invitations (neither accepted nor revoked), newest first; expired ones included. */
    listOpen(organizationId: string): Promise<InvitationRow[]> {
      return db.invitation.findMany({
        where: { organizationId, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: invitationSelect,
      });
    },

    /**
     * Creates an invitation, revoking any open one to the same email, with one audit entry.
     * Invitations in one organization are serialized by a transaction-scoped advisory lock;
     * the partial unique index "Invitation_one_open_per_email_key" is the backstop.
     */
    create(
      organizationId: string,
      input: { email: string; role: InvitableRole; tokenHash: string; expiresAt: Date },
      now: Date,
      audit: AuditEntry,
    ): Promise<InvitationRow> {
      return transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invitations:${organizationId}`}, 0))`;
          await lockOrganization(tx, organizationId);

          // Revoke the open invitation to this email first, conditionally: an acceptance in
          // flight holds its row, so this waits for it and then finds it accepted (count 0).
          const previous = await tx.invitation.findFirst({
            where: { organizationId, email: input.email, acceptedAt: null, revokedAt: null },
            select: { id: true },
          });
          let replacedInvitationId: string | undefined;
          if (previous) {
            const replaced = await tx.invitation.updateMany({
              where: { organizationId, id: previous.id, acceptedAt: null, revokedAt: null },
              data: { revokedAt: now },
            });
            if (replaced.count === 1) replacedInvitationId = previous.id;
          }
          // Only now check membership, so an acceptance that just committed is seen.
          const member = await tx.membership.findFirst({
            where: { organizationId, user: { email: input.email } },
            select: { id: true },
          });
          if (member) throw new AlreadyMemberError();

          const invitation = await tx.invitation.create({
            data: {
              organizationId,
              email: input.email,
              role: input.role,
              tokenHash: input.tokenHash,
              invitedByUserId: audit.actorUserId,
              expiresAt: input.expiresAt,
              createdAt: now,
            },
            select: invitationSelect,
          });
          const metadata: Prisma.InputJsonObject = {
            email: input.email,
            role: input.role,
            expiresAt: input.expiresAt.toISOString(),
            ...(replacedInvitationId && { replacedInvitationId }),
          };
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: audit.actorUserId,
              action: 'invitation.created',
              targetType: 'Invitation',
              targetId: invitation.id,
              metadata,
              ipAddress: audit.ipAddress ?? null,
              requestId: audit.requestId,
            },
          });
          return invitation;
        },
        () => new ConflictError('Another invitation to this email was just created.'),
      );
    },

    /**
     * Revokes an open invitation (expired ones included) with one audit entry. Revoking a
     * revoked invitation changes nothing; an accepted one can't be revoked (remove the member
     * instead). An ID from another organization is simply not found.
     */
    revoke(organizationId: string, invitationId: string, now: Date, audit: AuditEntry) {
      return transaction(
        async (tx) => {
          await lockOrganization(tx, organizationId);
          const invitation = await tx.invitation.findFirst({
            where: { organizationId, id: invitationId },
            select: { email: true, role: true },
          });
          if (!invitation) throw new NotFoundError('Invitation');
          // Conditional, so a concurrent acceptance (which holds the row lock) wins or loses
          // cleanly: this re-checks the row after the lock is released.
          const revoked = await tx.invitation.updateMany({
            where: { organizationId, id: invitationId, acceptedAt: null, revokedAt: null },
            data: { revokedAt: now },
          });
          if (revoked.count === 0) {
            const current = await tx.invitation.findFirstOrThrow({
              where: { organizationId, id: invitationId },
              select: { acceptedAt: true },
            });
            if (current.acceptedAt !== null) {
              throw new ConflictError('This invitation has already been accepted.');
            }
            return; // already revoked: nothing to do
          }
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: audit.actorUserId,
              action: 'invitation.revoked',
              targetType: 'Invitation',
              targetId: invitationId,
              metadata: { email: invitation.email, role: invitation.role },
              ipAddress: audit.ipAddress ?? null,
              requestId: audit.requestId,
            },
          });
        },
        () => new ConflictError('This invitation changed while it was being revoked.'),
      );
    },

    findByTokenHash: (tokenHash: string) => findByTokenHash(db, tokenHash, false),

    /**
     * An existing user accepts: membership and acceptance commit together, or neither. A user
     * whose email isn't the invitation's changes nothing (the caller records the refusal).
     */
    acceptAsUser(
      tokenHash: string,
      user: { id: string; email: string },
      now: Date,
      meta: { ipAddress: string | undefined; requestId: string },
    ): Promise<AcceptOutcome> {
      return transaction(
        async (tx) => {
          const invitation = await lockOpen(tx, tokenHash, now);
          const { organizationId } = invitation;
          if (invitation.email !== user.email) {
            return { kind: 'email_mismatch', organizationId, invitationId: invitation.id };
          }
          await join(tx, invitation, user, now, { ...meta, newAccount: false });
          return { kind: 'accepted', organizationId };
        },
        () => new AlreadyMemberError(),
      );
    },

    /**
     * A new account from an invitation: the user (with the invitation's own email), the
     * membership and the acceptance commit together, or none do. The invitation is locked
     * first, so a second attempt with the same link waits and then finds it used. An existing
     * account with that email is EMAIL_TAKEN: its owner signs in and accepts instead.
     */
    registerAndAccept(
      tokenHash: string,
      account: { name: string; passwordHash: string },
      now: Date,
      meta: { ipAddress: string | undefined; requestId: string },
    ) {
      return transaction(
        async (tx) => {
          const invitation = await lockOpen(tx, tokenHash, now);
          if (
            await tx.user.findUnique({ where: { email: invitation.email }, select: { id: true } })
          ) {
            throw new EmailTakenError();
          }
          const user = await tx.user.create({
            data: { ...account, email: invitation.email },
            select: { id: true, name: true, email: true },
          });
          await join(tx, invitation, user, now, { ...meta, newAccount: true });
          return { user, organizationId: invitation.organizationId };
        },
        // A sign-up with the same email committed in between.
        () => new EmailTakenError(),
      );
    },

    /** A refused acceptance worth an administrator's attention (written on its own). */
    async recordRefusal(
      organizationId: string,
      invitationId: string,
      userId: string,
      reason: 'email_mismatch',
      meta: { ipAddress: string | undefined; requestId: string },
    ): Promise<void> {
      await db.auditLog.create({
        data: {
          organizationId,
          actorUserId: userId,
          action: 'invitation.accept_refused',
          targetType: 'Invitation',
          targetId: invitationId,
          metadata: { reason },
          ipAddress: meta.ipAddress ?? null,
          requestId: meta.requestId,
        },
      });
    },
  };
}

export type InvitationsRepository = ReturnType<typeof createInvitationsRepository>;
