import { describe, expect, it } from 'vitest';
import { slugify } from './auth.service.ts';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from './password.ts';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.ts';

describe('password hashing', () => {
  it('produces Argon2id hashes with the OWASP minimum parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('correct horse');
    expect(needsRehash(hash)).toBe(false);
  });

  it('verifies only the original password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password twice')).not.toBe(
      await hashPassword('same password twice'),
    );
  });

  it('treats malformed or legacy hashes as non-matching and due for rehash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('runs a dummy verification without throwing', async () => {
    await expect(verifyAgainstDummy('whatever')).resolves.toBeUndefined();
  });
});

describe('session tokens', () => {
  it('are 256-bit base64url strings, unique per call', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateSessionToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(isWellFormedSessionToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('are stored as a keyed HMAC-SHA-256, never in the clear', () => {
    const secretA = 'secret-a'.padEnd(32, '!');
    const token = generateSessionToken();
    const digest = hashSessionToken(secretA, token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(hashSessionToken(secretA, token)).toBe(digest);
    // A different server secret yields an unrelated digest.
    expect(hashSessionToken('secret-b'.padEnd(32, '!'), token)).not.toBe(digest);
  });

  it('rejects malformed tokens before any lookup', () => {
    for (const bad of ['', 'short', 'x'.repeat(44), `${'a'.repeat(42)}=`, `' OR 1=1 --`]) {
      expect(isWellFormedSessionToken(bad)).toBe(false);
    }
  });
});

describe('slugify', () => {
  it('builds a URL-safe slug with a random suffix', () => {
    expect(slugify('  Acme Support, Inc.  ')).toMatch(/^acme-support-inc-[0-9a-f]{6}$/);
    expect(slugify('Café Crème')).toMatch(/^cafe-creme-[0-9a-f]{6}$/);
    expect(slugify('支持团队')).toMatch(/^org-[0-9a-f]{6}$/);
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(47);
  });
});
