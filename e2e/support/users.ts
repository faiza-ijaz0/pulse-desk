import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/** Saved session of the user signed up by the setup project (git-ignored). */
export const AUTH_STATE = 'playwright/.auth/user.json';

export const E2E_PASSWORD = 'e2e correct horse battery';

export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@e2e.pulsedesk.test`;
}

/** Signs up through the real form and waits for the dashboard. */
export async function signUp(page: Page, options: { email: string; organization: string }) {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Ellis Example');
  await page.getByLabel('Work email').fill(options.email);
  await page.getByLabel('Organization name').fill(options.organization);
  await page.getByRole('textbox', { name: 'Password' }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Support overview' })).toBeVisible();
}
