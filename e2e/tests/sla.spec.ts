import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { signUp, uniqueEmail } from '../support/users.ts';

/** Switches the theme the way the app stores it, reloads and checks it took effect. */
async function switchTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => localStorage.setItem('pulsedesk-theme', value), theme);
  await page.reload();
  const html = expect(page.locator('html'));
  await (theme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/);
}

function target(page: Page, priority: string, label: 'First response' | 'Resolution') {
  const group = page
    .getByRole('form', { name: 'SLA targets' })
    .getByRole('group', { name: priority });
  return {
    amount: group.getByRole('textbox', { name: label }),
    unit: group.getByRole('combobox', { name: `${label} unit` }),
  };
}

// Its own organization (as owner), so changing its targets can't disturb other tests.
test('owners change SLA targets, and new tickets follow them', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signUp(page, { email: uniqueEmail('sla'), organization: 'SLA Works' });

  // Reached from the sidebar, with the defaults from sign-up.
  await page.getByRole('link', { name: 'SLA policies' }).first().click();
  await expect(page).toHaveURL(/\/sla$/);
  await expect(page.getByRole('heading', { level: 1, name: 'SLA policies' })).toBeVisible();
  const urgent = target(page, 'Urgent', 'First response');
  await expect(urgent.amount).toHaveValue('30');
  await expect(urgent.unit).toHaveValue('minutes');
  await expectNoA11yViolations(page);

  // Validation, announced on the field, in both themes.
  const high = target(page, 'High', 'Resolution');
  await high.amount.fill('10');
  await high.unit.selectOption('minutes');
  const save = page.getByRole('button', { name: 'Save targets' });
  await save.click();
  await expect(high.amount).toHaveAttribute('aria-invalid', 'true');
  await expect(high.amount).toHaveAccessibleDescription(
    'Must be at least the first-response target.',
  );
  await expectNoA11yViolations(page);

  // Keyboard only: type a new urgent target, move to its unit with Tab and submit with Enter.
  await high.amount.fill('8');
  await high.unit.selectOption('hours');
  await urgent.amount.fill('15');
  await urgent.amount.press('Tab');
  await expect(urgent.unit).toBeFocused();
  await urgent.amount.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  await switchTheme(page, 'dark');
  await expect(target(page, 'Urgent', 'First response').amount).toHaveValue('15');
  await expectNoA11yViolations(page);
  await switchTheme(page, 'light');

  // A new urgent ticket is due 15 minutes after it was created.
  await page.goto('/tickets');
  await page.getByRole('button', { name: 'New ticket' }).click();
  const dialog = page.getByRole('dialog', { name: 'New ticket' });
  await dialog.getByLabel(/customer email/i).fill('ada@example.com');
  await dialog.getByLabel(/^subject/i).fill('Outage');
  await dialog.getByLabel(/^message/i).fill('Everything is down.');
  await dialog.getByLabel(/^priority/i).selectOption('URGENT');
  const created = page.waitForResponse(
    (res) => res.url().endsWith('/api/v1/tickets') && res.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Create ticket' }).click();
  const body = (await (await created).json()) as {
    ticket: { createdAt: string; firstResponseDueAt: string };
  };
  expect(Date.parse(body.ticket.firstResponseDueAt) - Date.parse(body.ticket.createdAt)).toBe(
    15 * 60_000,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Outage' })).toBeVisible();

  // Phone width: the targets stack without horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/sla');
  await expect(target(page, 'Low', 'Resolution').amount).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});
