import express, { Router, type Express } from 'express';
import type { Env } from './config/env.ts';
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.ts';
import { requireJsonBody, requireTrustedOrigin } from './http/middleware/origin-check.ts';
import { globalRateLimit } from './http/middleware/rate-limit.ts';
import { requestContext } from './http/middleware/request-context.ts';
import { corsPolicy, securityHeaders } from './http/middleware/security.ts';
import type { Logger } from './lib/logger.ts';
import { createHealthService, type Clock } from './modules/health/health.service.ts';
import { healthRoutes } from './modules/health/health.routes.ts';

export type AppDependencies = {
  env: Env;
  logger: Logger;
  clock?: Clock;
  startedAt?: Date;
  /**
   * Feature routers mounted under `/api/v1`. Empty until Phase 3 adds the first
   * feature module; injectable so tests can exercise the full middleware stack.
   */
  apiRouter?: Router;
};

/** Builds the Express app without listening, so tests and the server share one composition. */
export function createApp({
  env,
  logger,
  clock = { now: () => new Date() },
  startedAt = clock.now(),
  apiRouter = Router(),
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
