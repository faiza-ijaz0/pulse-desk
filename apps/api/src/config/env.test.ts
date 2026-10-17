import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.ts';

const base = { WEB_ORIGIN: 'http://localhost:5173' };

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
    });
  });

  it('treats empty values as unset', () => {
    const result = parseEnv({ ...base, API_PORT: '' });
    expect(result.ok && result.env.API_PORT).toBe(4000);
  });

  it('parses a comma-separated origin allowlist', () => {
    const result = parseEnv({ WEB_ORIGIN: 'http://localhost:5173, http://127.0.0.1:5173' });
    expect(result.ok && result.env.WEB_ORIGIN).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('reports every problem at once, by variable name', () => {
    const result = parseEnv({ API_PORT: '99999', LOG_LEVEL: 'loud' });
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
    const result = parseEnv({ WEB_ORIGIN: 'http://localhost:5173/app' });
    expect(result.ok).toBe(false);
  });

  it('requires https origins in production', () => {
    const result = parseEnv({ ...base, NODE_ENV: 'production' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join()).toMatch(/WEB_ORIGIN must use https in production/);

    expect(
      parseEnv({ NODE_ENV: 'production', WEB_ORIGIN: 'https://app.pulsedesk.example' }).ok,
    ).toBe(true);
  });

  it('never echoes supplied values in problem messages', () => {
    const result = parseEnv({ ...base, RATE_LIMIT_GLOBAL_PER_MINUTE: 'secret-looking-value' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join()).not.toContain('secret-looking-value');
  });
});
