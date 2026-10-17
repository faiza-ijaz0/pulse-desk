import { rateLimit } from 'express-rate-limit';
import { sendProblem } from '../problem.ts';

/**
 * Per-client-IP request budget. Uses the in-process memory store, which is correct for a
 * single API instance. A Redis store replaces it when Redis is introduced (see
 * docs/architecture/overview.md) so limits hold across instances.
 */
export function globalRateLimit(limitPerMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res) {
      sendProblem(req, res, {
        status: 429,
        code: 'RATE_LIMITED',
        title: 'Too many requests',
        detail: 'Request rate limit exceeded. Retry after the time given in the RateLimit headers.',
      });
    },
  });
}
