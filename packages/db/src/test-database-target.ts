/**
 * Decides whether a database may be wiped or written to by a test run. Pure (no I/O, no
 * Prisma), so the integration setup, the test helpers and the E2E config can all use it —
 * the E2E package imports this file directly — and it can be unit-tested without PostgreSQL.
 *
 * Policy (fail closed: anything not recognised is refused):
 * - The test database is named exactly `pulsedesk_test`.
 * - It is on this machine: host `localhost`, `127.0.0.1` or `::1`. No remote host is allowed,
 *   not even one named `pulsedesk_test`: CI and local development both use a local server
 *   (.github/workflows/ci.yml), so there is nothing to allowlist.
 * - It is not the development database: host (local spellings are equivalent), port and
 *   database name are compared after parsing, so a different username, password, query
 *   string or percent-encoding doesn't make the same database look different.
 * - Only query parameters that can't change which database is reached are accepted on the
 *   test URL; parameters that pick a host, port, database or service are refused on both.
 * - Both URLs state their port, and neither hostname is percent-encoded: clients fill a
 *   missing port from the environment, and pg decodes hostnames this parser keeps as written,
 *   so either could make the comparison above see two servers where pg reaches one.
 */

export const TEST_DATABASE_NAME = 'pulsedesk_test';

/** Hostnames, as the URL parser reports them, that reach this machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Connection parameters that select the server or database instead of the URL's own parts. */
const TARGET_PARAMETERS: ReadonlySet<string> = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'database',
  'service',
  'servicefile',
  'target_session_attrs',
]);

/** Parameters the test URL may carry: none of them can redirect the connection. */
const ALLOWED_TEST_PARAMETERS: ReadonlySet<string> = new Set([
  'schema',
  'sslmode',
  'connect_timeout',
  'connection_limit',
  'pool_timeout',
  'application_name',
]);

/** Where a connection string points, safe to log (no credentials). */
export type DatabaseTarget = { host: string; port: number; database: string };

export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to use the test database: ${reason}`);
    this.name = 'UnsafeTestDatabaseError';
  }
}

export function describeTarget(target: DatabaseTarget): string {
  return `${target.host}:${target.port}/${target.database}`;
}

type Parsed = DatabaseTarget & { url: string; local: boolean; parameters: string[] };

/** Parses a PostgreSQL URL into its target. Error messages never include the URL itself. */
function parse(name: string, value: string | undefined): Parsed {
  if (value === undefined || value.trim() === '') {
    throw new UnsafeTestDatabaseError(`${name} is not set.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeTestDatabaseError(`${name} is not a valid URL.`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new UnsafeTestDatabaseError(`${name} is not a postgresql:// URL.`);
  }
  if (url.hash !== '') {
    throw new UnsafeTestDatabaseError(`${name} has a #fragment, which is not supported.`);
  }
  const host = url.hostname.toLowerCase();
  if (host === '') {
    // No host means a Unix socket or libpq defaults: the server can't be verified.
    throw new UnsafeTestDatabaseError(`${name} has no host.`);
  }
  if (host.includes('%')) {
    // The URL parser keeps "%6Cocalhost" as written, but pg decodes it to "localhost".
    throw new UnsafeTestDatabaseError(`${name} has a percent-encoded hostname.`);
  }
  if (url.port === '') {
    // Clients fill a missing port from the environment (PGPORT), not always 5432.
    throw new UnsafeTestDatabaseError(`${name} must specify its port explicitly.`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UnsafeTestDatabaseError(`${name} has an invalid port.`);
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new UnsafeTestDatabaseError(`${name} has a malformed database name.`);
  }
  if (database === '' || database.includes('/')) {
    throw new UnsafeTestDatabaseError(`${name} does not name exactly one database.`);
  }
  const parameters = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  const redirecting = parameters.find((key) => TARGET_PARAMETERS.has(key));
  if (redirecting) {
    throw new UnsafeTestDatabaseError(
      `${name} sets "${redirecting}" in its query string, which can change the target.`,
    );
  }
  return { url: value, host, port, database, local: LOOPBACK_HOSTS.has(host), parameters };
}

// All local spellings reach the same server; remote hosts compare by (lower-cased) name.
const serverKey = (target: Parsed) => (target.local ? 'localhost' : target.host);

const sameTarget = (a: Parsed, b: Parsed) =>
  serverKey(a) === serverKey(b) && a.port === b.port && a.database === b.database;

export type TestDatabaseCheck = {
  /** `required`: the integration reset. `if-set`: E2E, whose CI job has no development URL. */
  developmentUrl: 'required' | 'if-set';
};

/**
 * Validates `env.TEST_DATABASE_URL` against the policy above and returns it with its
 * sanitized target. Call it on the final environment (after `.env` loading, where shell
 * variables win), before anything connects. Throws `UnsafeTestDatabaseError` otherwise.
 */
export function assertSafeTestDatabase(
  env: Readonly<Record<string, string | undefined>>,
  check: TestDatabaseCheck = { developmentUrl: 'required' },
): { url: string; target: DatabaseTarget } {
  const test = parse('TEST_DATABASE_URL', env.TEST_DATABASE_URL);
  const unknown = test.parameters.find((key) => !ALLOWED_TEST_PARAMETERS.has(key));
  if (unknown) {
    throw new UnsafeTestDatabaseError(
      `TEST_DATABASE_URL has an unsupported query parameter "${unknown}".`,
    );
  }
  if (test.database !== TEST_DATABASE_NAME) {
    throw new UnsafeTestDatabaseError(
      `TEST_DATABASE_URL must name the database "${TEST_DATABASE_NAME}", not "${test.database}".`,
    );
  }
  if (!test.local) {
    throw new UnsafeTestDatabaseError(
      `TEST_DATABASE_URL must point at this machine (localhost, 127.0.0.1 or ::1), not "${test.host}".`,
    );
  }

  const developmentUrl = env.DATABASE_URL;
  if (check.developmentUrl === 'required' || developmentUrl !== undefined) {
    const development = parse('DATABASE_URL', developmentUrl);
    if (sameTarget(test, development)) {
      throw new UnsafeTestDatabaseError(
        `TEST_DATABASE_URL and DATABASE_URL point at the same database (${describeTarget(test)}).`,
      );
    }
  }

  const target = { host: test.host, port: test.port, database: test.database };
  return { url: test.url, target };
}
