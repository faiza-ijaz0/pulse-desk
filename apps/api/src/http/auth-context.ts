import type { Role, SessionUser } from '@pulsedesk/shared';
import type { Request } from 'express';

/** The validated session behind a request. Built only by the authenticate middleware. */
export type AuthContext = {
  sessionId: string;
  user: SessionUser;
  /** The organization the session points at. Not yet checked against current membership. */
  activeOrganizationId: string | null;
  expiresAt: Date;
};

/**
 * Who is acting, in which organization, with which role — derived server-side from the
 * session and a membership row loaded on this request, never from client input
 * (docs/architecture/data-model.md, isolation layer 1). Services take this, not `req`.
 */
export type TenantContext = {
  organizationId: string;
  userId: string;
  role: Role;
  requestId: string;
};

/** Request facts that services record in the audit log and on sessions. */
export type RequestMeta = {
  requestId: string;
  ipAddress: string | undefined;
  userAgent: string | undefined;
};

// Keyed by the request object, so contexts can't leak between requests and need no
// global type augmentation of Express.
const authByRequest = new WeakMap<Request, AuthContext>();
const tenantByRequest = new WeakMap<Request, TenantContext>();

export function setAuth(req: Request, auth: AuthContext): void {
  authByRequest.set(req, auth);
}

export function getAuth(req: Request): AuthContext | undefined {
  return authByRequest.get(req);
}

export function setTenant(req: Request, tenant: TenantContext): void {
  tenantByRequest.set(req, tenant);
}

export function getTenant(req: Request): TenantContext | undefined {
  return tenantByRequest.get(req);
}

/** For handlers mounted behind requireAuth; a missing context is a wiring bug, not a 401. */
export function authOf(req: Request): AuthContext {
  const auth = authByRequest.get(req);
  if (!auth) throw new Error('authOf() used on a route without requireAuth');
  return auth;
}

/** For handlers mounted behind requireTenant; a missing context is a wiring bug. */
export function tenantOf(req: Request): TenantContext {
  const tenant = tenantByRequest.get(req);
  if (!tenant) throw new Error('tenantOf() used on a route without requireTenant');
  return tenant;
}

export function requestMeta(req: Request): RequestMeta {
  return {
    // requestContext always assigns a string ID; the fallback only guards misconfiguration.
    requestId: typeof req.id === 'string' ? req.id : 'unknown',
    ipAddress: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 512),
  };
}
