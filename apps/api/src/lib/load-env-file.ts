import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Loads the repository-root `.env` for local development. Variables already present in
 * the environment win. In production no `.env` exists and configuration comes from the
 * platform, so this is a no-op.
 */
export function loadEnvFile(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
