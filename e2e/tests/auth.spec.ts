import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { E2E_PASSWORD, signUp, uniqueEmail } from '../support/users.ts';

// These journeys start signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('authentication', () => {
  test('sign up, restore the session, sign out and sign back in', async ({ page, context }) => {
    const email = uniqueEmail('journey');
    await signUp(page, { email, organization: 'Northwind Support' });
    await expect(page.getByText('Northwind Support is ready')).toBeVisible();

    // The session lives in an HttpOnly, SameSite=Lax cookie that scripts cannot read.
    const [cookie] = (await context.cookies()).filter((c) => c.name === 'pd_sid');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(await page.evaluate(() => document.cookie)).not.toContain('pd_sid');
    const storage = await page.evaluate(() =>
      [localStorage, sessionStorage]
        .flatMap((store) => Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`))
        .join(' '),
    );
    expect(storage).not.toContain(cookie!.value);

    // A reload restores the session from the cookie.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Support overview' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Northwind Support',
    );

    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Signed out: protected pages send you to sign in, and the old cookie is gone.
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Sign in to PulseDesk' })).toBeVisible();
    expect((await context.cookies()).some((c) => c.name === 'pd_sid')).toBe(false);

    await page.getByLabel('Email').fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill('not the right password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');

    await page.getByRole('textbox', { name: 'Password' }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Support overview' })).toBeVisible();
  });

  test('returns to the requested page after signing in', async ({ page, browser }) => {
    const email = uniqueEmail('deeplink');
    const setup = await browser.newPage();
    await signUp(setup, { email, organization: 'Deep Link Co' });
    await setup.close();

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('tells a returning user their email is already registered', async ({ page, browser }) => {
    const email = uniqueEmail('taken');
    const first = await browser.newPage();
    await signUp(first, { email, organization: 'First Co' });
    await first.close();

    await page.goto('/signup');
    await page.getByLabel('Your name').fill('Someone Else');
    await page.getByLabel('Work email').fill(email.toUpperCase());
    await page.getByLabel('Organization name').fill('Second Co');
    await page.getByRole('textbox', { name: 'Password' }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('An account with this email already exists.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in instead' })).toBeVisible();
  });
});

for (const theme of ['light', 'dark'] as const) {
  for (const { path, heading } of [
    { path: '/login', heading: 'Sign in to PulseDesk' },
    { path: '/signup', heading: 'Create your PulseDesk account' },
  ]) {
    test(`${path} has no WCAG 2.2 AA violations in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('pulsedesk-theme', value), theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }
}

test('the sign-in form shows validation errors accessibly', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Email')).toBeFocused();
  await expectNoA11yViolations(page);
});
