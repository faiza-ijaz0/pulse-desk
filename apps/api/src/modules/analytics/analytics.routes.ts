import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createAnalyticsController } from './analytics.controller.ts';

/**
 * Mounted behind requireTenant. `analytics:read-own` is the coarse check every role passes;
 * the service then narrows the scope to the caller's own tickets and actions unless they
 * also hold `analytics:read-all`.
 */
export function analyticsRoutes(
  controller: ReturnType<typeof createAnalyticsController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get(
    '/analytics',
    requireTenant,
    requirePermission('analytics:read-own'),
    controller.report,
  );
  return router;
}
