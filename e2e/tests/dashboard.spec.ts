import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { signUp, uniqueEmail } from '../support/users.ts';

// The live dashboard end to end: the real API, the real database and the production CSP
// (vite preview serves vercel.json's headers). Each test signs up a fresh organization, so
// its numbers are exact and its tickets never reach the shared organization other specs use.

/** The fields of GET /api/v1/dashboard these tests read (contract: packages/shared). */
type DashboardSummary = {
  scope: string;
  tickets: {
    byStatus: Record<string, number>;
    active: number;
    awaitingFirstResponse: number;
    unassigned: number | null;
  };
  sla: { active: Record<string, number>; attention: unknown[] };
};

type WithViolations = { cspViolations: string[] };

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const recorded: string[] = [];
    (window as unknown as WithViolations).cspViolations = recorded;
    document.addEventListener('securitypolicyviolation', (event) => {
      recorded.push(`${event.effectiveDirective} blocked ${event.blockedURI}`);
    });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** Creates tickets through the real API, as the signed-in page (cookie, Origin, proxy). */
async function createTickets(page: Page, subjects: string[], baseURL: string) {
  for (const [i, subject] of subjects.entries()) {
    const res = await page.request.post('/api/v1/tickets', {
      headers: { Origin: baseURL },
      data: {
        subject,
        customer: { email: `dashboard-${i}-${Date.now()}@example.com` },
        message: 'Created by the dashboard E2E test.',
        priority: 'NORMAL',
      },
    });
    expect(res.status()).toBe(201);
  }
}

/** Opens the dashboard and returns the summary the page rendered. */
async function openDashboard(page: Page): Promise<DashboardSummary> {
  const response = page.waitForResponse(
    (res) => res.url().endsWith('/api/v1/dashboard') && res.request().method() === 'GET',
  );
  await page.goto('/dashboard');
  const res = await response;
  expect(res.status()).toBe(200);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return (await res.json()) as DashboardSummary;
}

function card(page: Page, heading: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) });
}

const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as WithViolations).cspViolations);

test('a new organization starts empty, then counts its real tickets', async ({ page, baseURL }) => {
  await signUp(page, { email: uniqueEmail('dashboard'), organization: 'Dashboard Live' });

  const empty = await openDashboard(page);
  expect(empty.scope).toBe('organization');
  expect(empty.tickets.active).toBe(0);
  await expect(page.getByRole('heading', { name: 'No tickets yet' })).toBeVisible();

  await createTickets(page, ['Dashboard ticket one', 'Dashboard ticket two'], baseURL ?? '');
  const summary = await openDashboard(page);

  // Straight from the database: two new, unanswered, unassigned tickets on the default SLA.
  expect(summary.tickets).toMatchObject({
    active: 2,
    awaitingFirstResponse: 2,
    unassigned: 2,
    byStatus: { OPEN: 2, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 },
  });
  expect(summary.sla.active.on_track).toBe(2);
  expect(summary.sla.attention).toEqual([]);

  await expect(card(page, 'Active tickets')).toContainText('2');
  await expect(card(page, 'Active tickets')).toContainText('2 open · 0 pending · 0 on hold');
  await expect(card(page, 'Awaiting first response')).toContainText('2');
  await expect(card(page, 'Avg. first response')).toContainText(
    'No first replies in the last 30 days',
  );
  await expect(card(page, 'Tickets by status')).toContainText('All 2 tickets, by current status');
  await expect(card(page, 'SLA health')).toContainText('2 tickets, 100%');
  await expect(card(page, 'SLA health')).toContainText('Nothing is at risk or breached.');
  await expect(card(page, 'Workload by agent')).toContainText(
    'No active tickets are assigned to anyone yet.',
  );
  await expect(page.getByRole('link', { name: /Unassigned active tickets/ })).toContainText('2');
  await expect(page.getByText(/sample data/i)).toHaveCount(0);

  expect(await cspViolations(page)).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`has no WCAG 2.2 AA violations with live data in ${theme} mode`, async ({
    page,
    baseURL,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('pulsedesk-theme', value), theme);
    await signUp(page, { email: uniqueEmail(`dash-${theme}`), organization: `Dashboard ${theme}` });
    await createTickets(page, [`A11y ${theme} ticket`], baseURL ?? '');

    await openDashboard(page);
    await expect(card(page, 'SLA health')).toBeVisible();
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expectNoA11yViolations(page);
    expect(await cspViolations(page)).toEqual([]);
  });
}

for (const [device, viewport] of [
  ['phone', { width: 375, height: 812 }],
  ['tablet', { width: 768, height: 1024 }],
] as const) {
  test(`fits a ${device} screen without horizontal scrolling`, async ({ page, baseURL }) => {
    await signUp(page, {
      email: uniqueEmail(`dash-${device}`),
      organization: `Dashboard ${device}`,
    });
    await createTickets(page, [`${device} ticket`], baseURL ?? '');
    await page.setViewportSize(viewport);

    await openDashboard(page);
    await expect(card(page, 'SLA health')).toBeVisible();
    await expect(card(page, 'Workload by agent')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await cspViolations(page)).toEqual([]);
  });
}
