import {
  addCalendarDays,
  calendarDateIn,
  type AnalyticsBucket,
  type AnalyticsReport,
} from '@pulsedesk/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, problem, renderApp } from '@/test/render';
import { browserTimeZone } from './range';

// The analytics page renders only what GET /api/v1/analytics returns. Every case stubs that
// endpoint (matched by path prefix, so the query string can be asserted separately).

afterEach(() => vi.restoreAllMocks());

const outcomes = (met: number, breached: number) => ({ met, breached });
const noTime = { count: 0, averageSeconds: null };

function day(start: string, values: Partial<AnalyticsBucket> = {}): AnalyticsBucket {
  return {
    start,
    end: start,
    created: 0,
    solved: 0,
    reopened: 0,
    firstResponse: noTime,
    resolution: noTime,
    firstResponseBreaches: 0,
    resolutionBreaches: 0,
    ...values,
  };
}

const REPORT: AnalyticsReport = {
  scope: 'organization',
  generatedAt: '2026-11-07T12:00:00.000Z',
  range: {
    from: '2026-11-05',
    to: '2026-11-07',
    timeZone: 'UTC',
    granularity: 'day',
    startsAt: '2026-11-05T00:00:00.000Z',
    endsAt: '2026-11-08T00:00:00.000Z',
  },
  buckets: [
    day('2026-11-05', { created: 5, solved: 2, firstResponse: { count: 3, averageSeconds: 1800 } }),
    day('2026-11-06', { created: 4, solved: 3, reopened: 1 }),
    day('2026-11-07', {
      created: 3,
      solved: 4,
      resolution: { count: 4, averageSeconds: 7200 },
    }),
  ],
  totals: { created: 12, solved: 9, reopened: 1 },
  createdByCurrentStatus: { OPEN: 3, PENDING: 1, ON_HOLD: 0, SOLVED: 6, CLOSED: 2 },
  responseTimes: {
    firstResponse: { count: 3, averageSeconds: 1800, medianSeconds: 2700 },
    resolution: { count: 4, averageSeconds: 7200, medianSeconds: 5400 },
  },
  sla: {
    firstResponse: outcomes(8, 2),
    resolution: outcomes(3, 1),
    byPriority: [
      { priority: 'LOW', firstResponse: outcomes(0, 0), resolution: outcomes(0, 0) },
      { priority: 'NORMAL', firstResponse: outcomes(5, 0), resolution: outcomes(2, 0) },
      { priority: 'HIGH', firstResponse: outcomes(2, 1), resolution: outcomes(1, 0) },
      { priority: 'URGENT', firstResponse: outcomes(1, 1), resolution: outcomes(0, 1) },
    ],
  },
  agents: [
    {
      userId: '7a1c2e4f-1111-4a52-8c11-0e9b6f4d2a01',
      name: 'Priya Agent',
      role: 'AGENT',
      solved: 7,
      publicReplies: 15,
      firstResponses: { count: 3, averageSeconds: 1800 },
    },
    {
      userId: '0b7c4c1e-6a43-4c1e-9f3a-6f1c2a9d8e01',
      name: 'Maya Chen',
      role: 'OWNER',
      solved: 2,
      publicReplies: 0,
      firstResponses: noTime,
    },
  ],
};

const QUIET: AnalyticsReport = {
  ...REPORT,
  buckets: REPORT.buckets.map((b) => day(b.start)),
  totals: { created: 0, solved: 0, reopened: 0 },
  createdByCurrentStatus: { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 },
  responseTimes: {
    firstResponse: { count: 0, averageSeconds: null, medianSeconds: null },
    resolution: { count: 0, averageSeconds: null, medianSeconds: null },
  },
  sla: {
    firstResponse: outcomes(0, 0),
    resolution: outcomes(0, 0),
    byPriority: REPORT.sla.byPriority.map((p) => ({
      ...p,
      firstResponse: outcomes(0, 0),
      resolution: outcomes(0, 0),
    })),
  },
  agents: REPORT.agents.map((a) => ({ ...a, solved: 0, publicReplies: 0, firstResponses: noTime })),
};

type Reply = AnalyticsReport | Response | Promise<never>;

/** Answers GET /api/v1/analytics?… with `responses` in turn (the last one repeats). */
function serve(...responses: Reply[]) {
  const spy = mockApi();
  const fallback = spy.getMockImplementation();
  const requests: URL[] = [];
  let call = 0;
  spy.mockImplementation((input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (path.startsWith('/api/v1/analytics')) {
      requests.push(new URL(path, 'http://localhost'));
      const next = responses[Math.min(call++, responses.length - 1)];
      if (next instanceof Promise) return next;
      return Promise.resolve(next instanceof Response ? next : Response.json(next));
    }
    return fallback!(input, init);
  });
  return { spy, requests };
}

const zone = browserTimeZone();
const today = () => calendarDateIn(new Date(), zone);

const card = (title: string) => {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const section = heading.closest('section');
  if (!section) throw new Error(`No card titled ${title}`);
  return section;
};

describe('analytics page', () => {
  it('asks for the last 30 days in the viewer’s time zone', async () => {
    const { requests } = serve(REPORT);
    renderApp('/analytics');

    await screen.findByRole('heading', { level: 2, name: 'Tickets created' });
    const params = Object.fromEntries(requests[0]!.searchParams);
    expect(params).toEqual({ from: addCalendarDays(today(), -29), to: today(), tz: zone });
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders every figure from the API response', async () => {
    serve(REPORT);
    renderApp('/analytics');

    expect(await screen.findByRole('heading', { level: 2, name: 'Tickets created' })).toBeVisible();
    expect(within(card('Tickets created')).getByText('12')).toBeInTheDocument();
    expect(within(card('Tickets solved')).getByText('9')).toBeInTheDocument();
    expect(within(card('Tickets solved')).getByText('1 reopen in this period')).toBeInTheDocument();
    expect(within(card('Median first response')).getByText('45 min')).toBeInTheDocument();
    expect(
      within(card('Median first response')).getByText('Median of 3 first replies · average 30 min'),
    ).toBeInTheDocument();
    expect(within(card('Median resolution time')).getByText('1 h 30 min')).toBeInTheDocument();

    // Every bucket is described for assistive tech.
    const volume = card('Created vs solved');
    expect(
      within(volume).getByRole('img', { name: 'Nov 6: Created 4, Solved 3' }),
    ).toBeInTheDocument();
    const firstReply = card('First response time');
    expect(
      within(firstReply).getByRole('img', { name: 'Nov 6: Average No first replies' }),
    ).toBeInTheDocument();

    const sla = card('SLA performance');
    expect(within(sla).getByText('80%')).toBeInTheDocument();
    expect(within(sla).getByText('75%')).toBeInTheDocument();
    const urgent = within(sla).getByRole('row', { name: /Urgent/ });
    expect(urgent).toHaveTextContent('50%(1/2)0%(0/1)');
    expect(within(sla).getByRole('row', { name: /Low/ })).toHaveTextContent('Low——');

    expect(
      within(card('Where new tickets are now')).getByText(
        'The 12 tickets created in this period, by current status',
      ),
    ).toBeInTheDocument();

    const rows = within(card('Agent performance')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Priya AgentAgent715330 min');
    // No first replies: the average reads "—", announced as "No data".
    expect(rows[2]).toHaveTextContent('Maya ChenOwner200—No data');
  });

  it('lists exact values in the table view', async () => {
    serve(REPORT);
    renderApp('/analytics');

    const volume = await screen.findByRole('heading', { level: 2, name: 'Created vs solved' });
    const section = volume.closest('section')!;
    await userEvent.click(within(section).getByRole('button', { name: 'Table' }));

    const rows = within(section).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'DayCreatedSolved',
      'Nov 552',
      'Nov 643',
      'Nov 734',
    ]);
  });

  it('shows a skeleton, never zeros, while loading', async () => {
    serve(new Promise<never>(() => undefined));
    renderApp('/analytics');

    expect(await screen.findByText('Loading analytics…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tickets created' })).not.toBeInTheDocument();
  });

  it('says so when nothing happened in the range', async () => {
    serve(QUIET);
    renderApp('/analytics');

    expect(await screen.findByText('No activity in this period')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Created vs solved' })).not.toBeInTheDocument();
    // The range can still be changed.
    expect(screen.getByRole('button', { name: '90 days' })).toBeInTheDocument();
  });

  it('presents an agent’s own scope', async () => {
    serve({ ...REPORT, scope: 'own', agents: [REPORT.agents[0]!] });
    renderApp('/analytics');

    expect(await screen.findByText('Your tickets')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your activity' })).toBeInTheDocument();
  });

  it('switches presets through the URL and asks for the new range', async () => {
    const { requests } = serve(REPORT);
    const { router } = renderApp('/analytics');
    await screen.findByRole('heading', { level: 2, name: 'Tickets created' });

    await userEvent.click(screen.getByRole('button', { name: '7 days' }));

    const from = addCalendarDays(today(), -6);
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('from')).toBe(from));
    expect(router.state.location.search).toBe(`?from=${from}&to=${today()}`);
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens a custom range from the URL and refuses a reversed one', async () => {
    const { requests } = serve(REPORT);
    renderApp('/analytics?from=2026-01-01&to=2026-01-31');
    await screen.findByRole('heading', { level: 2, name: 'Tickets created' });

    expect(requests[0]?.searchParams.get('from')).toBe('2026-01-01');
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    const form = screen.getByRole('form', { name: 'Custom date range' });
    const from = within(form).getByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-02-15');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply' }));

    expect(within(form).getByRole('alert')).toHaveTextContent(
      'The start date must be on or before the end date.',
    );
    expect(requests).toHaveLength(1);
  });

  it('names the years when a range crosses one', async () => {
    serve({
      ...REPORT,
      range: { ...REPORT.range, from: '2025-12-30', to: '2026-01-01' },
      buckets: [day('2025-12-30'), day('2025-12-31', { created: 2 }), day('2026-01-01')],
    });
    renderApp('/analytics?from=2025-12-30&to=2026-01-01');

    expect(await screen.findByText(/Dec 30, 2025 – Jan 1, 2026/)).toBeInTheDocument();
    await screen.findByRole('heading', { level: 2, name: 'Created vs solved' });
    expect(
      within(card('Created vs solved')).getByRole('img', {
        name: 'Dec 31, 2025: Created 2, Solved 0',
      }),
    ).toBeInTheDocument();
  });

  it('ignores an invalid range in the URL and uses the default', async () => {
    const { requests } = serve(REPORT);
    renderApp('/analytics?from=2026-02-30&to=2999-01-01');
    await screen.findByRole('heading', { level: 2, name: 'Tickets created' });

    expect(requests[0]?.searchParams.get('to')).toBe(today());
  });

  it('offers a retry when the API fails, and recovers', async () => {
    serve(problem(500, 'INTERNAL_ERROR'), REPORT);
    renderApp('/analytics');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('We couldn’t load analytics')).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Tickets created' })).toBeVisible();
  });

  it('handles an expired session and a role without access', async () => {
    serve(problem(401, 'UNAUTHENTICATED'));
    const first = renderApp('/analytics');
    expect(await screen.findByText('Your session has ended')).toBeInTheDocument();
    first.unmount();
    vi.restoreAllMocks();

    serve(problem(403, 'FORBIDDEN'));
    renderApp('/analytics');
    expect(await screen.findByText('Analytics unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
