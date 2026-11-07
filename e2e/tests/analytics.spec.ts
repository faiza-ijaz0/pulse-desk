import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from '../support/a11y.ts';
import { signUp, uniqueEmail } from '../support/users.ts';

// Analytics end to end: the real API, the real database and the production CSP (vite preview
// serves vercel.json's headers). Each test signs up a fresh organization and builds its
// history through the real ticket endpoints, so every figure is exact.

/** The fields of GET /api/v1/analytics these tests read (contract: packages/shared). */
type AnalyticsReport = {
  scope: string;
  range: { from: string; to: string; timeZone: string };
  totals: { created: number; solved: number; reopened: number };
  responseTimes: { firstResponse: { count: number }; resolution: { count: number } };
  sla: { firstResponse: { met: number; breached: number } };
  agents: { solved: number; publicReplies: number; firstResponses: { count: number } }[];
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

/**
 * A short history through the real API, as the signed-in page: two tickets created, the
 * first answered publicly (its first response) and solved.
 */
async function buildHistory(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const numbers: number[] = [];
  for (const subject of ['Analytics ticket one', 'Analytics ticket two']) {
    const res = await page.request.post('/api/v1/tickets', {
      headers,
      data: {
        subject,
        customer: { email: `analytics-${numbers.length}-${Date.now()}@example.com` },
        message: 'Created by the analytics E2E test.',
        priority: 'NORMAL',
      },
    });
    expect(res.status()).toBe(201);
    numbers.push(((await res.json()) as { ticket: { number: number } }).ticket.number);
  }
  const [first] = numbers;
  const reply = await page.request.post(`/api/v1/tickets/${first}/messages`, {
    headers,
    data: { body: 'Thanks, looking into it.', visibility: 'PUBLIC' },
  });
  expect(reply.status()).toBe(201);
  const solve = await page.request.patch(`/api/v1/tickets/${first}`, {
    headers,
    data: { status: 'SOLVED' },
  });
  expect(solve.ok()).toBe(true);
}

/** Opens analytics (optionally at `search`) and returns the report the page rendered. */
async function openAnalytics(page: Page, search = ''): Promise<AnalyticsReport> {
  const response = page.waitForResponse(
    (res) => res.url().includes('/api/v1/analytics') && res.request().method() === 'GET',
  );
  await page.goto(`/analytics${search}`);
  const res = await response;
  expect(res.status()).toBe(200);
  return (await res.json()) as AnalyticsReport;
}

function card(page: Page, heading: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) });
}

const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as WithViolations).cspViolations);

test('a new organization starts quiet, then reports its real history', async ({
  page,
  baseURL,
}) => {
  await signUp(page, { email: uniqueEmail('analytics'), organization: 'Analytics Live' });

  const empty = await openAnalytics(page);
  expect(empty.totals).toEqual({ created: 0, solved: 0, reopened: 0 });
  await expect(page.getByText('No activity in this period')).toBeVisible();

  await buildHistory(page, baseURL ?? '');
  const report = await openAnalytics(page);

  // Straight from the database: the browser's own time zone, two created, one answered
  // and solved, both on the default SLA (the reply met its first-response target).
  expect(report.scope).toBe('organization');
  expect(report.range.timeZone).not.toBe('');
  expect(report.totals).toEqual({ created: 2, solved: 1, reopened: 0 });
  expect(report.responseTimes.firstResponse.count).toBe(1);
  expect(report.responseTimes.resolution.count).toBe(1);
  expect(report.sla.firstResponse).toEqual({ met: 1, breached: 0 });
  expect(report.agents[0]).toMatchObject({
    solved: 1,
    publicReplies: 1,
    firstResponses: { count: 1 },
  });

  await expect(card(page, 'Tickets created')).toContainText('2');
  await expect(card(page, 'Tickets solved')).toContainText('0 reopens in this period');
  await expect(card(page, 'Median first response')).toContainText('Median of 1 first reply');
  await expect(card(page, 'SLA performance')).toContainText('100%');
  await expect(card(page, 'Agent performance')).toContainText('Owner');

  // Presets change the URL and the request; the table view lists exact values.
  const sevenDays = page.waitForResponse((res) => res.url().includes('/api/v1/analytics?'));
  await page.getByRole('button', { name: '7 days' }).click();
  expect((await sevenDays).status()).toBe(200);
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  const volume = card(page, 'Created vs solved');
  await volume.getByRole('button', { name: 'Table' }).click();
  await expect(volume.getByRole('table')).toBeVisible();

  expect(await cspViolations(page)).toEqual([]);
});

test('the API refuses an organization hint and a future range', async ({ page }) => {
  await signUp(page, { email: uniqueEmail('analytics-api'), organization: 'Analytics API' });

  const hinted = await page.request.get(
    '/api/v1/analytics?organizationId=6f1c2b7e-0000-4000-8000-000000000000',
  );
  expect(hinted.status()).toBe(400);
  const future = await page.request.get('/api/v1/analytics?to=2999-01-01');
  expect(future.status()).toBe(400);
});

for (const theme of ['light', 'dark'] as const) {
  test(`has no WCAG 2.2 AA violations with live data in ${theme} mode`, async ({
    page,
    baseURL,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('pulsedesk-theme', value), theme);
    await signUp(page, {
      email: uniqueEmail(`analytics-${theme}`),
      organization: `Analytics ${theme}`,
    });
    await buildHistory(page, baseURL ?? '');

    await openAnalytics(page);
    await expect(card(page, 'SLA performance')).toBeVisible();
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
      email: uniqueEmail(`analytics-${device}`),
      organization: `Analytics ${device}`,
    });
    await buildHistory(page, baseURL ?? '');
    await page.setViewportSize(viewport);

    // The longest range: 53 weekly columns must still fit.
    await openAnalytics(page);
    await page.getByRole('button', { name: '12 months' }).click();
    await expect(page).toHaveURL(/from=/);
    await expect(card(page, 'Created vs solved')).toBeVisible();
    await expect(card(page, 'Agent performance')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await cspViolations(page)).toEqual([]);
  });
}
