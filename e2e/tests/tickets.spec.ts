import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { signUp, uniqueEmail } from '../support/users.ts';

// The suite's users sign up fresh organizations, which have no tickets yet; the inbox
// still talks to the real API for tickets, members, teams and tags.
test.describe('ticket inbox', () => {
  test('shows the empty inbox from the real API', async ({ page }) => {
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { level: 1, name: 'Tickets' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No tickets yet' })).toBeVisible();
  });

  test('keeps filters in the URL across reloads and clears them', async ({ page }) => {
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { name: 'No tickets yet' })).toBeVisible();

    await page.getByRole('combobox', { name: 'Status' }).selectOption('active');
    await page.getByRole('combobox', { name: 'Assignee' }).selectOption('me');
    await expect(page).toHaveURL(/\/tickets\?status=OPEN%2CPENDING%2CON_HOLD&assignee=me$/);
    await expect(
      page.getByRole('heading', { name: 'No tickets match these filters' }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('active');
    await expect(page.getByRole('combobox', { name: 'Assignee' })).toHaveValue('me');

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/tickets$/);
    await expect(page.getByRole('heading', { name: 'No tickets yet' })).toBeVisible();
  });

  test('a ticket number outside the organization is not found', async ({ page }) => {
    await page.goto('/tickets/1');
    await expect(page.getByRole('heading', { name: 'Ticket not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to all tickets' }).click();
    await expect(page).toHaveURL(/\/tickets$/);
  });
});

// Its own organization, so creating tickets can't disturb the empty-inbox tests above,
// which share the suite's signed-in user and run in parallel.
test('creates a ticket, works it, and stays accessible', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signUp(page, { email: uniqueEmail('tickets'), organization: 'Ticket Works' });

  await page.goto('/tickets');
  await page.getByRole('button', { name: 'New ticket' }).click();
  const dialog = page.getByRole('dialog', { name: 'New ticket' });
  await dialog.getByLabel(/customer email/i).fill('ada@example.com');
  await dialog.getByLabel(/customer name/i).fill('Ada Customer');
  await dialog.getByLabel(/^subject/i).fill('Card charged twice');
  await dialog.getByLabel(/^message/i).fill('My card shows two charges this month.');
  await dialog.getByRole('combobox', { name: 'Priority' }).selectOption('HIGH');
  await dialog.getByRole('button', { name: 'Create ticket' }).click();

  await expect(page).toHaveURL(/\/tickets\/1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Card charged twice' })).toBeVisible();
  const details = page.getByRole('region', { name: 'Details' });
  await expect(details.getByRole('combobox', { name: 'Priority' })).toHaveValue('HIGH');

  await details.getByRole('combobox', { name: 'Status' }).selectOption('PENDING');
  await expect(details.getByText('Saved')).toBeVisible();

  const thread = page.getByRole('list', { name: 'Conversation' });
  const reply = page.getByRole('form', { name: 'Reply to the customer' });
  await reply.getByRole('textbox', { name: 'Reply' }).fill('Refund started — 3 working days.');
  await reply.getByRole('button', { name: 'Send reply' }).click();
  await expect(thread.getByText('Refund started — 3 working days.')).toBeVisible();

  // The radios are visually hidden inside their labels, which is what people click.
  await page.getByRole('radiogroup', { name: 'Message type' }).getByText('Internal note').click();
  await expect(page.getByRole('radio', { name: 'Internal note' })).toBeChecked();
  const note = page.getByRole('form', { name: 'Add an internal note' });
  await note.getByRole('textbox', { name: 'Note' }).fill('Duplicate capture in Stripe.');
  await note.getByRole('textbox', { name: 'Note' }).press('ControlOrMeta+Enter');
  const noteItem = thread.getByRole('listitem').filter({ hasText: 'Duplicate capture in Stripe.' });
  await expect(noteItem.getByText('Internal note')).toBeVisible();

  const activity = page.getByRole('list', { name: 'Activity' });
  await expect(activity).toContainText('changed the status from Open to Pending');
  await expect(activity).toContainText('added an internal note');

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => localStorage.setItem('pulsedesk-theme', value), theme);
    await page.reload();
    await expect(thread.getByText('Duplicate capture in Stripe.')).toBeVisible();
    await expectNoA11yViolations(page);
  }

  // The inbox shows the new ticket with its current state.
  await page.goto('/tickets');
  const row = page.getByRole('listitem').filter({ hasText: 'Card charged twice' });
  await expect(row.getByText('Pending')).toBeVisible();

  // Phone width: no horizontal overflow on the working ticket.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tickets/1');
  await expect(page.getByRole('heading', { level: 1, name: 'Card charged twice' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});
