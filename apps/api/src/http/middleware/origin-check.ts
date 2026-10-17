import type { RequestHandler } from 'express';
import { AppError } from '../errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defense for cookie-authenticated requests (docs/architecture/auth-and-sessions.md §5).
 * State-changing requests must come from an allowlisted Origin (falling back to Referer).
 * Requests that carry neither header are rejected: browsers always send one of them on
 * cross-site POSTs, and non-browser clients do not use session cookies.
 */
export function requireTrustedOrigin(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = originOf(req.get('origin')) ?? originOf(req.get('referer'));
    if (origin !== undefined && allowed.has(origin)) {
      next();
      return;
    }
    next(
      new AppError({
        status: 403,
        code: 'CSRF_ORIGIN_MISMATCH',
        title: 'Untrusted request origin',
        detail: 'State-changing requests must originate from the PulseDesk web app.',
      }),
    );
  };
}

/** Mutating requests that carry a body must be JSON, which blocks simple cross-site form posts. */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  const hasBody =
    Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (SAFE_METHODS.has(req.method) || !hasBody || req.is('application/json')) {
    next();
    return;
  }
  next(
    new AppError({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      title: 'Unsupported media type',
      detail: 'Request bodies must be sent as application/json.',
    }),
  );
};
