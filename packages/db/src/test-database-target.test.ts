import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceEnv } from './env.ts';
import {
  UnsafeTestDatabaseError,
  assertSafeTestDatabase,
  describeTarget,
  type TestDatabaseCheck,
} from './test-database-target.ts';

// Placeholder credentials: nothing here ever connects.
const DEV = 'postgresql://dev:dev-secret@localhost:5433/pulsedesk';
const TEST = 'postgresql://dev:dev-secret@localhost:5433/pulsedesk_test';

function check(
  env: Record<string, string | undefined>,
  options?: TestDatabaseCheck,
): ReturnType<typeof assertSafeTestDatabase> {
  return assertSafeTestDatabase(env, options);
}

function refusal(env: Record<string, string | undefined>, options?: TestDatabaseCheck): string {
  try {
    check(env, options);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeTestDatabaseError);
    return (error as Error).message;
  }
  throw new Error('expected the database to be refused');
}

describe('assertSafeTestDatabase — accepted targets', () => {
  it('accepts the local pulsedesk_test database and describes it without credentials', () => {
    const result = check({ DATABASE_URL: DEV, TEST_DATABASE_URL: TEST });
    expect(result.url).toBe(TEST);
    expect(result.target).toEqual({ host: 'localhost', port: 5433, database: 'pulsedesk_test' });
    expect(describeTarget(result.target)).toBe('localhost:5433/pulsedesk_test');
    expect(JSON.stringify(result.target)).not.toContain('dev-secret');
  });

  it.each(['localhost', '127.0.0.1', '[::1]', 'LOCALHOST'])('accepts host %s', (host) => {
    const url = `postgresql://u:p@${host}:5433/pulsedesk_test`;
    expect(check({ DATABASE_URL: DEV, TEST_DATABASE_URL: url }).url).toBe(url);
  });

  it('accepts the postgres:// scheme', () => {
    const result = check({
      DATABASE_URL: DEV,
      TEST_DATABASE_URL: 'postgres://u:p@localhost:5432/pulsedesk_test',
    });
    expect(result.target.port).toBe(5432);
  });

  it.each(['1', '5432', '5433', '65535', '05433'])('accepts the explicit port %s', (port) => {
    const url = `postgresql://u:p@localhost:${port}/pulsedesk_test`;
    expect(check({ DATABASE_URL: DEV, TEST_DATABASE_URL: url }).target.port).toBe(Number(port));
  });

  it('accepts query parameters that cannot change the target', () => {
    const url = `${TEST}?schema=public&sslmode=disable&connect_timeout=5&connection_limit=3`;
    expect(check({ DATABASE_URL: DEV, TEST_DATABASE_URL: url }).url).toBe(url);
  });

  it('accepts a percent-encoded name that decodes to pulsedesk_test', () => {
    const url = 'postgresql://u:p@localhost:5433/pulsedesk%5Ftest';
    expect(check({ DATABASE_URL: DEV, TEST_DATABASE_URL: url }).target.database).toBe(
      'pulsedesk_test',
    );
  });

  it('accepts a development database on another server', () => {
    const dev = 'postgresql://u:p@ep-example.neon.tech:5432/neondb?sslmode=require';
    expect(check({ DATABASE_URL: dev, TEST_DATABASE_URL: TEST }).url).toBe(TEST);
  });
});

describe('assertSafeTestDatabase — explicit ports', () => {
  // pg and the Prisma engine fill a missing port from the environment (PGPORT) or a default,
  // so a missing port can't be compared reliably.
  it('refuses a TEST_DATABASE_URL without a port', () => {
    const url = 'postgresql://u:p@localhost/pulsedesk_test';
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(
      /TEST_DATABASE_URL must specify its port explicitly/,
    );
  });

  it('refuses a DATABASE_URL without a port, even on another server', () => {
    const dev = 'postgresql://u:p@ep-example.neon.tech/neondb?sslmode=require';
    expect(refusal({ DATABASE_URL: dev, TEST_DATABASE_URL: TEST })).toMatch(
      /DATABASE_URL must specify its port explicitly/,
    );
  });

  it('refuses a port that is empty after the colon', () => {
    const url = 'postgresql://u:p@localhost:/pulsedesk_test';
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(/port explicitly/);
  });

  it.each([
    ['0', /invalid port/],
    ['65536', /not a valid URL|invalid port/],
    ['99999', /not a valid URL|invalid port/],
    ['abc', /not a valid URL/],
    ['-1', /not a valid URL/],
  ])('refuses the port %s', (port, message) => {
    const url = `postgresql://u:p@localhost:${port}/pulsedesk_test`;
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(message);
    expect(refusal({ DATABASE_URL: url, TEST_DATABASE_URL: TEST })).toMatch(message);
  });
});

describe('assertSafeTestDatabase — percent-encoded hostnames', () => {
  // The URL parser keeps "%6Cocalhost" as written; pg decodes it to "localhost".
  it.each(['%6Cocalhost', '%6cocalhost', 'local%68ost', '127.0.0.%31'])(
    'refuses %s in TEST_DATABASE_URL',
    (host) => {
      const url = `postgresql://u:p@${host}:5433/pulsedesk_test`;
      expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(
        /TEST_DATABASE_URL has a percent-encoded hostname/,
      );
    },
  );

  it('refuses an encoded DATABASE_URL host that would hide the test database', () => {
    // pg would reach localhost:5433/pulsedesk_test — the test database itself.
    const dev = 'postgresql://u:p@%6Cocalhost:5433/pulsedesk_test';
    expect(refusal({ DATABASE_URL: dev, TEST_DATABASE_URL: TEST })).toMatch(
      /DATABASE_URL has a percent-encoded hostname/,
    );
  });

  it('refuses an encoded DATABASE_URL host on another server too (fails closed)', () => {
    const dev = 'postgresql://u:p@db%2Eexample.com:5432/pulsedesk';
    expect(refusal({ DATABASE_URL: dev, TEST_DATABASE_URL: TEST })).toMatch(
      /percent-encoded hostname/,
    );
  });

  it('never echoes credentials in the message', () => {
    const dev = 'postgresql://u:hunter2@%6Cocalhost:5433/pulsedesk_test';
    expect(refusal({ DATABASE_URL: dev, TEST_DATABASE_URL: TEST })).not.toContain('hunter2');
  });
});

describe('assertSafeTestDatabase — missing or malformed configuration', () => {
  it('refuses when DATABASE_URL is missing or empty', () => {
    expect(refusal({ TEST_DATABASE_URL: TEST })).toMatch(/DATABASE_URL is not set/);
    expect(refusal({ DATABASE_URL: '  ', TEST_DATABASE_URL: TEST })).toMatch(
      /DATABASE_URL is not set/,
    );
  });

  it('refuses when TEST_DATABASE_URL is missing or empty', () => {
    expect(refusal({ DATABASE_URL: DEV })).toMatch(/TEST_DATABASE_URL is not set/);
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: '' })).toMatch(
      /TEST_DATABASE_URL is not set/,
    );
  });

  it.each([
    ['not a URL', 'pulsedesk_test', /not a valid URL/],
    ['another scheme', 'mysql://u:p@localhost:3306/pulsedesk_test', /not a postgresql:\/\/ URL/],
    ['no host (Unix socket / libpq defaults)', 'postgresql:///pulsedesk_test', /no host/],
    ['an invalid port', 'postgresql://u:p@localhost:99999/pulsedesk_test', /not a valid URL|port/],
    ['no database', 'postgresql://u:p@localhost:5433', /exactly one database/],
    ['a nested path', 'postgresql://u:p@localhost:5433/pulsedesk_test/x', /exactly one database/],
    ['bad percent-encoding', 'postgresql://u:p@localhost:5433/pulsedesk%E0', /malformed/],
    ['a fragment', `${TEST}#x`, /fragment/],
  ])('refuses a test URL with %s', (_name, url, message) => {
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(message);
  });

  it('refuses a malformed DATABASE_URL instead of skipping the comparison', () => {
    expect(refusal({ DATABASE_URL: 'not a url', TEST_DATABASE_URL: TEST })).toMatch(
      /DATABASE_URL is not a valid URL/,
    );
  });

  it('never echoes credentials in its messages', () => {
    const secret = 'postgresql://u:hunter2@db.example.com:5432/pulsedesk';
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: secret })).not.toContain('hunter2');
    expect(refusal({ DATABASE_URL: 'x', TEST_DATABASE_URL: TEST })).not.toContain('dev-secret');
  });
});

describe('assertSafeTestDatabase — the development database', () => {
  it('refuses a test URL that names pulsedesk (or anything but pulsedesk_test)', () => {
    for (const name of ['pulsedesk', 'PULSEDESK_TEST', 'pulsedesk_test2', 'postgres']) {
      const url = `postgresql://u:p@localhost:5433/${name}`;
      expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url }), name).toMatch(
        /must name the database "pulsedesk_test"/,
      );
    }
  });

  it('refuses a percent-encoded name that decodes to something else', () => {
    const url = 'postgresql://u:p@localhost:5433/pulsed%65sk';
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(/not "pulsedesk"/);
  });

  // A development URL that points at the test database: the same database twice.
  const devOnTest = (url: string) => refusal({ DATABASE_URL: url, TEST_DATABASE_URL: TEST });

  it('refuses when both point at the same database', () => {
    expect(devOnTest(TEST)).toMatch(
      /point at the same database \(localhost:5433\/pulsedesk_test\)/,
    );
  });

  it.each(['127.0.0.1', '[::1]', 'LocalHost'])(
    'treats %s as the same server as localhost',
    (host) => {
      expect(devOnTest(`postgresql://dev:dev-secret@${host}:5433/pulsedesk_test`)).toMatch(
        /same database/,
      );
    },
  );

  it('is not fooled by a different username or password', () => {
    expect(devOnTest('postgresql://someone:else@localhost:5433/pulsedesk_test')).toMatch(
      /same database/,
    );
  });

  it('is not fooled by query parameters or percent-encoding', () => {
    expect(devOnTest(`${TEST}?schema=public&sslmode=disable`)).toMatch(/same database/);
    expect(devOnTest('postgresql://dev:dev-secret@localhost:5433/pulsedesk%5Ftest')).toMatch(
      /same database/,
    );
  });

  it('compares normalized ports (05433 is 5433)', () => {
    expect(devOnTest('postgresql://u:p@127.0.0.1:05433/pulsedesk_test')).toMatch(/same database/);
  });

  it('accepts the same database name on a different port (another server)', () => {
    const dev = 'postgresql://dev:dev-secret@localhost:5432/pulsedesk_test';
    expect(check({ DATABASE_URL: dev, TEST_DATABASE_URL: TEST }).url).toBe(TEST);
  });

  it.each(['host', 'hostaddr', 'port', 'dbname', 'database', 'service', 'HOST'])(
    'refuses a "%s" query parameter, which can redirect the connection',
    (key) => {
      const url = `${TEST}?${key}=x`;
      expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(
        /can change the target/,
      );
      expect(refusal({ DATABASE_URL: `${DEV}?${key}=x`, TEST_DATABASE_URL: TEST })).toMatch(
        /DATABASE_URL sets/,
      );
    },
  );

  it('refuses query parameters it does not know on the test URL', () => {
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: `${TEST}?options=-c%20x` })).toMatch(
      /unsupported query parameter "options"/,
    );
  });
});

describe('assertSafeTestDatabase — remote hosts', () => {
  it.each([
    'postgresql://u:p@ep-example.neon.tech:5432/pulsedesk_test?sslmode=require',
    'postgresql://u:p@db.internal:5432/pulsedesk_test',
    'postgresql://u:p@10.0.0.5:5433/pulsedesk_test',
    'postgresql://u:p@127.0.0.2:5433/pulsedesk_test',
    'postgresql://u:p@localhost.:5433/pulsedesk_test',
    'postgresql://u:p@127.1:5433/pulsedesk_test',
    'postgresql://u:p@a,b:5433/pulsedesk_test',
  ])('refuses %s, even when the database is named pulsedesk_test', (url) => {
    expect(refusal({ DATABASE_URL: DEV, TEST_DATABASE_URL: url })).toMatch(
      /must point at this machine/,
    );
  });
});

describe('assertSafeTestDatabase — E2E mode (development URL compared only if set)', () => {
  const e2e: TestDatabaseCheck = { developmentUrl: 'if-set' };

  it('accepts the test database when DATABASE_URL is absent (as in the CI E2E job)', () => {
    expect(check({ TEST_DATABASE_URL: TEST }, e2e).url).toBe(TEST);
  });

  it('still compares DATABASE_URL when it is set', () => {
    expect(refusal({ DATABASE_URL: TEST, TEST_DATABASE_URL: TEST }, e2e)).toMatch(/same database/);
    expect(refusal({ DATABASE_URL: '', TEST_DATABASE_URL: TEST }, e2e)).toMatch(/not set/);
  });

  it('applies every other rule', () => {
    const remote = 'postgresql://u:p@db.example.com:5432/pulsedesk_test';
    expect(refusal({ TEST_DATABASE_URL: remote }, e2e)).toMatch(/this machine/);
    expect(refusal({}, e2e)).toMatch(/TEST_DATABASE_URL is not set/);
  });
});

describe('assertSafeTestDatabase — the real CI configuration', () => {
  // Read from the workflow itself, so this test fails if CI's databases change.
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const jobEnv = (job: string) => {
    const section = workflow.slice(workflow.indexOf(`\n  ${job}:`));
    const next = section.slice(1).search(/\n {2}[a-z-]+:\n/);
    const body = next === -1 ? section : section.slice(0, next + 1);
    const value = (key: string) => new RegExp(`\\n\\s+${key}: (\\S+)`).exec(body)?.[1];
    return { TEST_DATABASE_URL: value('TEST_DATABASE_URL'), DATABASE_URL: value('DATABASE_URL') };
  };

  it('accepts the integration job (both URLs set)', () => {
    const env = jobEnv('verify');
    expect(env.TEST_DATABASE_URL).toBeDefined();
    expect(env.DATABASE_URL).toBeDefined();
    expect(check(env).target).toEqual({
      host: 'localhost',
      port: 5432,
      database: 'pulsedesk_test',
    });
  });

  it('accepts the E2E job (no development URL)', () => {
    const env = jobEnv('e2e');
    expect(env.TEST_DATABASE_URL).toBeDefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(check(env, { developmentUrl: 'if-set' }).target.database).toBe('pulsedesk_test');
  });
});

describe('shell variables and .env', () => {
  // loadWorkspaceEnv never overrides variables that are already set; the check must see the
  // final values. A temporary workspace with its own .env stands in for the repository.
  // Each test stubs both variables first (undefined unsets), so unstubAllEnvs also undoes
  // whatever loadWorkspaceEnv set from the temporary .env.
  let dir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function workspace(env: string): string {
    dir = mkdtempSync(join(tmpdir(), 'pulsedesk-env-'));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(dir, '.env'), env);
    return dir;
  }

  it('checks a shell TEST_DATABASE_URL that overrides a safe .env value — and refuses it', () => {
    const root = workspace(`DATABASE_URL=${DEV}\nTEST_DATABASE_URL=${TEST}\n`);
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://u:p@localhost:5433/pulsedesk');
    vi.stubEnv('DATABASE_URL', undefined);
    loadWorkspaceEnv(root);
    expect(process.env.TEST_DATABASE_URL).toBe('postgresql://u:p@localhost:5433/pulsedesk');
    expect(refusal(process.env)).toMatch(/must name the database "pulsedesk_test"/);
  });

  it('accepts a safe shell value that overrides an unsafe .env value', () => {
    const root = workspace(`DATABASE_URL=${DEV}\nTEST_DATABASE_URL=${DEV}\n`);
    vi.stubEnv('TEST_DATABASE_URL', TEST);
    vi.stubEnv('DATABASE_URL', undefined);
    loadWorkspaceEnv(root);
    expect(check(process.env).url).toBe(TEST);
  });

  it('compares against a shell DATABASE_URL that overrides .env', () => {
    const root = workspace(`DATABASE_URL=${DEV}\nTEST_DATABASE_URL=${TEST}\n`);
    vi.stubEnv('TEST_DATABASE_URL', undefined);
    vi.stubEnv('DATABASE_URL', 'postgresql://x:y@127.0.0.1:5433/pulsedesk_test');
    loadWorkspaceEnv(root);
    expect(refusal(process.env)).toMatch(/same database/);
  });
});
