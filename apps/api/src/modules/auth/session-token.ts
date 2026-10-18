import { createHmac, randomBytes } from 'node:crypto';

/** 32 random bytes = 256 bits of entropy, base64url-encoded (43 characters). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this HMAC is stored. A database-only leak (backup, SQL injection) yields neither
 * usable tokens nor anything checkable offline without the server secret.
 */
export function hashSessionToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Rejects obviously forged cookies before they cost a database lookup. */
export function isWellFormedSessionToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}
