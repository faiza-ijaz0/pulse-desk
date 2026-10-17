import { execFileSync } from 'node:child_process';
import { loadWorkspaceEnv } from '../src/env.ts';

/**
 * Resets the integration-test database and applies every migration from scratch, so the
 * suite exercises the committed migration SQL (not `db push`). Fails loudly — rather than
 * skipping — when no test database is configured.
 */
export default function setup(): void {
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

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'reset', '--force'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
