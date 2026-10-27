import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createCustomersController } from './customers.controller.ts';

/** Mounted behind requireTenant: customers always belong to the session's active organization. */
export function customersRoutes(
  controller: ReturnType<typeof createCustomersController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get('/customers', requireTenant, requirePermission('ticket:read'), controller.list);
  router.get(
    '/customers/:customerId',
    requireTenant,
    requirePermission('ticket:read'),
    controller.get,
  );
  router.patch(
    '/customers/:customerId',
    requireTenant,
    requirePermission('customer:update'),
    controller.update,
  );
  return router;
}
