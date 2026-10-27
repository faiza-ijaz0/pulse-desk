import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createTagsController } from './tags.controller.ts';

/**
 * Anyone who works tickets can list tags (to filter and tag tickets); managing the tag
 * list needs `tag:manage` (admins and owners).
 */
export function tagsRoutes(
  controller: ReturnType<typeof createTagsController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  const manage = [requireTenant, requirePermission('tag:manage')];
  router.get('/tags', requireTenant, requirePermission('ticket:read'), controller.list);
  router.post('/tags', ...manage, controller.create);
  router.patch('/tags/:tagId', ...manage, controller.update);
  router.delete('/tags/:tagId', ...manage, controller.remove);
  return router;
}
