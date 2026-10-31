import type { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { sendProblem } from '../problem.ts';

// All limiters use the in-process memory store, which is correct for a single API instance.
// A Redis store replaces it when Redis is introduced (see docs/architecture/overview.md) so
// limits hold across instances. Client IPs come from `req.ip`, which honours TRUST_PROXY_HOPS.

function rateLimitedProblem(req: Request, res: Response): void {
  sendProblem(req, res, {
    status: 429,
    code: 'RATE_LIMITED',
    title: 'Too many requests',
    detail: 'Request rate limit exceeded. Retry after the time given in the RateLimit headers.',
  });
}

/** Per-client-IP request budget for the whole API. */
export function globalRateLimit(limitPerMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitedProblem,
  });
}

const AUTH_WINDOW_MS = 15 * 60_000;

/** The normalized `email` field of a JSON body, if there is one. */
function bodyEmail(req: Request): string | undefined {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || !('email' in body)) return undefined;
  const email = body.email;
  return typeof email === 'string' && email.trim() !== '' ? email.trim().toLowerCase() : undefined;
}

/**
 * Brute-force protection for credential endpoints (docs/architecture/auth-and-sessions.md §8):
 *  - `login`: failed attempts per client IP **and** per target email, so neither rotating
 *    emails from one address nor spreading one email over many addresses gets more guesses.
 *    Successful sign-ins don't count, so a user who signs in normally is never locked out.
 *  - `register`: every attempt per client IP, which bounds account creation and email probing.
 * Each call creates fresh stores, so separate app instances (and tests) don't share budgets.
 */
export function authRateLimits(limitPer15Minutes: number) {
  const common = {
    windowMs: AUTH_WINDOW_MS,
    limit: limitPer15Minutes,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitedProblem,
  } as const;

  return {
    login: [
      rateLimit({ ...common, identifier: 'login-ip', skipSuccessfulRequests: true }),
      rateLimit({
        ...common,
        identifier: 'login-email',
        skipSuccessfulRequests: true,
        skip: (req) => bodyEmail(req) === undefined,
        keyGenerator: (req) => `email:${bodyEmail(req) ?? ''}`,
      }),
    ],
    register: [rateLimit({ ...common, identifier: 'register-ip' })],
    // Invitation links (preview, accept, sign-up): only failures count, so an invitee is never
    // locked out while anyone probing tokens is slowed down. Tokens are 256-bit; this is
    // defence in depth, not what keeps them secret.
    invitation: [
      rateLimit({ ...common, identifier: 'invitation-ip', skipSuccessfulRequests: true }),
    ],
  };
}
