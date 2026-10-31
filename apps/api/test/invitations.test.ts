import { describe, expect, it } from 'vitest';
import { InvitationInvalidError } from '../src/http/errors.ts';
import { hashSessionToken } from '../src/modules/auth/session-token.ts';
import {
  generateInvitationToken,
  hashInvitationToken,
} from '../src/modules/invitations/invitation-token.ts';
import {
  invitationProblem,
  type TokenInvitation,
} from '../src/modules/invitations/invitations.repository.ts';

const SECRET = 'unit-test-secret-unit-test-secret';
const NOW = new Date('2026-10-31T12:00:00.000Z');

function invitation(overrides: Partial<TokenInvitation> = {}): TokenInvitation {
  return {
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    organizationName: 'Acme',
    email: 'ada@example.com',
    role: 'AGENT',
    invitedByName: 'Owner',
    expiresAt: new Date(NOW.getTime() + 60_000),
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('invitation tokens', () => {
  it('are 256-bit base64url strings, different every time', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateInvitationToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('are stored as a keyed hash that never equals the token or a session hash', () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(SECRET, token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashInvitationToken(SECRET, token)).toBe(hash);
    expect(hashInvitationToken(`${SECRET}-other`, token)).not.toBe(hash);
    // Domain separation: the same value used as a session token hashes differently.
    expect(hashSessionToken(SECRET, token)).not.toBe(hash);
  });
});

describe('whether an invitation can be accepted', () => {
  it('names why not, checking use before expiry', () => {
    expect(invitationProblem(null, NOW)).toBe('unknown');
    expect(invitationProblem(invitation(), NOW)).toBeNull();
    expect(invitationProblem(invitation({ acceptedAt: NOW }), NOW)).toBe('accepted');
    expect(invitationProblem(invitation({ revokedAt: NOW }), NOW)).toBe('revoked');
    expect(invitationProblem(invitation({ acceptedAt: NOW, expiresAt: new Date(0) }), NOW)).toBe(
      'accepted',
    );
  });

  it('expires at exactly its expiry time', () => {
    expect(
      invitationProblem(invitation({ expiresAt: new Date(NOW.getTime() + 1) }), NOW),
    ).toBeNull();
    expect(invitationProblem(invitation({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(invitationProblem(invitation({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(
      'expired',
    );
  });

  it('explains each problem without revealing anything about accounts', () => {
    for (const problem of ['unknown', 'expired', 'revoked', 'accepted'] as const) {
      const error = new InvitationInvalidError(problem);
      expect(error).toMatchObject({ status: 410, code: 'INVITATION_INVALID' });
      expect(error.detail).not.toMatch(/account|password|@/i);
    }
  });
});
