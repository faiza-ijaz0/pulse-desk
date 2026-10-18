import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadWorkspaceEnv } from './env.ts';

/**
 * Resets the integration-test database and applies every migration from scratch, so suites
 * exercise the committed migration SQL (not `db push`). Fails loudly — rather than
 * skipping — when no test database is configured. Used as Vitest `globalSetup` by every
 * workspace with database integration tests; never call it against a database you care about.
 */
export function resetTestDatabase(): string {
  loadWorkspaceEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests need a real PostgreSQL database ' +
        '(see docs/development.md → "Database").',
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: the test database is wiped.');
  }

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
