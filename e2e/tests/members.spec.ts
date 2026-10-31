import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { E2E_PASSWORD, signUp, uniqueEmail } from '../support/users.ts';

/** Switches the theme the way the app stores it, reloads and checks it took effect. */
async function switchTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => localStorage.setItem('pulsedesk-theme', value), theme);
  await page.reload();
  const html = expect(page.locator('html'));
  await (theme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/);
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}

/** Creates an invitation from the team page and returns the link shown once. */
async function inviteFromTeamPage(page: Page, email: string, role: 'Admin' | 'Agent') {
  await page.getByRole('button', { name: 'Invite member' }).click();
  const form = page.getByRole('form', { name: 'Invite a member' });
  await form.getByRole('textbox', { name: /email/i }).fill(email);
  await form.getByRole('combobox', { name: /role/i }).selectOption({ label: role });
  await form.getByRole('button', { name: 'Create invitation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invitation ready' });
  const link = await dialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{43}$/);
  return { dialog, link };
}

// Two people in two browsers: an owner of their own organization, and someone they invite.
test('invite a new member, change their role and remove them', async ({ browser }) => {
  test.slow();
  const owner = await freshPage(browser);
  await signUp(owner, { email: uniqueEmail('inviter'), organization: 'Invite Works' });
  await owner.goto('/team');
  await expect(owner.getByRole('table', { name: 'Organization members' })).toBeVisible();
  await expect(owner.getByText('No open invitations')).toBeVisible();
  await expectNoA11yViolations(owner);

  // Validation in the dialog, with the keyboard: Escape closes it and focus returns.
  const inviteButton = owner.getByRole('button', { name: 'Invite member' });
  await inviteButton.click();
  const form = owner.getByRole('form', { name: 'Invite a member' });
  await form.getByRole('button', { name: 'Create invitation' }).click();
  await expect(form.getByRole('textbox', { name: /email/i })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expectNoA11yViolations(owner);
  await owner.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(inviteButton).toBeFocused();

  const inviteeEmail = uniqueEmail('invitee');
  const { dialog, link } = await inviteFromTeamPage(owner, inviteeEmail, 'Agent');
  await expect(dialog.getByText(/Shown once/)).toBeVisible();
  await expectNoA11yViolations(owner);
  await dialog.getByRole('button', { name: 'Done' }).click();
  const invitations = owner.getByRole('list', { name: 'Open invitations' });
  await expect(invitations.getByText(inviteeEmail)).toBeVisible();
  await expect(invitations.getByText('Pending')).toBeVisible();

  // The invitee opens the link signed out; the token leaves the address bar at once.
  const invitee = await freshPage(browser);
  await invitee.goto(link);
  await expect(invitee.getByRole('heading', { name: 'Join Invite Works' })).toBeVisible();
  await expect(invitee).toHaveURL(/\/invite$/);
  await expectNoA11yViolations(invitee);
  await switchTheme(invitee, 'dark');
  // The token is gone after the reload too: the page now says the link is incomplete.
  await expect(
    invitee.getByRole('heading', { name: 'This invitation link is incomplete' }),
  ).toBeVisible();
  await expectNoA11yViolations(invitee);
  await switchTheme(invitee, 'light');

  await invitee.goto(link);
  const signup = invitee.getByRole('form', { name: 'Create your account' });
  await expect(signup.getByRole('textbox', { name: 'Email' })).toHaveValue(inviteeEmail);
  await signup.getByRole('textbox', { name: /your name/i }).fill('Iris Invitee');
  await signup.getByLabel(/^password/i).fill(E2E_PASSWORD);
  await signup.getByRole('button', { name: 'Create account and join' }).click();
  await expect(invitee).toHaveURL(/\/dashboard$/);
  // The invitee joined as an agent, with no organization of their own.
  await invitee.goto('/team');
  await expect(invitee.getByRole('button', { name: 'Invite member' })).toHaveCount(0);

  // The link is spent.
  const replay = await freshPage(browser);
  await replay.goto(link);
  await expect(
    replay.getByRole('heading', { name: 'This invitation can’t be used' }),
  ).toBeVisible();
  await expect(replay.getByText('This invitation has already been used.')).toBeVisible();

  // The owner sees the new member, promotes them and then removes them.
  await owner.reload();
  const members = owner.getByRole('table', { name: 'Organization members' });
  const role = members.getByRole('combobox', { name: 'Role for Iris Invitee' });
  await expect(role).toHaveValue('AGENT');
  await expect(owner.getByText('No open invitations')).toBeVisible();
  await role.selectOption('ADMIN');
  await expect(owner.getByText('Iris Invitee is now admin.')).toBeVisible();

  await members.getByRole('button', { name: 'Remove Iris Invitee' }).click();
  const confirm = owner.getByRole('alertdialog', { name: 'Remove Iris Invitee?' });
  // Focus starts on Cancel in a destructive confirmation.
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectNoA11yViolations(owner);
  await confirm.getByRole('button', { name: 'Remove member' }).click();
  await expect(members.getByText('Iris Invitee')).toHaveCount(0);

  // The removed member is cut off on their next request: with no other organization, the app
  // says so instead of loading the page.
  await invitee.goto('/tickets');
  await expect(invitee.getByText('No organization access')).toBeVisible();
  await expect(invitee.getByRole('heading', { level: 1, name: 'Tickets' })).toHaveCount(0);

  // A second invitation is revoked, and its link stops working.
  const revokedEmail = uniqueEmail('revoked');
  const second = await inviteFromTeamPage(owner, revokedEmail, 'Admin');
  await second.dialog.getByRole('button', { name: 'Done' }).click();
  await owner.getByRole('button', { name: `Revoke invitation for ${revokedEmail}` }).click();
  await owner
    .getByRole('alertdialog', { name: 'Revoke this invitation?' })
    .getByRole('button', { name: 'Revoke invitation' })
    .click();
  await expect(owner.getByText('No open invitations')).toBeVisible();
  const late = await freshPage(browser);
  await late.goto(second.link);
  await expect(
    late.getByText('This invitation was withdrawn. Ask for a new invitation.'),
  ).toBeVisible();

  // Dark theme and phone width on the team page.
  await switchTheme(owner, 'dark');
  await expect(owner.getByRole('table', { name: 'Organization members' })).toBeVisible();
  await expectNoA11yViolations(owner);
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.reload();
  await expect(owner.getByRole('table', { name: 'Organization members' })).toBeVisible();
  const overflow = await owner.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  for (const page of [owner, invitee, replay, late]) await page.context().close();
});

test('an existing account signs in from the link and joins', async ({ browser }) => {
  const owner = await freshPage(browser);
  await signUp(owner, { email: uniqueEmail('host'), organization: 'Host Org' });
  const guestEmail = uniqueEmail('guest');
  const guest = await freshPage(browser);
  await signUp(guest, { email: guestEmail, organization: 'Guest Org' });
  await guest.context().clearCookies();

  await owner.goto('/team');
  const { link } = await inviteFromTeamPage(owner, guestEmail, 'Admin');

  await guest.goto(link);
  await guest.getByRole('button', { name: 'I have an account' }).click();
  const signin = guest.getByRole('form', { name: 'Sign in to accept' });
  await signin.getByLabel(/^password/i).fill(E2E_PASSWORD);
  await signin.getByRole('button', { name: 'Sign in and join' }).click();
  await expect(guest).toHaveURL(/\/dashboard$/);
  // Now in both organizations, with Host Org active.
  await guest.goto('/team');
  await expect(guest.getByRole('button', { name: 'Invite member' })).toBeVisible();
  await expect(guest.getByText('Host Org', { exact: false }).first()).toBeVisible();

  for (const page of [owner, guest]) await page.context().close();
});
