import { test as setup } from '@playwright/test';
import { expectPreviewProxiesToE2eApi } from '../support/stack.ts';
import { AUTH_STATE, signUp, uniqueEmail } from '../support/users.ts';

setup('sign up a user for the signed-in journeys', async ({ page, request }) => {
  await setup.step('the preview server proxies to this run’s API', () =>
    expectPreviewProxiesToE2eApi(request),
  );
  await signUp(page, { email: uniqueEmail('shell'), organization: 'E2E Workspace' });
  await page.context().storageState({ path: AUTH_STATE });
});
