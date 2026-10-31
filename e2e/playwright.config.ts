import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
// Imported by path: the E2E package doesn't depend on @pulsedesk/db, and this module is pure.
import { assertSafeTestDatabase, describeTarget } from '../packages/db/src/test-database-target.ts';
import { E2E_API_VERSION } from './support/stack.ts';
import { AUTH_STATE } from './support/users.ts';

const WEB_URL = 'http://localhost:4173';
// Not the dev API's port (4000): reusing a running dev server would point the suite at the
// development database and skip the migration step.
const API_PORT = '4100';
const API_URL = `http://127.0.0.1:${API_PORT}`;
const isCI = Boolean(process.env.CI);
// A throwaway value for these local test servers only. With it set, the API rejects any
// request that didn't come through the preview proxy, as it does behind Vercel.
const PROXY_SHARED_SECRET = 'e2e-only-proxy-secret_not-used-anywhere-else';

// Locally, read TEST_DATABASE_URL from the repository-root .env (variables already set win).
const rootEnv = new URL('../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// The suite signs up real users, so it runs against the disposable integration-test
// database (migrated before the API starts), never the development database. The same
// policy as the integration reset: a local database named pulsedesk_test that isn't the
// development database (see docs/testing.md). Checked here, before any server starts. CI's
// E2E job has no development database, so DATABASE_URL is compared only when it is set.
const { url: databaseUrl, target } = assertSafeTestDatabase(process.env, {
  developmentUrl: 'if-set',
});
process.stdout.write(`E2E database: ${describeTarget(target)}\n`);

/**
 * End-to-end tests run against production builds of both apps (`pnpm build` first):
 * the API bundle on :4100 and `vite preview` on :4173, which proxies /api and /health
 * to the API exactly like the dev server does.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Signs up once through the real UI and saves the session cookie for the other tests.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      command:
        'pnpm --filter @pulsedesk/db run migrate:deploy && pnpm --filter @pulsedesk/api start',
      url: `${API_URL}/health`,
      // Never reuse whatever already listens on these ports: a leftover API could use another
      // database (even production), and a leftover preview could proxy to a dead or different
      // API. Playwright fails fast instead ("… is already used …"); stop the old server.
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        // Lets the setup project check that the preview forwards to this API (support/stack.ts).
        APP_VERSION: E2E_API_VERSION,
        WEB_ORIGIN: WEB_URL,
        LOG_LEVEL: 'warn',
        API_PORT,
        DATABASE_URL: databaseUrl,
        // A throwaway secret for this local test server only; never used anywhere else.
        SESSION_SECRET: 'e2e-only-session-secret-not-used-anywhere-else',
        PROXY_SHARED_SECRET,
        // Every browser in the suite reaches the API through the preview proxy, so they all
        // share one IP and one rate-limit budget. Keep both limits on but roomy: the global
        // default (300/min) is outrun by the parallel suite, and the auth one by its sign-ups.
        RATE_LIMIT_GLOBAL_PER_MINUTE: '3000',
        RATE_LIMIT_AUTH_PER_15_MINUTES: '200',
      },
    },
    {
      command: 'pnpm --filter @pulsedesk/web preview',
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      // Read by vite.config.ts on the Node side: where preview proxies /api and /health, and
      // the secret it adds to each proxied request (like Vercel's route transform).
      env: { API_PROXY_TARGET: API_URL, PROXY_SHARED_SECRET },
    },
  ],
});
