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
import { createCustomersController } from './modules/customers/customers.controller.ts';
import { createCustomersRepository } from './modules/customers/customers.repository.ts';
import { customersRoutes } from './modules/customers/customers.routes.ts';
import { createCustomersService } from './modules/customers/customers.service.ts';
import { createMembersController } from './modules/members/members.controller.ts';
import { createMembersRepository } from './modules/members/members.repository.ts';
import { membersRoutes } from './modules/members/members.routes.ts';
import { createMembersService } from './modules/members/members.service.ts';
import { createOrganizationsController } from './modules/organizations/organizations.controller.ts';
import { createOrganizationsRepository } from './modules/organizations/organizations.repository.ts';
import { organizationsRoutes } from './modules/organizations/organizations.routes.ts';
import { createOrganizationsService } from './modules/organizations/organizations.service.ts';
import { createSearchController } from './modules/search/search.controller.ts';
import { searchRoutes } from './modules/search/search.routes.ts';
import { createSearchService } from './modules/search/search.service.ts';
import { createTagsController } from './modules/tags/tags.controller.ts';
import { createTagsRepository } from './modules/tags/tags.repository.ts';
import { tagsRoutes } from './modules/tags/tags.routes.ts';
import { createTagsService } from './modules/tags/tags.service.ts';
import { createTeamsController } from './modules/teams/teams.controller.ts';
import { createTeamsRepository } from './modules/teams/teams.repository.ts';
import { teamsRoutes } from './modules/teams/teams.routes.ts';
import { createTeamsService } from './modules/teams/teams.service.ts';
import { createTicketsController } from './modules/tickets/tickets.controller.ts';
import { createTicketsRepository } from './modules/tickets/tickets.repository.ts';
import { ticketsRoutes } from './modules/tickets/tickets.routes.ts';
import { createTicketsService } from './modules/tickets/tickets.service.ts';

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
      createMembersController(
        createMembersService({ repository: createMembersRepository(db), clock }),
      ),
      tenant,
    ),
  );
  const ticketsRepository = createTicketsRepository(db);
  const customersRepository = createCustomersRepository(db);
  const customersService = createCustomersService({ repository: customersRepository });
  router.use(
    ticketsRoutes(
      createTicketsController(
        createTicketsService({ repository: ticketsRepository, logger, clock }),
      ),
      tenant,
    ),
  );
  router.use(customersRoutes(createCustomersController(customersService), tenant));
  router.use(
    teamsRoutes(
      createTeamsController(createTeamsService({ repository: createTeamsRepository(db), clock })),
      tenant,
    ),
  );
  router.use(
    tagsRoutes(
      createTagsController(createTagsService({ repository: createTagsRepository(db), clock })),
      tenant,
    ),
  );
  router.use(
    searchRoutes(
      createSearchController(
        createSearchService({
          tickets: ticketsRepository,
          customers: customersRepository,
          customerDtos: customersService,
        }),
      ),
      tenant,
    ),
  );
  return router;
}
