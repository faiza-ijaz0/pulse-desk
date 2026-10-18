import { describe, expect, it } from 'vitest';
import { loginRequestSchema, registerRequestSchema } from './auth.ts';

const valid = {
  name: '  Ada Lovelace ',
  email: '  Ada@Example.COM ',
  password: 'correct horse battery',
  organizationName: ' Analytical Engines ',
};

describe('registerRequestSchema', () => {
  it('normalizes email and trims names', () => {
    expect(registerRequestSchema.parse(valid)).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse battery',
      organizationName: 'Analytical Engines',
    });
  });

  it('keeps passwords exactly as typed', () => {
    const parsed = registerRequestSchema.parse({ ...valid, password: '  spaced out pass  ' });
    expect(parsed.password).toBe('  spaced out pass  ');
  });

  it('enforces the 12–128 character password policy', () => {
    expect(registerRequestSchema.safeParse({ ...valid, password: 'a'.repeat(11) }).success).toBe(
      false,
    );
    expect(registerRequestSchema.safeParse({ ...valid, password: 'a'.repeat(12) }).success).toBe(
      true,
    );
    expect(registerRequestSchema.safeParse({ ...valid, password: 'a'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('rejects a password equal to the account email', () => {
    const result = registerRequestSchema.safeParse({
      ...valid,
      email: 'someone.long@example.com',
      password: 'Someone.Long@example.com',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['password']);
  });

  it('rejects malformed emails and blank names', () => {
    expect(registerRequestSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(
      false,
    );
    expect(registerRequestSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...valid, organizationName: 'x' }).success).toBe(
      false,
    );
  });

  it('strips unknown keys such as a client-chosen role or organization ID', () => {
    const parsed = registerRequestSchema.parse({
      ...valid,
      role: 'OWNER',
      organizationId: '3f0e6a52-1d7c-4f0e-9a39-5a0a5f7c2b11',
    });
    expect(parsed).not.toHaveProperty('role');
    expect(parsed).not.toHaveProperty('organizationId');
  });
});

describe('loginRequestSchema', () => {
  it('does not apply the registration password policy', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'a@example.com', password: 'short' }).success,
    ).toBe(true);
  });

  it('bounds password length', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'a@example.com', password: 'a'.repeat(129) }).success,
    ).toBe(false);
  });
});
