import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createSlaPoliciesController } from './sla-policies.controller.ts';

/**
 * Mounted behind requireTenant: the organization's default SLA policy. Every member may read
 * it (agents see the targets their tickets are held to); changing it needs `sla:manage`.
 */
export function slaPoliciesRoutes(
  controller: ReturnType<typeof createSlaPoliciesController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  router.get('/sla-policy', requireTenant, controller.getDefault);
  router.put('/sla-policy', requireTenant, requirePermission('sla:manage'), controller.saveDefault);
  return router;
}
