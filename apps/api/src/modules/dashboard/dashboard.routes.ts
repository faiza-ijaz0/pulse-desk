import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createDashboardController } from './dashboard.controller.ts';

/**
 * Mounted behind requireTenant. `analytics:read-own` is the coarse check every role passes;
 * the service then narrows the scope to the caller's own tickets unless they also hold
 * `analytics:read-all`.
 */
export function dashboardRoutes(
  controller: ReturnType<typeof createDashboardController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get(
    '/dashboard',
    requireTenant,
    requirePermission('analytics:read-own'),
    controller.summary,
  );
  return router;
}
