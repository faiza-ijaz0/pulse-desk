import {
  createInvitationRequestSchema,
  invitationParamsSchema,
  invitationTokenRequestSchema,
  registerWithInvitationRequestSchema,
} from '@pulsedesk/shared';
import type { RequestHandler, Response } from 'express';
import { authOf, requestMeta, tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { Clock } from '../../lib/clock.ts';
import type { IssuedSession } from '../auth/auth.service.ts';
import { setSessionCookie, type SessionCookieConfig } from '../auth/session-cookie.ts';
import type { InvitationsService } from './invitations.service.ts';

export function createInvitationsController(deps: {
  service: InvitationsService;
  cookie: SessionCookieConfig;
  clock: Clock;
}) {
  const { service, cookie, clock } = deps;

  function sendIssued(res: Response, status: number, issued: IssuedSession): void {
    setSessionCookie(res, cookie, issued.token, issued.expiresAt, clock.now());
    res.status(status).json(issued.session);
  }

  const list: RequestHandler = async (req, res) => {
    res.json({ data: await service.list(tenantOf(req)) });
  };

  const create: RequestHandler = async (req, res) => {
    const input = parseRequest('body', createInvitationRequestSchema, req.body);
    // The token is in this response only; never cache it anywhere on the way.
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await service.create(tenantOf(req), input, requestMeta(req)));
  };

  const revoke: RequestHandler = async (req, res) => {
    const { invitationId } = parseRequest('params', invitationParamsSchema, req.params);
    await service.revoke(tenantOf(req), invitationId, requestMeta(req));
    res.status(204).end();
  };

  const preview: RequestHandler = async (req, res) => {
    const { token } = parseRequest('body', invitationTokenRequestSchema, req.body);
    res.json(await service.preview(token));
  };

  const accept: RequestHandler = async (req, res) => {
    const { token } = parseRequest('body', invitationTokenRequestSchema, req.body);
    sendIssued(res, 200, await service.accept(authOf(req), token, requestMeta(req)));
  };

  const register: RequestHandler = async (req, res) => {
    const input = parseRequest('body', registerWithInvitationRequestSchema, req.body);
    sendIssued(res, 201, await service.register(input, requestMeta(req)));
  };

  return { list, create, revoke, preview, accept, register };
}
