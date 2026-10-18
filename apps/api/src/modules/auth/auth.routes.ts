import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../../http/middleware/authenticate.ts';
import type { createAuthController } from './auth.controller.ts';

export function authRoutes(
  controller: ReturnType<typeof createAuthController>,
  limits: { login: RequestHandler[]; register: RequestHandler[] },
): Router {
  const router = Router();
  router.post('/auth/register', ...limits.register, controller.register);
  router.post('/auth/login', ...limits.login, controller.login);
  router.post('/auth/logout', controller.logout);
  router.get('/auth/session', requireAuth, controller.session);
  router.post('/auth/active-organization', requireAuth, controller.switchOrganization);
  return router;
}
