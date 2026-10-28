import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadWorkspaceEnv } from './env.ts';
import { assertSafeTestDatabase, describeTarget } from './test-database-target.ts';

export {
  TEST_DATABASE_NAME,
  UnsafeTestDatabaseError,
  assertSafeTestDatabase,
  describeTarget,
} from './test-database-target.ts';

/**
 * Resets the integration-test database and applies every migration from scratch, so suites
 * exercise the committed migration SQL (not `db push`). Used as Vitest `globalSetup` by every
 * workspace with database integration tests. Before Prisma is started, the target must pass
 * `assertSafeTestDatabase` (a local database named `pulsedesk_test` that isn't the development
 * database); anything else fails loudly rather than skipping.
 */
export function resetTestDatabase(): string {
  // Shell variables win over .env; the check below sees the final values either way.
  loadWorkspaceEnv();
  const { url, target } = assertSafeTestDatabase(process.env);
  process.stdout.write(`Resetting the test database at ${describeTarget(target)}\n`);

  // Run Prisma's CLI entry point with this Node binary rather than through `pnpm exec`:
  // no shell is needed on Windows (where pnpm is a .cmd shim), so arguments are never
  // re-parsed by a shell. The schema and migrations are found through prisma.config.ts,
  // which lives in this package, so the CLI runs from here whichever workspace calls it.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'reset', '--force'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  return url;
}
