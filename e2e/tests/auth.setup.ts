import { test as setup } from '@playwright/test';
import { AUTH_STATE, signUp, uniqueEmail } from '../support/users.ts';

setup('sign up a user for the signed-in journeys', async ({ page }) => {
  await signUp(page, { email: uniqueEmail('shell'), organization: 'E2E Workspace' });
  await page.context().storageState({ path: AUTH_STATE });
});
