import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './errors.ts';
import {
  INVITABLE_ROLES,
  INVITATION_TTL_DAYS,
  createInvitationRequestSchema,
  invitationTokenRequestSchema,
  registerWithInvitationRequestSchema,
} from './invitations.ts';

const TOKEN = 'A'.repeat(21) + '_-' + 'z'.repeat(20); // 43 base64url characters

describe('invitation contracts', () => {
  it('normalizes the email and accepts only Admin and Agent', () => {
    expect(
      createInvitationRequestSchema.parse({ email: '  Ada@Example.COM ', role: 'AGENT' }),
    ).toEqual({ email: 'ada@example.com', role: 'AGENT' });
    expect(INVITABLE_ROLES).toEqual(['ADMIN', 'AGENT']);
    for (const role of ['OWNER', 'admin', '', null]) {
      expect(createInvitationRequestSchema.safeParse({ email: 'a@b.co', role }).success).toBe(
        false,
      );
    }
    for (const email of ['', 'not-an-email', 'a@', `${'a'.repeat(250)}@b.co`]) {
      expect(createInvitationRequestSchema.safeParse({ email, role: 'AGENT' }).success).toBe(false);
    }
  });

  it('never takes an organization from the request', () => {
    const parsed = createInvitationRequestSchema.parse({
      email: 'a@b.co',
      role: 'ADMIN',
      organizationId: crypto.randomUUID(),
    });
    expect(parsed).toEqual({ email: 'a@b.co', role: 'ADMIN' });
  });

  it('accepts only well-formed tokens, so junk never reaches the database', () => {
    expect(invitationTokenRequestSchema.safeParse({ token: TOKEN }).success).toBe(true);
    for (const token of [
      '',
      TOKEN.slice(1),
      `${TOKEN}a`,
      `${TOKEN.slice(1)}=`,
      `${TOKEN.slice(1)}/`,
      42,
    ]) {
      expect(invitationTokenRequestSchema.safeParse({ token }).success).toBe(false);
    }
  });

  it('signs up with a name and password only: the email is the invitation’s', () => {
    const parsed = registerWithInvitationRequestSchema.parse({
      token: TOKEN,
      name: ' Ada ',
      password: 'correct horse battery',
      email: 'someone-else@example.com',
    });
    expect(parsed).toEqual({ token: TOKEN, name: 'Ada', password: 'correct horse battery' });
    expect(
      registerWithInvitationRequestSchema.safeParse({
        token: TOKEN,
        name: 'Ada',
        password: 'short',
      }).success,
    ).toBe(false);
  });

  it('expires after seven days and has stable error codes', () => {
    expect(INVITATION_TTL_DAYS).toBe(7);
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining(['ALREADY_MEMBER', 'INVITATION_INVALID', 'INVITATION_EMAIL_MISMATCH']),
    );
  });
});
