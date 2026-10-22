import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ForbiddenError } from '../errors.ts';

/**
 * Set by the reverse proxy on every request it forwards (apps/web/vercel.json and the Vite
 * dev/preview proxy). The proxy overwrites any copy the client sent. Redacted from logs.
 */
export const PROXY_SECRET_HEADER = 'x-pulsedesk-proxy-secret';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Rejects requests that did not come through the trusted proxy (docs/deployment.md), so
 * the API host can't be called directly to bypass it. Both values are hashed first:
 * timingSafeEqual needs equal lengths, and comparing digests doesn't reveal the length.
 * The 403 is deliberately generic and never says which header is missing.
 */
export function requireProxySecret(secret: string): RequestHandler {
  const expected = digest(secret);
  return (req, _res, next) => {
    // Node joins repeated custom headers into one string, so a client-supplied copy that a
    // proxy appended to (instead of replacing) fails the comparison.
    const supplied = req.headers[PROXY_SECRET_HEADER];
    const valid = typeof supplied === 'string' && timingSafeEqual(digest(supplied), expected);
    next(valid ? undefined : new ForbiddenError());
  };
}
