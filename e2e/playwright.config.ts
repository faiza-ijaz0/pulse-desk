import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { AUTH_STATE } from './support/users.ts';

const WEB_URL = 'http://localhost:4173';
// Not the dev API's port (4000): reusing a running dev server would point the suite at the
// development database and skip the migration step.
const API_PORT = '4100';
const API_URL = `http://127.0.0.1:${API_PORT}`;
const isCI = Boolean(process.env.CI);

// Locally, read TEST_DATABASE_URL from the repository-root .env (variables already set win).
const rootEnv = new URL('../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// The suite signs up real users, so it runs against the disposable integration-test
// database (migrated before the API starts), never the development database.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. The E2E suite needs a disposable PostgreSQL database ' +
      '(see docs/testing.md).',
  );
}

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
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        WEB_ORIGIN: WEB_URL,
        LOG_LEVEL: 'warn',
        API_PORT,
        DATABASE_URL: databaseUrl,
        // A throwaway secret for this local test server only; never used anywhere else.
        SESSION_SECRET: 'e2e-only-session-secret-not-used-anywhere-else',
        // Every browser in the suite shares one IP; keep brute-force limits on but roomy.
        RATE_LIMIT_AUTH_PER_15_MINUTES: '200',
      },
    },
    {
      command: 'pnpm --filter @pulsedesk/web preview',
      url: WEB_URL,
      reuseExistingServer: !isCI,
      timeout: 30_000,
      // Read by vite.config.ts on the Node side: where preview proxies /api and /health.
      env: { API_PROXY_TARGET: API_URL },
    },
  ],
});
