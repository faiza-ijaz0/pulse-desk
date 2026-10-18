import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createOrganizationsController } from './organizations.controller.ts';

/** Mounted behind requireTenant: every route acts on the session's active organization. */
export function organizationsRoutes(
  controller: ReturnType<typeof createOrganizationsController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get('/organization', requireTenant, controller.getCurrent);
  router.patch(
    '/organization',
    requireTenant,
    requirePermission('organization:update'),
    controller.update,
  );
  return router;
}
