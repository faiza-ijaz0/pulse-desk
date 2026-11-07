import type { DashboardSummary } from '@pulsedesk/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, problem, renderApp } from '@/test/render';

// The live dashboard renders only what GET /api/v1/dashboard returns. Every case stubs that
// endpoint; nothing on the page may come from fixtures in the app itself.

afterEach(() => vi.restoreAllMocks());

const ZERO_SLA = {
  none: 0,
  met: 0,
  on_track: 0,
  at_risk: 0,
  first_response_breached: 0,
  resolution_breached: 0,
};

const SUMMARY: DashboardSummary = {
  scope: 'organization',
  generatedAt: '2026-11-04T12:00:00.000Z',
  tickets: {
    byStatus: { OPEN: 7, PENDING: 2, ON_HOLD: 1, SOLVED: 4, CLOSED: 9 },
    active: 10,
    awaitingFirstResponse: 3,
    unassigned: 2,
  },
  sla: {
    active: {
      ...ZERO_SLA,
      on_track: 5,
      at_risk: 2,
      first_response_breached: 1,
      resolution_breached: 1,
      none: 1,
    },
    attention: [
      {
        number: 41,
        subject: 'Meter offline',
        priority: 'URGENT',
        status: 'resolution_breached',
        target: 'resolution',
        dueAt: '2026-11-04T09:00:00.000Z',
      },
      {
        number: 42,
        subject: 'Charged twice',
        priority: 'HIGH',
        status: 'at_risk',
        target: 'firstResponse',
        dueAt: '2026-11-04T12:20:00.000Z',
      },
    ],
  },
  responseTimes: {
    windowDays: 30,
    windowStart: '2026-10-05T12:00:00.000Z',
    firstResponse: { count: 12, averageSeconds: 2700 },
    resolution: { count: 1, averageSeconds: 93_600 },
  },
  agents: [
    {
      userId: '7a1c2e4f-1111-4a52-8c11-0e9b6f4d2a01',
      name: 'Priya Agent',
      role: 'AGENT',
      active: 6,
      open: 4,
      pending: 1,
      onHold: 1,
      atRisk: 2,
      breached: 1,
    },
    {
      userId: '0b7c4c1e-6a43-4c1e-9f3a-6f1c2a9d8e01',
      name: 'Maya Chen',
      role: 'OWNER',
      active: 2,
      open: 2,
      pending: 0,
      onHold: 0,
      atRisk: 0,
      breached: 0,
    },
  ],
};

const EMPTY: DashboardSummary = {
  ...SUMMARY,
  tickets: {
    byStatus: { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 },
    active: 0,
    awaitingFirstResponse: 0,
    unassigned: 0,
  },
  sla: { active: ZERO_SLA, attention: [] },
  responseTimes: {
    ...SUMMARY.responseTimes,
    firstResponse: { count: 0, averageSeconds: null },
    resolution: { count: 0, averageSeconds: null },
  },
  agents: [{ ...SUMMARY.agents[1]!, active: 0, open: 0 }],
};

function serve(...responses: (DashboardSummary | Response | Promise<never>)[]) {
  let call = 0;
  return mockApi({
    routes: {
      'GET /api/v1/dashboard': () => {
        const next = responses[Math.min(call++, responses.length - 1)];
        if (next instanceof Promise) return next;
        return next instanceof Response ? next : Response.json(next);
      },
    },
  });
}

const metricCard = (label: string) => {
  const heading = screen.getByRole('heading', { level: 2, name: label });
  const card = heading.closest('section');
  if (!card) throw new Error(`No card for ${label}`);
  return card;
};

describe('live dashboard', () => {
  it('renders every figure from the API response', async () => {
    serve(SUMMARY);
    renderApp('/dashboard');

    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.getByText(/All tickets in this organization/)).toBeInTheDocument();

    expect(within(metricCard('Active tickets')).getByText('10')).toBeInTheDocument();
    expect(
      within(metricCard('Active tickets')).getByText('7 open · 2 pending · 1 on hold'),
    ).toBeInTheDocument();
    expect(within(metricCard('Awaiting first response')).getByText('3')).toBeInTheDocument();
    expect(within(metricCard('Avg. first response')).getByText('45 min')).toBeInTheDocument();
    expect(
      within(metricCard('Avg. first response')).getByText(
        'Average of 12 first replies · last 30 days',
      ),
    ).toBeInTheDocument();
    expect(within(metricCard('Avg. resolution time')).getByText('1 d 2 h')).toBeInTheDocument();
    expect(
      within(metricCard('Avg. resolution time')).getByText(
        'Average of 1 solved ticket · last 30 days',
      ),
    ).toBeInTheDocument();

    // SLA legend: every state with its count, labelled like the inbox badges.
    const sla = metricCard('SLA health');
    const legend = within(sla)
      .getAllByRole('definition')
      .map((dd) => dd.textContent);
    expect(legend).toEqual([
      '1 ticket, 10%',
      '1 ticket, 10%',
      '2 tickets, 20%',
      '5 tickets, 50%',
      '0 tickets, 0%',
      '1 ticket, 10%',
    ]);
    expect(within(sla).getByText('Resolution breached', { selector: 'dt' })).toBeInTheDocument();

    // Tickets needing attention link to the ticket.
    expect(within(sla).getByRole('link', { name: /#41 Meter offline/ })).toHaveAttribute(
      'href',
      '/tickets/41',
    );
    expect(within(sla).getByRole('link', { name: /#42 Charged twice/ })).toHaveTextContent(
      /First reply due/,
    );

    const status = metricCard('Tickets by status');
    expect(within(status).getByText('All 23 tickets, by current status')).toBeInTheDocument();

    const workload = metricCard('Workload by agent');
    const agentLinks = within(workload).getAllByRole('link');
    expect(agentLinks[0]).toHaveTextContent(/Priya Agent/);
    expect(agentLinks[0]).toHaveTextContent('2 at risk');
    // The inbox opens on the same active tickets the count covers, not solved or closed ones.
    expect(agentLinks[0]).toHaveAttribute(
      'href',
      '/tickets?status=OPEN%2CPENDING%2CON_HOLD&assignee=7a1c2e4f-1111-4a52-8c11-0e9b6f4d2a01',
    );
    expect(
      within(workload).getByRole('link', { name: /Unassigned active tickets/ }),
    ).toHaveAttribute('href', '/tickets?status=OPEN%2CPENDING%2CON_HOLD&assignee=unassigned');
  });

  it('contains no sample or preview content', async () => {
    serve(SUMMARY);
    renderApp('/dashboard');

    await screen.findByText('Live');
    expect(screen.queryByText(/sample data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/design preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/vs previous 7 days/i)).not.toBeInTheDocument();
  });

  it('shows a skeleton, never zeros, while loading', async () => {
    serve(new Promise<never>(() => undefined));
    renderApp('/dashboard');

    expect(await screen.findByText('Loading dashboard metrics…')).toHaveAttribute('role', 'status');
    expect(screen.getByText(/Loading live metrics/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Active tickets' })).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('explains an empty organization instead of showing empty charts', async () => {
    serve(EMPTY);
    renderApp('/dashboard');

    expect(await screen.findByRole('heading', { name: 'No tickets yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the inbox' })).toHaveAttribute(
      'href',
      '/tickets',
    );
    expect(screen.queryByRole('heading', { name: 'SLA health' })).not.toBeInTheDocument();
  });

  it('says when no tickets are assigned, and shows missing averages as no data', async () => {
    serve({
      ...SUMMARY,
      sla: { active: { ...ZERO_SLA, none: 10 }, attention: [] },
      responseTimes: {
        ...SUMMARY.responseTimes,
        firstResponse: { count: 0, averageSeconds: null },
      },
      agents: SUMMARY.agents.map((a) => ({
        ...a,
        active: 0,
        open: 0,
        pending: 0,
        onHold: 0,
        atRisk: 0,
        breached: 0,
      })),
    });
    renderApp('/dashboard');

    expect(
      await screen.findByText('No active tickets are assigned to anyone yet.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Nothing is at risk or breached.')).toBeInTheDocument();
    const firstResponse = metricCard('Avg. first response');
    expect(within(firstResponse).getByText('No data')).toBeInTheDocument();
    expect(
      within(firstResponse).getByText('No first replies in the last 30 days'),
    ).toBeInTheDocument();
  });

  it("presents an agent's own scope", async () => {
    serve({
      ...SUMMARY,
      scope: 'own',
      tickets: { ...SUMMARY.tickets, unassigned: null },
      agents: [SUMMARY.agents[0]!],
    });
    renderApp('/dashboard');

    expect(await screen.findByText(/Tickets assigned to you/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your workload' })).toBeInTheDocument();
    expect(screen.queryByText('Unassigned active tickets')).not.toBeInTheDocument();
  });

  it('offers a retry when the API fails, and recovers', async () => {
    serve(problem(500, 'INTERNAL_ERROR'), SUMMARY);
    renderApp('/dashboard');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('We couldn’t load the dashboard')).toBeInTheDocument();
    expect(within(alert).getByText(/reference test-request-id/)).toBeInTheDocument();

    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('keeps the last figures with a warning when a refresh fails', async () => {
    serve(SUMMARY, problem(503, 'SERVICE_UNAVAILABLE'));
    renderApp('/dashboard');

    await screen.findByText('Live');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh metrics' }));

    expect(await screen.findByText('Couldn’t refresh the metrics')).toBeInTheDocument();
    expect(within(metricCard('Active tickets')).getByText('10')).toBeInTheDocument();
  });

  it('sends an expired session back to sign-in', async () => {
    const fetchSpy = serve(problem(401, 'UNAUTHENTICATED'));
    const { router } = renderApp('/dashboard');

    expect(await screen.findByText('Your session has ended')).toBeInTheDocument();
    // The session is gone server-side too: re-reading it answers 401 like the dashboard did.
    fetchSpy.mockImplementation((input) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        path === '/health' ? Response.json({ status: 'ok' }) : problem(401, 'UNAUTHENTICATED'),
      );
    });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('explains a role without dashboard access', async () => {
    serve(problem(403, 'FORBIDDEN'));
    renderApp('/dashboard');

    expect(await screen.findByText('Dashboard unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
