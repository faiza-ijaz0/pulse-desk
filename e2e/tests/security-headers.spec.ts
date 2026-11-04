import { expect, test, type Page } from '@playwright/test';

// `vite preview` serves the security headers from apps/web/vercel.json (vite.config.ts), so
// the app runs here under the production Content-Security-Policy.

type WithViolations = { cspViolations: string[] };

// Registered before any page script runs; init scripts aren't subject to the page's CSP.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const recorded: string[] = [];
    (window as unknown as WithViolations).cspViolations = recorded;
    document.addEventListener('securitypolicyviolation', (event) => {
      recorded.push(
        `${event.effectiveDirective} blocked ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`,
      );
    });
  });
});

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as WithViolations).cspViolations);

test.describe('SPA security headers', () => {
  test('are sent on the app document', async ({ page }) => {
    const response = await page.goto('/dashboard');
    const headers = response?.headers() ?? {};

    expect(headers['content-security-policy']).toContain("script-src 'self' 'sha256-");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  test('cause no CSP violations on the main pages', async ({ page }) => {
    for (const [path, heading] of [
      ['/dashboard', 'Support overview'],
      ['/tickets', 'Tickets'],
      ['/customers', 'Customers'],
      ['/team', 'Agents & teams'],
      ['/sla', 'SLA policies'],
      ['/settings', 'Settings'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      expect(await violations(page), path).toEqual([]);
    }
  });

  test('cause no CSP violations in the command menu and dialogs', async ({ page }) => {
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { level: 1, name: 'Tickets' })).toBeVisible();

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Radix's scroll lock injects a <style> while a modal is open ('unsafe-inline' styles).
    await page.getByRole('button', { name: 'New ticket' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    await page.keyboard.press('Escape');

    expect(await violations(page)).toEqual([]);
  });
});
