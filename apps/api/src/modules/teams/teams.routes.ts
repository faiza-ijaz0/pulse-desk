import { Router, type RequestHandler } from 'express';
import { requirePermission } from '../../http/middleware/authenticate.ts';
import type { createTeamsController } from './teams.controller.ts';

/**
 * Anyone who works tickets can list teams (to filter and assign); creating, renaming,
 * deleting and staffing teams needs `team:manage` (admins and owners).
 */
export function teamsRoutes(
  controller: ReturnType<typeof createTeamsController>,
  requireTenant: RequestHandler,
): Router {
  const router = Router();
  const manage = [requireTenant, requirePermission('team:manage')];
  router.get('/teams', requireTenant, requirePermission('ticket:read'), controller.list);
  router.post('/teams', ...manage, controller.create);
  router.patch('/teams/:teamId', ...manage, controller.rename);
  router.delete('/teams/:teamId', ...manage, controller.remove);
  router.put('/teams/:teamId/members/:userId', ...manage, controller.addMember);
  router.delete('/teams/:teamId/members/:userId', ...manage, controller.removeMember);
  return router;
}
