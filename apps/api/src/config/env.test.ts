import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SESSION_SECRET, parseEnv } from './env.ts';

const base = {
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/pulsedesk',
  SESSION_SECRET: 'a-test-secret-that-is-long-enough-1234567890',
};

const production = {
  ...base,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://app.pulsedesk.example',
  SESSION_COOKIE_NAME: '__Host-pd_sid',
  SESSION_COOKIE_SECURE: 'true',
};

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const result = parseEnv(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env).toMatchObject({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      TRUST_PROXY_HOPS: 0,
      WEB_ORIGIN: ['http://localhost:5173'],
      SESSION_COOKIE_NAME: 'pd_sid',
      SESSION_COOKIE_SECURE: false,
      SESSION_IDLE_TIMEOUT_MINUTES: 720,
      SESSION_ABSOLUTE_TIMEOUT_DAYS: 14,
      RATE_LIMIT_AUTH_PER_15_MINUTES: 10,
    });
  });

  it('treats empty values as unset', () => {
    const result = parseEnv({ ...base, API_PORT: '' });
    expect(result.ok && result.env.API_PORT).toBe(4000);
  });

  it('parses a comma-separated origin allowlist', () => {
    const result = parseEnv({
      ...base,
      WEB_ORIGIN: 'http://localhost:5173, http://127.0.0.1:5173',
    });
    expect(result.ok && result.env.WEB_ORIGIN).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('reports every problem at once, by variable name', () => {
    const result = parseEnv({
      DATABASE_URL: base.DATABASE_URL,
      SESSION_SECRET: base.SESSION_SECRET,
      API_PORT: '99999',
      LOG_LEVEL: 'loud',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^WEB_ORIGIN is required/),
        expect.stringMatching(/^API_PORT /),
        expect.stringMatching(/^LOG_LEVEL /),
      ]),
    );
  });

  it('distinguishes a malformed value from a missing one', () => {
    const result = parseEnv({ ...base, API_PORT: 'abc' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^API_PORT /);
    expect(result.problems[0]).not.toMatch(/is required/);
  });

  it('rejects origins with paths', () => {
    const result = parseEnv({ ...base, WEB_ORIGIN: 'http://localhost:5173/app' });
    expect(result.ok).toBe(false);
  });

  it('requires https origins in production', () => {
    const result = parseEnv({ ...production, WEB_ORIGIN: 'http://app.pulsedesk.example' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join()).toMatch(/WEB_ORIGIN must use https in production/);

    expect(parseEnv(production).ok).toBe(true);
  });

  it('never echoes supplied values in problem messages', () => {
    const result = parseEnv({ ...base, RATE_LIMIT_GLOBAL_PER_MINUTE: 'secret-looking-value' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join()).not.toContain('secret-looking-value');
  });

  it('requires a database URL and a session secret of at least 32 characters', () => {
    const result = parseEnv({ WEB_ORIGIN: base.WEB_ORIGIN, SESSION_SECRET: 'too-short' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^DATABASE_URL is required/),
        expect.stringMatching(/^SESSION_SECRET must be at least 32 characters/),
      ]),
    );
  });

  it('accepts the placeholder session secret only in development', () => {
    expect(parseEnv({ ...base, SESSION_SECRET: PLACEHOLDER_SESSION_SECRET }).ok).toBe(true);

    for (const NODE_ENV of ['test', 'production']) {
      const result = parseEnv({
        ...production,
        NODE_ENV,
        SESSION_SECRET: PLACEHOLDER_SESSION_SECRET,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.problems.join()).toMatch(/SESSION_SECRET must be replaced/);
    }
  });

  it('refuses to boot production without Secure, __Host- session cookies', () => {
    const insecure = parseEnv({ ...production, SESSION_COOKIE_SECURE: 'false' });
    expect(insecure.ok).toBe(false);
    if (!insecure.ok) {
      expect(insecure.problems.join()).toMatch(/SESSION_COOKIE_SECURE must be true in production/);
    }

    const unprefixed = parseEnv({ ...production, SESSION_COOKIE_NAME: 'pd_sid' });
    expect(unprefixed.ok).toBe(false);
    if (!unprefixed.ok) {
      expect(unprefixed.problems.join()).toMatch(/SESSION_COOKIE_NAME must use the __Host- prefix/);
    }
  });

  it('rejects a __Host- cookie name without the Secure flag in any environment', () => {
    expect(parseEnv({ ...base, SESSION_COOKIE_NAME: '__Host-pd_sid' }).ok).toBe(false);
  });

  it('parses boolean flags strictly', () => {
    expect(parseEnv({ ...base, SESSION_COOKIE_SECURE: 'yes' }).ok).toBe(false);
    const result = parseEnv({ ...base, SESSION_COOKIE_SECURE: 'true' });
    expect(result.ok && result.env.SESSION_COOKIE_SECURE).toBe(true);
  });

  it('never echoes the session secret or database URL', () => {
    const result = parseEnv({
      ...base,
      DATABASE_URL: 'mysql://root:hunter2-db-password@db',
      SESSION_SECRET: 'short-but-secret',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join()).not.toContain('hunter2-db-password');
    expect(result.problems.join()).not.toContain('short-but-secret');
  });
});
