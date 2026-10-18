import type { Database } from '@pulsedesk/db';
import { Router } from 'express';
import type { Env } from './config/env.ts';
import { authenticate, requireTenant } from './http/middleware/authenticate.ts';
import { authRateLimits } from './http/middleware/rate-limit.ts';
import type { Clock } from './lib/clock.ts';
import type { Logger } from './lib/logger.ts';
import { createAuthController } from './modules/auth/auth.controller.ts';
import { createAuthRepository } from './modules/auth/auth.repository.ts';
import { authRoutes } from './modules/auth/auth.routes.ts';
import { createAuthService } from './modules/auth/auth.service.ts';
import { sessionCookieConfig } from './modules/auth/session-cookie.ts';
import { createMembersController } from './modules/members/members.controller.ts';
import { createMembersRepository } from './modules/members/members.repository.ts';
import { membersRoutes } from './modules/members/members.routes.ts';
import { createMembersService } from './modules/members/members.service.ts';
import { createOrganizationsController } from './modules/organizations/organizations.controller.ts';
import { createOrganizationsRepository } from './modules/organizations/organizations.repository.ts';
import { organizationsRoutes } from './modules/organizations/organizations.routes.ts';
import { createOrganizationsService } from './modules/organizations/organizations.service.ts';

export type ApiRouterDependencies = {
  env: Env;
  db: Database;
  logger: Logger;
  clock: Clock;
};

/**
 * Wires every feature module (routes → controller → service → repository) for `/api/v1`.
 * The session cookie is resolved once for all routes; tenant-scoped routes additionally
 * require a current membership in the session's active organization.
 */
export function createApiRouter({ env, db, logger, clock }: ApiRouterDependencies): Router {
  const cookie = sessionCookieConfig(env);
  const authService = createAuthService({
    repository: createAuthRepository(db),
    clock,
    logger,
    config: {
      sessionSecret: env.SESSION_SECRET,
      idleTimeoutMinutes: env.SESSION_IDLE_TIMEOUT_MINUTES,
      absoluteTimeoutDays: env.SESSION_ABSOLUTE_TIMEOUT_DAYS,
    },
  });
  const tenant = requireTenant(authService);

  const router = Router();
  router.use(authenticate(authService, cookie));
  router.use(
    authRoutes(
      createAuthController({ service: authService, cookie, clock }),
      authRateLimits(env.RATE_LIMIT_AUTH_PER_15_MINUTES),
    ),
  );
  router.use(
    organizationsRoutes(
      createOrganizationsController(
        createOrganizationsService({ repository: createOrganizationsRepository(db) }),
      ),
      tenant,
    ),
  );
  router.use(
    membersRoutes(
      createMembersController(createMembersService({ repository: createMembersRepository(db) })),
      tenant,
    ),
  );
  return router;
}
