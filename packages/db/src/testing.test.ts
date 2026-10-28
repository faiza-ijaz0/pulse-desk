import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsafeTestDatabaseError } from './test-database-target.ts';
import { resetTestDatabase } from './testing.ts';

// Nothing in this file may reach PostgreSQL: Prisma's CLI is never really started, and the
// repository's .env is never read. (vi.mock calls are hoisted above the imports.)
const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync }));
vi.mock('./env.ts', () => ({ loadWorkspaceEnv: vi.fn() }));

const DEV = 'postgresql://dev:dev-secret@localhost:5433/pulsedesk';
const TEST = 'postgresql://dev:dev-secret@localhost:5433/pulsedesk_test';

let stdout: { mock: { calls: unknown[][] } };

beforeEach(() => {
  execFileSync.mockReset();
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Sets exactly these two variables for the test (a missing one is unset). */
function setEnv(env: { DATABASE_URL?: string; TEST_DATABASE_URL?: string }) {
  vi.stubEnv('DATABASE_URL', env.DATABASE_URL);
  vi.stubEnv('TEST_DATABASE_URL', env.TEST_DATABASE_URL);
}

describe('resetTestDatabase', () => {
  it.each([
    ['the development database', { DATABASE_URL: DEV, TEST_DATABASE_URL: DEV }],
    [
      'the same database spelled differently',
      { DATABASE_URL: TEST.replace('localhost', '127.0.0.1'), TEST_DATABASE_URL: TEST },
    ],
    [
      'a remote database',
      {
        DATABASE_URL: DEV,
        TEST_DATABASE_URL: 'postgresql://u:p@db.example.com:5432/pulsedesk_test',
      },
    ],
    ['no DATABASE_URL', { TEST_DATABASE_URL: TEST }],
    ['no TEST_DATABASE_URL', { DATABASE_URL: DEV }],
    [
      'a development URL hiding the test database behind an encoded host',
      { DATABASE_URL: TEST.replace('localhost', '%6Cocalhost'), TEST_DATABASE_URL: TEST },
    ],
    [
      'a test URL without a port',
      { DATABASE_URL: DEV, TEST_DATABASE_URL: TEST.replace(':5433', '') },
    ],
  ])('refuses %s without starting Prisma', (_name, env) => {
    setEnv(env);
    expect(() => resetTestDatabase()).toThrow(UnsafeTestDatabaseError);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('resets only the validated database, logging its target without credentials', () => {
    setEnv({ DATABASE_URL: DEV, TEST_DATABASE_URL: TEST });
    expect(resetTestDatabase()).toBe(TEST);

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [, args, options] = execFileSync.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(args.slice(1)).toEqual(['migrate', 'reset', '--force']);
    expect(options.env.DATABASE_URL).toBe(TEST);

    const logged = stdout.mock.calls.map(([text]) => String(text)).join('');
    expect(logged).toContain('localhost:5433/pulsedesk_test');
    expect(logged).not.toContain('dev-secret');
  });
});
