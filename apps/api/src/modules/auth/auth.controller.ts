import {
  loginRequestSchema,
  registerRequestSchema,
  switchOrganizationRequestSchema,
} from '@pulsedesk/shared';
import type { RequestHandler, Response } from 'express';
import { authOf, requestMeta } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { Clock } from '../../lib/clock.ts';
import type { AuthService, IssuedSession } from './auth.service.ts';
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  type SessionCookieConfig,
} from './session-cookie.ts';

export function createAuthController(deps: {
  service: AuthService;
  cookie: SessionCookieConfig;
  clock: Clock;
}) {
  const { service, cookie, clock } = deps;

  function sendIssued(res: Response, status: number, issued: IssuedSession): void {
    setSessionCookie(res, cookie, issued.token, issued.expiresAt, clock.now());
    res.status(status).json(issued.session);
  }

  const register: RequestHandler = async (req, res) => {
    const input = parseRequest('body', registerRequestSchema, req.body);
    sendIssued(res, 201, await service.register(input, requestMeta(req)));
  };

  const login: RequestHandler = async (req, res) => {
    const input = parseRequest('body', loginRequestSchema, req.body);
    const issued = await service.login(input, requestMeta(req), readSessionCookie(req, cookie));
    sendIssued(res, 200, issued);
  };

  const logout: RequestHandler = async (req, res) => {
    await service.logout(readSessionCookie(req, cookie));
    clearSessionCookie(res, cookie);
    res.status(204).end();
  };

  const session: RequestHandler = async (req, res) => {
    res.json(await service.getSession(authOf(req)));
  };

  const switchOrganization: RequestHandler = async (req, res) => {
    const { organizationId } = parseRequest('body', switchOrganizationRequestSchema, req.body);
    sendIssued(
      res,
      200,
      await service.switchOrganization(authOf(req), organizationId, requestMeta(req)),
    );
  };

  return { register, login, logout, session, switchOrganization };
}
