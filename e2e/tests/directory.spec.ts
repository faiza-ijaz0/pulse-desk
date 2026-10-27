import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { signUp, uniqueEmail } from '../support/users.ts';

async function createTicket(page: Page, email: string, subject: string) {
  await page.goto('/tickets');
  await page.getByRole('button', { name: 'New ticket' }).click();
  const dialog = page.getByRole('dialog', { name: 'New ticket' });
  await dialog.getByLabel(/customer email/i).fill(email);
  await dialog.getByLabel(/customer name/i).fill('Ada Lovelace');
  await dialog.getByLabel(/^subject/i).fill(subject);
  await dialog.getByLabel(/^message/i).fill('Please look into this.');
  await dialog.getByRole('button', { name: 'Create ticket' }).click();
  await expect(page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
}

// Its own organization (as owner), so its data can't disturb tests sharing the suite user.
test('customers, teams, tags, settings and search work together', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signUp(page, { email: uniqueEmail('directory'), organization: 'Directory Works' });

  await createTicket(page, 'ada@example.com', 'Invoice charged twice');

  // Customers: search, open, edit.
  await page.goto('/customers');
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('lovelace');
  await expect(page).toHaveURL(/\/customers\?q=lovelace$/);
  await page.getByRole('link', { name: /Ada Lovelace/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: 'Ticket history' })
      .getByRole('link', { name: /Invoice charged twice/ }),
  ).toBeVisible();
  await expectNoA11yViolations(page);
  await page.getByRole('button', { name: 'Edit contact details' }).click();
  const contact = page.getByRole('form', { name: 'Edit contact details' });
  await contact.getByLabel('Name').fill('Ada King');
  await contact.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ada King' })).toBeVisible();

  // Settings: rename the organization, add a tag.
  await page.goto('/settings');
  const profile = page.getByRole('form', { name: 'Organization profile' });
  await profile.getByLabel(/organization name/i).fill('Directory Works Ltd');
  await profile.getByRole('button', { name: 'Save changes' }).click();
  await expect(profile.getByText('Saved')).toBeVisible();
  const newTag = page.getByRole('form', { name: 'New tag' });
  await newTag.getByLabel('Tag name').fill('refund');
  await newTag.getByRole('combobox', { name: 'Color' }).selectOption('red');
  await newTag.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByRole('list', { name: 'Tags' }).getByText('refund')).toBeVisible();
  await expectNoA11yViolations(page);

  // Teams: create one and staff it.
  await page.goto('/team');
  await page.getByRole('form', { name: 'New team' }).getByLabel('Team name').fill('Billing');
  await page.getByRole('button', { name: 'Create team' }).click();
  const billing = page.getByRole('region', { name: 'Billing' });
  await expect(billing).toBeVisible();
  await billing
    .getByRole('combobox', { name: 'Add a member to Billing' })
    .selectOption({ index: 1 });
  await billing.getByRole('button', { name: 'Add' }).click();
  await expect(billing.getByText('1 member')).toBeVisible();
  await expectNoA11yViolations(page);

  // The new tag and team are immediately usable on the ticket.
  await page.goto('/tickets/1');
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByRole('combobox', { name: 'Team' }).selectOption({ label: 'Billing' });
  await expect(details.getByText('Saved')).toBeVisible();

  // Global search from the command menu, by ticket number.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('#1');
  const result = page.getByRole('option', { name: /#1 Invoice charged twice/ });
  await expect(result).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('ada');
  await page.getByRole('option', { name: /Ada King/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ada King' })).toBeVisible();

  // Phone width: no horizontal overflow on the new pages.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/customers', '/team', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await context.close();
});
