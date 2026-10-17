import cors from 'cors';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Security headers for a JSON-only API: nothing it returns should ever be rendered,
 * framed or used as a script, so the CSP denies everything.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

/**
 * The web app is served from the same origin in every environment (Vite proxy locally,
 * reverse proxy in production), so CORS is only an allowlisted fallback — never `*`.
 * Disallowed origins simply receive no CORS headers and the browser blocks the response.
 */
export function corsPolicy(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
}
