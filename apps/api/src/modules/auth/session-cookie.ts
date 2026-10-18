import type { CookieOptions, Request, Response } from 'express';
import type { Env } from '../../config/env.ts';

export type SessionCookieConfig = {
  name: string;
  secure: boolean;
};

export function sessionCookieConfig(env: Env): SessionCookieConfig {
  return { name: env.SESSION_COOKIE_NAME, secure: env.SESSION_COOKIE_SECURE };
}

/**
 * HttpOnly (no JavaScript access), SameSite=Lax (not sent on cross-site sub-requests),
 * host-only (no Domain) and Path=/ — the shape the `__Host-` prefix requires in production.
 * See docs/architecture/auth-and-sessions.md §4.
 */
function baseOptions(config: SessionCookieConfig): CookieOptions {
  return { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/' };
}

export function setSessionCookie(
  res: Response,
  config: SessionCookieConfig,
  token: string,
  expiresAt: Date,
  now: Date,
): void {
  res.cookie(config.name, token, {
    ...baseOptions(config),
    maxAge: Math.max(0, expiresAt.getTime() - now.getTime()),
  });
}

export function clearSessionCookie(res: Response, config: SessionCookieConfig): void {
  res.clearCookie(config.name, baseOptions(config));
}

/** Reads one cookie from the Cookie header without pulling in a parser dependency. */
export function readSessionCookie(req: Request, config: SessionCookieConfig): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== config.name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
