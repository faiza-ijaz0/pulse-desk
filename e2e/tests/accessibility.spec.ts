import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';

const PAGES = [
  { path: '/dashboard', heading: 'Support overview' },
  { path: '/design-system', heading: 'Design system' },
  { path: '/tickets', heading: 'Tickets' },
  { path: '/tickets/1', heading: 'Ticket not found' },
  { path: '/customers', heading: 'Customers' },
  { path: '/team', heading: 'Agents & teams' },
  { path: '/settings', heading: 'Settings' },
  { path: '/analytics', heading: 'Analytics isn’t built yet' },
];

for (const theme of ['light', 'dark'] as const) {
  for (const { path, heading } of PAGES) {
    test(`${path} has no WCAG 2.2 AA violations in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('pulsedesk-theme', value), theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }
}

test('keyboard users can reach main content and open the command menu', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Support overview' })).toBeVisible();

  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});
