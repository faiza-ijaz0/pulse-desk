import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createTicketsController } from './tickets.controller.ts';

/** Mounted behind requireTenant: tickets always belong to the session's active organization. */
export function ticketsRoutes(
  controller: ReturnType<typeof createTicketsController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get('/tickets', requireTenant, requirePermission('ticket:read'), controller.list);
  router.get('/tickets/:number', requireTenant, requirePermission('ticket:read'), controller.get);
  // Working a ticket (opening, updating, replying) needs `ticket:reply`; assignment fields
  // additionally need `ticket:assign` (tickets.policy.ts). No settings permission is
  // involved: tickets endpoints only reference existing tags, teams and members.
  router.post('/tickets', requireTenant, requirePermission('ticket:reply'), controller.create);
  router.patch(
    '/tickets/:number',
    requireTenant,
    requirePermission('ticket:reply'),
    controller.update,
  );
  router.post(
    '/tickets/:number/messages',
    requireTenant,
    requirePermission('ticket:reply'),
    controller.addMessage,
  );
  return router;
}
