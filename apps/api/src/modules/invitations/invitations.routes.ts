import { Router, type RequestHandler } from 'express';
import { requireAuth, requirePermission } from '../../http/middleware/authenticate.ts';
import type { createInvitationsController } from './invitations.controller.ts';

/**
 * Managing invitations acts on the session's active organization (`member:invite`: owners and
 * admins). The link's own steps are keyed by its token, sent in the body: preview and sign-up
 * are public, accepting needs a session. All three are rate limited by failures.
 */
export function invitationsRoutes(
  controller: ReturnType<typeof createInvitationsController>,
  requireTenant: RequestHandler,
  limits: { invitation: RequestHandler[]; register: RequestHandler[] },
): Router {
  const router = Router();
  const manage = [requireTenant, requirePermission('member:invite')];
  router.get('/invitations', ...manage, controller.list);
  router.post('/invitations', ...manage, controller.create);
  router.delete('/invitations/:invitationId', ...manage, controller.revoke);
  router.post('/invitations/preview', ...limits.invitation, controller.preview);
  router.post('/invitations/accept', ...limits.invitation, requireAuth, controller.accept);
  router.post(
    '/invitations/register',
    ...limits.invitation,
    ...limits.register,
    controller.register,
  );
  return router;
}
