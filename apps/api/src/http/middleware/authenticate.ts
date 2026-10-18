import { hasPermission, type Permission } from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import type { AuthService } from '../../modules/auth/auth.service.ts';
import {
  clearSessionCookie,
  readSessionCookie,
  type SessionCookieConfig,
} from '../../modules/auth/session-cookie.ts';
import { getAuth, getTenant, requestMeta, setAuth, setTenant } from '../auth-context.ts';
import { ForbiddenError, UnauthenticatedError } from '../errors.ts';

/**
 * Resolves the session cookie (if any) into an AuthContext. It never rejects on its own —
 * requireAuth / requireTenant decide that — but it clears a cookie whose session is no
 * longer valid, so the browser stops sending it.
 */
export function authenticate(
  authService: AuthService,
  cookie: SessionCookieConfig,
): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionCookie(req, cookie);
    if (token === undefined) {
      next();
      return;
    }
    const auth = await authService.authenticate(token);
    if (auth) {
      setAuth(req, auth);
      req.log = req.log.child({ userId: auth.user.id });
    } else {
      clearSessionCookie(res, cookie);
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(getAuth(req) ? undefined : new UnauthenticatedError());
};

/**
 * Requires a signed-in user with a current membership in the session's active
 * organization, and exposes it as the request's TenantContext.
 */
export function requireTenant(authService: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const auth = getAuth(req);
    if (!auth) {
      next(new UnauthenticatedError());
      return;
    }
    const tenant = await authService.resolveTenant(auth, requestMeta(req).requestId);
    setTenant(req, tenant);
    req.log = req.log.child({ organizationId: tenant.organizationId });
    next();
  };
}

/** Coarse role check (docs/architecture/auth-and-sessions.md §6). Mount after requireTenant. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const tenant = getTenant(req);
    if (!tenant) {
      next(new UnauthenticatedError());
      return;
    }
    next(
      hasPermission(tenant.role, permission)
        ? undefined
        : new ForbiddenError('Your role in this organization does not allow this action.'),
    );
  };
}
