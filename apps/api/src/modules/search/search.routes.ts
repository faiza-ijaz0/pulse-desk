import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createSearchController } from './search.controller.ts';

/** Mounted behind requireTenant: search only ever sees the active organization. */
export function searchRoutes(
  controller: ReturnType<typeof createSearchController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get('/search', requireTenant, requirePermission('ticket:read'), controller.search);
  return router;
}
