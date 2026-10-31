import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { signUp, uniqueEmail } from '../support/users.ts';

const ORGANIZATION_API = '**/api/v1/organization';

// Each test signs up its own organization (as owner), so changing its auto-close settings
// can't disturb tests sharing the suite user.
async function ownerPage(browser: Browser, organization: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signUp(page, { email: uniqueEmail('auto-close'), organization });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  return page;
}

/** Switches the theme the way the app stores it, reloads and checks it took effect. */
async function switchTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => localStorage.setItem('pulsedesk-theme', value), theme);
  await page.reload();
  const html = expect(page.locator('html'));
  await (theme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/);
}

function autoCloseForm(page: Page) {
  const form = page.getByRole('form', { name: 'Auto-close settings' });
  return {
    form,
    toggle: form.getByRole('switch', { name: 'Close solved tickets automatically' }),
    amount: form.getByRole('textbox', { name: /close after/i }),
    unit: form.getByRole('combobox', { name: 'Unit' }),
    save: form.getByRole('button', { name: 'Save auto-close' }),
  };
}

test.describe('auto-close settings', () => {
  test('owners turn auto-close off and on, validate the delay and keep what they saved', async ({
    browser,
  }) => {
    // A sign-up, several reloads and three axe scans: under a slow full run it outgrew the
    // 30 s default (23.9 s in one run, over 30 s in the next).
    test.slow();
    const page = await ownerPage(browser, 'Auto-close Works');
    const card = page.getByRole('region', { name: 'Auto-close' });
    await expect(card).toBeVisible();
    const { form, toggle, amount, unit, save } = autoCloseForm(page);

    // New organizations start with auto-close on after 4 days.
    await expect(toggle).toBeChecked();
    await expect(amount).toHaveValue('4');
    await expect(unit).toHaveValue('days');
    await expectNoA11yViolations(page);

    // Keyboard: Space toggles the switch; turning it back on warns about solved tickets.
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await expect(form.getByText('Already-solved tickets are included')).toBeHidden();
    await save.click();
    await expect(form.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    await page.reload();
    await expect(toggle).not.toBeChecked();
    // The delay is kept while auto-close is off.
    await expect(amount).toHaveValue('4');
    await expect(unit).toHaveValue('days');

    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    await expect(form.getByText('Already-solved tickets are included')).toBeVisible();

    // Delay validation, announced on the field.
    const cases: [string, 'hours' | 'days', string][] = [
      ['', 'hours', 'Enter how long to wait.'],
      ['1.5', 'hours', 'Enter a whole number.'],
      ['0', 'hours', 'Must be at least 1 hour.'],
      ['366', 'days', 'Must be at most 365 days.'],
      ['8761', 'hours', 'Must be at most 8760 hours.'],
    ];
    for (const [value, unitValue, message] of cases) {
      await amount.fill(value);
      await unit.selectOption(unitValue);
      await save.click();
      await expect(amount).toHaveAttribute('aria-invalid', 'true');
      await expect(amount).toHaveAccessibleDescription(message);
    }
    // Light and dark with the warning and an error showing.
    await expectNoA11yViolations(page);
    await switchTheme(page, 'dark');
    // The switch's input is visually hidden; pointer users click its label.
    await form.getByText('Solved tickets with no further activity').click();
    await expect(toggle).toBeChecked();
    await amount.fill('');
    await save.click();
    await expect(form.getByText('Already-solved tickets are included')).toBeVisible();
    await expect(amount).toHaveAccessibleDescription('Enter how long to wait.');
    await expectNoA11yViolations(page);
    await switchTheme(page, 'light');
    await form.getByText('Solved tickets with no further activity').click();
    await expect(toggle).toBeChecked();

    // Typing clears the error; a valid delay saves from the keyboard (Enter submits).
    await amount.fill('36');
    await expect(amount).not.toHaveAttribute('aria-invalid', 'true');
    await unit.selectOption('hours');
    await amount.press('Enter');
    await expect(form.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    await page.reload();
    await expect(toggle).toBeChecked();
    // 36 hours isn't whole days, so it comes back as hours.
    await expect(amount).toHaveValue('36');
    await expect(unit).toHaveValue('hours');

    await page.context().close();
  });

  test('shows saving progress and save or load errors', async ({ browser }) => {
    const page = await ownerPage(browser, 'Auto-close Errors');
    const { form, amount, unit, save } = autoCloseForm(page);
    await expect(amount).toHaveValue('4');

    // Saving: hold the request to see the busy state, then let it through.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(ORGANIZATION_API, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await held;
      await route.continue();
    });
    await amount.fill('2');
    await save.click();
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await expect(save).toBeDisabled();
    await expect(amount).toBeDisabled();
    release();
    await expect(form.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect(save).not.toHaveAttribute('aria-busy');
    await page.unroute(ORGANIZATION_API);

    // A failed save keeps the input and says why.
    await page.route(ORGANIZATION_API, (route) =>
      route.request().method() === 'PATCH' ? route.abort('failed') : route.fallback(),
    );
    await amount.fill('3');
    await unit.selectOption('hours');
    await save.click();
    await expect(amount).toHaveAccessibleDescription(/couldn’t reach PulseDesk/i);
    await expect(amount).toHaveValue('3');
    await expect(form.getByText('Saved')).toBeHidden();
    await expectNoA11yViolations(page);
    await page.unroute(ORGANIZATION_API);

    // A failed load offers a retry that recovers. A server error, because network failures
    // are retried automatically with backoff for most of a minute before the error shows.
    await page.route(ORGANIZATION_API, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 500,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Internal Server Error',
              status: 500,
              code: 'INTERNAL_ERROR',
              requestId: 'e2e-request',
            },
          })
        : route.fallback(),
    );
    await page.reload();
    const card = page.getByRole('region', { name: 'Auto-close' });
    await expect(card.getByText('Couldn’t load auto-close settings')).toBeVisible();
    await expect(card.getByText(/reference e2e-request/)).toBeVisible();
    await expectNoA11yViolations(page);
    await page.unroute(ORGANIZATION_API);
    await card.getByRole('button', { name: /retry|try again/i }).click();
    await expect(autoCloseForm(page).amount).toHaveValue('2');
    await expect(autoCloseForm(page).unit).toHaveValue('days');

    await page.context().close();
  });

  // Agents can't be created through the UI (there are no invitations yet), so the session's
  // role is rewritten in the browser. This checks the read-only UI only; the API's refusal to
  // let agents change settings is covered by the integration tests.
  test('agents see the settings read-only', async ({ browser }) => {
    const page = await ownerPage(browser, 'Auto-close Agents');
    await page.route('**/api/v1/auth/session', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { activeOrganization: { role: string } | null };
      if (body.activeOrganization) body.activeOrganization.role = 'AGENT';
      await route.fulfill({ response, json: body });
    });
    await page.reload();

    await expect(page.getByText('Only admins and owners can change these settings.')).toBeVisible();
    const card = page.getByRole('region', { name: 'Auto-close' });
    await expect(card.getByRole('definition')).toHaveText(['On', '4 days']);
    await expect(card.getByRole('form')).toHaveCount(0);
    await expect(card.getByRole('switch')).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveCount(0);
    await expectNoA11yViolations(page);
    await switchTheme(page, 'dark');
    await expect(card.getByRole('definition')).toHaveText(['On', '4 days']);
    await expectNoA11yViolations(page);

    await page.context().close();
  });
});
