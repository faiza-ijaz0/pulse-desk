import { expect, test } from '@playwright/test';

test.describe('application shell', () => {
  test('loads the dashboard preview and reaches the real API', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Support overview' })).toBeVisible();
    await expect(page.getByText('This dashboard is a design preview')).toBeVisible();
    // Backed by a real GET /health through the preview server's proxy.
    await expect(page.getByRole('status').filter({ hasText: 'API online' })).toBeVisible();
  });

  test('persists the dark theme across reloads without a light flash', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /change theme/i }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // The pre-paint script must apply the class before any app code runs.
    await page.route('**/assets/*.js', (route) => route.abort());
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('navigates with the command menu', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Support overview' })).toBeVisible();

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Search commands' }).fill('design');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/design-system$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
  });

  test('collapses the desktop sidebar and remembers it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/dashboard');
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar).toHaveCSS('width', '248px');

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar).toHaveCSS('width', '64px');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  });
});

test.describe('responsive layouts', () => {
  test('tablet shows an icon rail', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/dashboard');

    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveCSS('width', '64px');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  });

  test('mobile replaces the sidebar with a navigation drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard');

    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    await drawer.getByRole('link', { name: /tickets/i }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Tickets isn’t built yet' })).toBeVisible();

    // No horizontal overflow on a phone-width screen.
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Support overview' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
