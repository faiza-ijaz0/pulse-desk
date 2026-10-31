import { randomBytes } from 'node:crypto';
import type {
  AuthSession,
  LoginRequest,
  OrganizationMembership,
  RegisterRequest,
  SessionUser,
} from '@pulsedesk/shared';
import type { AuthContext, RequestMeta, TenantContext } from '../../http/auth-context.ts';
import {
  EmailTakenError,
  InvalidCredentialsError,
  NoActiveOrganizationError,
  NotFoundError,
  UnauthenticatedError,
} from '../../http/errors.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../lib/logger.ts';
import { isUniqueViolation, type AuthRepository, type MembershipRow } from './auth.repository.ts';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from './password.ts';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** lastSeenAt is written at most this often, so most requests stay read-only. */
const TOUCH_INTERVAL_MS = MINUTE;
const SLUG_ATTEMPTS = 3;

export type AuthServiceConfig = {
  sessionSecret: string;
  idleTimeoutMinutes: number;
  absoluteTimeoutDays: number;
};

export type AuthServiceDeps = {
  repository: AuthRepository;
  clock: Clock;
  logger: Logger;
  config: AuthServiceConfig;
};

/** A freshly issued session: the raw token goes into the cookie and nowhere else. */
export type IssuedSession = {
  token: string;
  expiresAt: Date;
  session: AuthSession;
};

function toMembership(row: MembershipRow): OrganizationMembership {
  return { ...row.organization, role: row.role };
}

/** URL-friendly organization slug with a random suffix, e.g. `acme-support-3fa9c1`. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

export function createAuthService({ repository, clock, logger, config }: AuthServiceDeps) {
  const idleTimeoutMs = config.idleTimeoutMinutes * MINUTE;
  const absoluteTimeoutMs = config.absoluteTimeoutDays * DAY;
  const tokenHashOf = (token: string) => hashSessionToken(config.sessionSecret, token);

  async function buildSession(
    user: SessionUser,
    activeOrganizationId: string | null,
  ): Promise<AuthSession> {
    const organizations = (await repository.listMemberships(user.id)).map(toMembership);
    return {
      user,
      activeOrganization: organizations.find((o) => o.id === activeOrganizationId) ?? null,
      organizations,
    };
  }

  return {
    async register(input: RegisterRequest, meta: RequestMeta): Promise<IssuedSession> {
      // Registration necessarily tells the caller whether an email is taken; the auth rate
      // limit bounds how fast anyone can probe (docs/architecture/auth-and-sessions.md §2).
      if (await repository.emailExists(input.email)) throw new EmailTakenError();

      const passwordHash = await hashPassword(input.password);
      const now = clock.now();
      const token = generateSessionToken();
      const expiresAt = new Date(now.getTime() + absoluteTimeoutMs);

      for (let attempt = 1; ; attempt++) {
        try {
          const account = await repository.createAccount({
            user: { name: input.name, email: input.email, passwordHash },
            organization: { name: input.organizationName, slug: slugify(input.organizationName) },
            session: {
              tokenHash: tokenHashOf(token),
              expiresAt,
              ipAddress: meta.ipAddress,
              userAgent: meta.userAgent,
            },
            audit: { ipAddress: meta.ipAddress, requestId: meta.requestId },
          });
          logger.info(
            { userId: account.user.id, organizationId: account.organizationId },
            'Account registered',
          );
          return {
            token,
            expiresAt,
            session: await buildSession(account.user, account.organizationId),
          };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Two sign-ups raced for one email: the loser gets the same answer as above.
          if (await repository.emailExists(input.email)) throw new EmailTakenError();
          // Otherwise the random slug suffix collided; try another.
          if (attempt >= SLUG_ATTEMPTS) throw error;
        }
      }
    },

    async login(
      input: LoginRequest,
      meta: RequestMeta,
      previousToken: string | undefined,
    ): Promise<IssuedSession> {
      const user = await repository.findUserByEmail(input.email);
      if (!user) {
        await verifyAgainstDummy(input.password);
        throw new InvalidCredentialsError();
      }
      if (!(await verifyPassword(user.passwordHash, input.password))) {
        throw new InvalidCredentialsError();
      }

      if (needsRehash(user.passwordHash)) {
        await repository.updatePasswordHash(user.id, await hashPassword(input.password));
      }
      // Never upgrade a cookie the browser already had: end that session, issue a new token.
      if (previousToken !== undefined && isWellFormedSessionToken(previousToken)) {
        await repository.revokeSessionByTokenHash(tokenHashOf(previousToken), clock.now());
      }

      const memberships = await repository.listMemberships(user.id);
      const activeOrganizationId = memberships[0]?.organization.id ?? null;
      const now = clock.now();
      const token = generateSessionToken();
      const expiresAt = new Date(now.getTime() + absoluteTimeoutMs);
      await repository.createSession({
        tokenHash: tokenHashOf(token),
        userId: user.id,
        activeOrganizationId,
        expiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      logger.info({ userId: user.id }, 'User signed in');

      const sessionUser = { id: user.id, name: user.name, email: user.email };
      return {
        token,
        expiresAt,
        session: {
          user: sessionUser,
          activeOrganization: memberships[0] === undefined ? null : toMembership(memberships[0]),
          organizations: memberships.map(toMembership),
        },
      };
    },

    /**
     * A fresh session for a user who just proved who they are some other way (an account
     * created from an invitation), active in `organizationId`.
     */
    async startSession(
      user: SessionUser,
      organizationId: string,
      meta: RequestMeta,
    ): Promise<IssuedSession> {
      const now = clock.now();
      const token = generateSessionToken();
      const expiresAt = new Date(now.getTime() + absoluteTimeoutMs);
      await repository.createSession({
        tokenHash: tokenHashOf(token),
        userId: user.id,
        activeOrganizationId: organizationId,
        expiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return { token, expiresAt, session: await buildSession(user, organizationId) };
    },

    /** Idempotent; an unknown, expired or malformed token is simply ignored. */
    async logout(token: string | undefined): Promise<void> {
      if (token === undefined || !isWellFormedSessionToken(token)) return;
      await repository.revokeSessionByTokenHash(tokenHashOf(token), clock.now());
    },

    /**
     * Validates a cookie token: it must match a stored HMAC and the session must be neither
     * revoked, past its absolute expiry, nor idle for longer than the idle timeout.
     */
    async authenticate(token: string): Promise<AuthContext | null> {
      if (!isWellFormedSessionToken(token)) return null;
      const session = await repository.findSessionByTokenHash(tokenHashOf(token));
      if (!session) return null;

      const now = clock.now();
      const idleFor = now.getTime() - session.lastSeenAt.getTime();
      if (session.revokedAt !== null || session.expiresAt <= now || idleFor > idleTimeoutMs) {
        return null;
      }
      if (idleFor > TOUCH_INTERVAL_MS) await repository.touchSession(session.id, now);

      return {
        sessionId: session.id,
        user: session.user,
        activeOrganizationId: session.activeOrganizationId,
        expiresAt: session.expiresAt,
      };
    },

    /**
     * Builds the tenant context from the session's active organization and a membership
     * row read on this request, so removals and role changes apply immediately.
     */
    async resolveTenant(auth: AuthContext, requestId: string): Promise<TenantContext> {
      if (auth.activeOrganizationId === null) throw new NoActiveOrganizationError();
      const membership = await repository.findMembership(auth.activeOrganizationId, auth.user.id);
      if (!membership) throw new NoActiveOrganizationError();
      return {
        organizationId: auth.activeOrganizationId,
        userId: auth.user.id,
        role: membership.role,
        requestId,
      };
    },

    getSession(auth: AuthContext): Promise<AuthSession> {
      return buildSession(auth.user, auth.activeOrganizationId);
    },

    /**
     * Switches the active organization after checking membership. The organization ID is
     * client-supplied, so it is trusted only once a membership row confirms it. A
     * non-member gets 404, not 403, so other organizations' IDs can't be probed.
     */
    async switchOrganization(
      auth: AuthContext,
      organizationId: string,
      meta: RequestMeta,
    ): Promise<IssuedSession> {
      const membership = await repository.findMembership(organizationId, auth.user.id);
      if (!membership) throw new NotFoundError('Organization');

      const token = generateSessionToken();
      const rotated = await repository.rotateSession(
        auth.sessionId,
        {
          tokenHash: tokenHashOf(token),
          userId: auth.user.id,
          activeOrganizationId: organizationId,
          // Rotation keeps the absolute lifetime cap; switching never extends a session.
          expiresAt: auth.expiresAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        clock.now(),
      );
      if (!rotated) throw new UnauthenticatedError();

      return {
        token,
        expiresAt: auth.expiresAt,
        session: await buildSession(auth.user, organizationId),
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
