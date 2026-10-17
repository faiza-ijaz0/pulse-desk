import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Loads the repository-root `.env` (if present) into `process.env` without overriding
 * variables that are already set. Walks up from `startDir` to the pnpm workspace root.
 * In production there is no `.env` file and this is a no-op.
 */
export function loadWorkspaceEnv(startDir: string = process.cwd()): void {
  let dir = startDir;
  for (;;) {
    const envFile = join(dir, '.env');
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile);
      return;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
