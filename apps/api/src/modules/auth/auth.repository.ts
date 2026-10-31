import { Prisma, type Database, type Role, type TicketPriority } from '@pulsedesk/db';
import { DEFAULT_SLA_POLICY_NAME, DEFAULT_SLA_TARGETS } from '@pulsedesk/shared';

export type NewSession = {
  tokenHash: string;
  userId: string;
  activeOrganizationId: string | null;
  expiresAt: Date;
  ipAddress: string | undefined;
  userAgent: string | undefined;
};

export type NewAccount = {
  user: { name: string; email: string; passwordHash: string };
  organization: { name: string; slug: string };
  session: Omit<NewSession, 'userId' | 'activeOrganizationId'>;
  audit: { ipAddress: string | undefined; requestId: string };
};

export type MembershipRow = {
  organization: { id: string; name: string; slug: string };
  role: Role;
};

const sessionUserSelect = { id: true, name: true, email: true } as const;

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function createAuthRepository(db: Database) {
  return {
    findUserByEmail(email: string) {
      return db.user.findUnique({
        where: { email },
        select: { ...sessionUserSelect, passwordHash: true },
      });
    },

    async emailExists(email: string): Promise<boolean> {
      return (await db.user.count({ where: { email } })) > 0;
    },

    updatePasswordHash(userId: string, passwordHash: string) {
      return db.user.update({ where: { id: userId }, data: { passwordHash } });
    },

    /**
     * Registration in one transaction: the user, their organization, the OWNER membership,
     * the default SLA policy, an audit entry and the first session either all exist or none
     * do.
     */
    createAccount(input: NewAccount) {
      return db.$transaction(async (tx) => {
        const user = await tx.user.create({ data: input.user, select: sessionUserSelect });
        const organization = await tx.organization.create({ data: input.organization });
        await tx.membership.create({
          data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
        });
        // Every organization starts with the default policy, so its tickets get due dates.
        const policy = await tx.slaPolicy.create({
          data: { organizationId: organization.id, name: DEFAULT_SLA_POLICY_NAME, isDefault: true },
        });
        await tx.slaTarget.createMany({
          data: (Object.keys(DEFAULT_SLA_TARGETS) as TicketPriority[]).map((priority) => ({
            organizationId: organization.id,
            slaPolicyId: policy.id,
            priority,
            ...DEFAULT_SLA_TARGETS[priority],
          })),
        });
        await tx.auditLog.create({
          data: {
            organizationId: organization.id,
            actorUserId: user.id,
            action: 'organization.created',
            targetType: 'Organization',
            targetId: organization.id,
            ipAddress: nullable(input.audit.ipAddress),
            requestId: input.audit.requestId,
          },
        });
        const session = await tx.session.create({
          data: {
            ...input.session,
            ipAddress: nullable(input.session.ipAddress),
            userAgent: nullable(input.session.userAgent),
            userId: user.id,
            activeOrganizationId: organization.id,
          },
        });
        return { user, organizationId: organization.id, session };
      });
    },

    createSession(input: NewSession) {
      return db.session.create({
        data: {
          ...input,
          ipAddress: nullable(input.ipAddress),
          userAgent: nullable(input.userAgent),
        },
      });
    },

    findSessionByTokenHash(tokenHash: string) {
      return db.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          activeOrganizationId: true,
          lastSeenAt: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: sessionUserSelect },
        },
      });
    },

    touchSession(sessionId: string, now: Date) {
      return db.session.update({ where: { id: sessionId }, data: { lastSeenAt: now } });
    },

    /** Idempotent: revoking an already-revoked or unknown session changes nothing. */
    async revokeSessionByTokenHash(tokenHash: string, now: Date): Promise<void> {
      await db.session.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: now },
      });
    },

    /**
     * Session rotation: the old session is revoked and a new token is issued in one
     * transaction, so a pre-existing cookie is never upgraded (session fixation).
     */
    rotateSession(oldSessionId: string, replacement: NewSession, now: Date) {
      return db.$transaction(async (tx) => {
        const revoked = await tx.session.updateMany({
          where: { id: oldSessionId, revokedAt: null },
          data: { revokedAt: now },
        });
        // A concurrent logout won the race; don't resurrect the login.
        if (revoked.count === 0) return null;
        return tx.session.create({
          data: {
            ...replacement,
            ipAddress: nullable(replacement.ipAddress),
            userAgent: nullable(replacement.userAgent),
          },
        });
      });
    },

    /**
     * Memberships are listed through the user — a user-scoped read, not a tenant-scoped one,
     * so it intentionally isn't filtered by a single organization.
     */
    async listMemberships(userId: string): Promise<MembershipRow[]> {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          memberships: {
            orderBy: { createdAt: 'asc' },
            select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
          },
        },
      });
      return user?.memberships ?? [];
    },

    findMembership(organizationId: string, userId: string) {
      return db.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true },
      });
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
