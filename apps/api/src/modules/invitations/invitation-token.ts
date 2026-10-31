import { createHmac } from 'node:crypto';

export { generateSessionToken as generateInvitationToken } from '../auth/session-token.ts';

/**
 * Only this HMAC is stored, like a session token's. The `invitation:` prefix separates the two
 * uses of SESSION_SECRET, so a session token's hash can never match an invitation's.
 */
export function hashInvitationToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(`invitation:${token}`).digest('hex');
}
