import { defineConfig, devices } from '@playwright/test';

const WEB_URL = 'http://localhost:4173';
const API_URL = 'http://127.0.0.1:4000';
const isCI = Boolean(process.env.CI);

/**
 * End-to-end tests run against production builds of both apps (`pnpm build` first):
 * the API bundle on :4000 and `vite preview` on :4173, which proxies /api and /health
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @pulsedesk/api start',
      url: `${API_URL}/health`,
      reuseExistingServer: !isCI,
      timeout: 30_000,
      env: { NODE_ENV: 'test', WEB_ORIGIN: WEB_URL, LOG_LEVEL: 'warn', API_PORT: '4000' },
    },
    {
      command: 'pnpm --filter @pulsedesk/web preview',
      url: WEB_URL,
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
  ],
});
