import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createMembersController } from './members.controller.ts';

/** Mounted behind requireTenant: members always belong to the session's active organization. */
export function membersRoutes(
  controller: ReturnType<typeof createMembersController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get('/members', requireTenant, requirePermission('member:read'), controller.list);
  router.patch(
    '/members/:userId',
    requireTenant,
    requirePermission('member:change-role'),
    controller.changeRole,
  );
  router.delete(
    '/members/:userId',
    requireTenant,
    requirePermission('member:remove'),
    controller.remove,
  );
  return router;
}
