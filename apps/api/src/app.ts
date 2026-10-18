import express, { Router, type Express } from 'express';
import type { Env } from './config/env.ts';
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.ts';
import { requireJsonBody, requireTrustedOrigin } from './http/middleware/origin-check.ts';
import { globalRateLimit } from './http/middleware/rate-limit.ts';
import { requestContext } from './http/middleware/request-context.ts';
import { corsPolicy, securityHeaders } from './http/middleware/security.ts';
import { systemClock, type Clock } from './lib/clock.ts';
import type { Logger } from './lib/logger.ts';
import { readinessRoutes, healthRoutes } from './modules/health/health.routes.ts';
import { createHealthService, createReadinessService } from './modules/health/health.service.ts';

export type AppDependencies = {
  env: Env;
  logger: Logger;
  clock?: Clock;
  startedAt?: Date;
  /**
   * Feature routers mounted under `/api/v1` (see createApiRouter). Injectable so tests can
   * exercise the full middleware stack without a database.
   */
  apiRouter?: Router;
  /** Resolves when the database answers; enables `GET /health/ready`. */
  checkDatabase?: () => Promise<unknown>;
};

/** Builds the Express app without listening, so tests and the server share one composition. */
export function createApp({
  env,
  logger,
  clock = systemClock,
  startedAt = clock.now(),
  apiRouter = Router(),
  checkDatabase,
}: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  // Order matters: every response — including errors and rate-limit rejections —
  // must carry a request ID and security headers.
  app.use(requestContext(logger));
  app.use(securityHeaders());

  // Liveness is mounted before rate limiting and CORS so probes are never throttled.
  app.use(healthRoutes(createHealthService({ clock, startedAt, version: env.APP_VERSION })));

  app.use(corsPolicy(env.WEB_ORIGIN));
  app.use(globalRateLimit(env.RATE_LIMIT_GLOBAL_PER_MINUTE));
  if (checkDatabase) {
    app.use(readinessRoutes(createReadinessService({ checkDatabase, logger })));
  }
  app.use(requireTrustedOrigin(env.WEB_ORIGIN));
  app.use(requireJsonBody);
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/v1', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
