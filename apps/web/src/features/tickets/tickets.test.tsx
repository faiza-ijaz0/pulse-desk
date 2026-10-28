import type { TicketDetailResponse, TicketListResponse, TicketSummary } from '@pulsedesk/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN_SESSION, mockApi, problem, renderApp } from '@/test/render';

const ME = SIGNED_IN_SESSION.user.id;
const AGENT = '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f';
const BILLING = '7e6d5c4b-3a29-4f18-8e07-d6c5b4a39281';
const VIP = '3b2a1908-f7e6-4d5c-8b4a-39281706f5e4';
const CURSOR = 'eyJzIjoibmV3ZXN0IiwiYSI6IjIwMjYtMTAtMjBUMDg6MDA6MDAuMDAwWiIsIm4iOjF9';

function ticket(number: number, overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    number,
    subject: `Ticket subject ${number}`,
    status: 'OPEN',
    priority: 'NORMAL',
    channel: 'EMAIL',
    customer: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Ada Customer',
      email: 'ada@example.com',
    },
    assignee: null,
    team: null,
    tags: [],
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstRespondedAt: null,
    solvedAt: null,
    closedAt: null,
    firstResponseBreachedAt: null,
    resolutionBreachedAt: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
    ...overrides,
  };
}

const page = (data: TicketSummary[], nextCursor: string | null = null): TicketListResponse => ({
  data,
  nextCursor,
});

const json = (body: unknown) => () => Response.json(body);

/** Filter option endpoints shared by every inbox test. */
const OPTIONS = {
  'GET /api/v1/members': json({
    data: [
      {
        userId: ME,
        name: 'Maya Chen',
        email: 'maya@brightwave.test',
        role: 'OWNER',
        joinedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        userId: AGENT,
        name: 'Jonah Reyes',
        email: 'jonah@brightwave.test',
        role: 'AGENT',
        joinedAt: '2026-10-02T00:00:00.000Z',
      },
    ],
  }),
  'GET /api/v1/teams': json({ data: [{ id: BILLING, name: 'Billing', members: [] }] }),
  'GET /api/v1/tags': json({ data: [{ id: VIP, name: 'vip', color: '#d97706', ticketCount: 0 }] }),
};

function inboxApi(routes: Record<string, () => Response | Promise<Response>>) {
  return mockApi({ routes: { ...OPTIONS, ...routes } });
}

const requestedPaths = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.map(([input]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );

describe('ticket inbox', () => {
  it('lists tickets from the API with status, priority, assignee, team and tags', async () => {
    inboxApi({
      'GET /api/v1/tickets': json(
        page([
          ticket(12, {
            subject: 'Refund for duplicate charge',
            status: 'PENDING',
            priority: 'URGENT',
            assignee: { userId: AGENT, name: 'Jonah Reyes' },
            team: { id: BILLING, name: 'Billing' },
            tags: [{ id: VIP, name: 'vip', color: '#d97706' }],
          }),
          ticket(11),
        ]),
      ),
    });
    renderApp('/tickets');

    expect(await screen.findByRole('heading', { level: 1, name: 'Tickets' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Tickets' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    const first = within(rows[0]!);
    expect(first.getByRole('link', { name: /#12 Refund for duplicate charge/ })).toHaveAttribute(
      'href',
      '/tickets/12',
    );
    expect(first.getByText('Pending')).toBeInTheDocument();
    expect(first.getByText('Urgent')).toBeInTheDocument();
    expect(first.getByText('Jonah Reyes')).toBeInTheDocument();
    expect(first.getByText('Billing')).toBeInTheDocument();
    expect(first.getByText('vip')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 tickets')).toBeInTheDocument();
    expect(screen.queryByText(/sample data/i)).not.toBeInTheDocument();
  });

  it('announces loading while the first page is on its way', async () => {
    let release: (response: Response) => void = () => undefined;
    inboxApi({
      'GET /api/v1/tickets': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    renderApp('/tickets');

    expect(await screen.findByRole('status', { name: 'Loading tickets' })).toBeInTheDocument();
    release(Response.json(page([ticket(1)])));
    expect(await screen.findByRole('link', { name: /#1 Ticket subject 1/ })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading tickets' })).not.toBeInTheDocument();
  });

  it('explains an empty organization', async () => {
    inboxApi({ 'GET /api/v1/tickets': json(page([])) });
    renderApp('/tickets');
    expect(await screen.findByRole('heading', { name: 'No tickets yet' })).toBeInTheDocument();
  });

  it('offers to clear filters when nothing matches them', async () => {
    const user = userEvent.setup();
    inboxApi({
      'GET /api/v1/tickets?status=SOLVED': json(page([])),
      'GET /api/v1/tickets': json(page([ticket(1)])),
    });
    const { router } = renderApp('/tickets?status=SOLVED');

    expect(
      await screen.findByRole('heading', { name: 'No tickets match these filters' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all tickets' }));

    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(await screen.findByRole('link', { name: /#1 Ticket subject 1/ })).toBeInTheDocument();
  });

  it('shows an error with a retry that refetches', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    inboxApi({
      'GET /api/v1/tickets': () =>
        ++attempts === 1 ? problem(500, 'INTERNAL_ERROR') : Response.json(page([ticket(3)])),
    });
    renderApp('/tickets');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Couldn’t load tickets')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /#3 Ticket subject 3/ })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('applies filters from the URL to the request and the controls', async () => {
    const fetchMock = inboxApi({
      [`GET /api/v1/tickets?status=OPEN&assignee=me&team=${BILLING}&sort=oldest`]: json(
        page([ticket(5)]),
      ),
    });
    renderApp(`/tickets?status=OPEN&assignee=me&team=${BILLING}&sort=oldest`);

    expect(await screen.findByRole('link', { name: /#5 Ticket subject 5/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('OPEN');
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveValue('me');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue(BILLING),
    );
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('oldest');
    expect(requestedPaths(fetchMock)).not.toContain('/api/v1/tickets');
  });

  it('ignores invalid filter values in the URL instead of failing', async () => {
    inboxApi({ 'GET /api/v1/tickets?priority=HIGH': json(page([ticket(8)])) });
    renderApp('/tickets?priority=HIGH&status=bogus&assignee=nobody&limit=5000');
    expect(await screen.findByRole('link', { name: /#8 Ticket subject 8/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
  });

  it('writes filter changes to the URL and refetches', async () => {
    const user = userEvent.setup();
    const fetchMock = inboxApi({
      'GET /api/v1/tickets': json(page([ticket(1), ticket(2)])),
      'GET /api/v1/tickets?status=OPEN%2CPENDING%2CON_HOLD': json(page([ticket(2)])),
      'GET /api/v1/tickets?status=OPEN%2CPENDING%2CON_HOLD&assignee=unassigned': json(page([])),
    });
    const { router } = renderApp('/tickets');
    await screen.findByRole('link', { name: /#1 Ticket subject 1/ });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'active');
    await waitFor(() =>
      expect(router.state.location.search).toBe('?status=OPEN%2CPENDING%2CON_HOLD'),
    );
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /#1 Ticket subject 1/ })).not.toBeInTheDocument(),
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Assignee' }), 'unassigned');
    expect(
      await screen.findByRole('heading', { name: 'No tickets match these filters' }),
    ).toBeInTheDocument();
    expect(requestedPaths(fetchMock)).toContain(
      '/api/v1/tickets?status=OPEN%2CPENDING%2CON_HOLD&assignee=unassigned',
    );
  });

  it('loads further pages with the cursor and appends them', async () => {
    const user = userEvent.setup();
    inboxApi({
      'GET /api/v1/tickets': json(page([ticket(9), ticket(8)], CURSOR)),
      [`GET /api/v1/tickets?cursor=${CURSOR}`]: json(page([ticket(7)])),
    });
    renderApp('/tickets');

    await user.click(await screen.findByRole('button', { name: 'Load more tickets' }));
    expect(await screen.findByRole('link', { name: /#7 Ticket subject 7/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /#\d+ Ticket subject/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more tickets' })).not.toBeInTheDocument();
  });

  it('is reachable from the sidebar as a real page', async () => {
    inboxApi({ 'GET /api/v1/tickets': json(page([])) });
    renderApp('/tickets');
    await screen.findByRole('heading', { level: 1, name: 'Tickets' });
    expect(screen.queryByText(/Planned · /)).not.toBeInTheDocument();
  });
});

const DETAIL: TicketDetailResponse = {
  ticket: ticket(12, {
    subject: 'Refund for duplicate charge',
    status: 'PENDING',
    priority: 'HIGH',
    assignee: { userId: AGENT, name: 'Jonah Reyes' },
    team: { id: BILLING, name: 'Billing' },
    tags: [{ id: VIP, name: 'vip', color: null }],
  }),
  conversation: [
    {
      id: 'a0000000-0000-4000-8000-000000000001',
      visibility: 'PUBLIC',
      author: {
        type: 'CUSTOMER',
        customerId: '11111111-1111-4111-8111-111111111111',
        name: 'Ada Customer',
        email: 'ada@example.com',
      },
      body: 'I was charged twice this month.',
      createdAt: '2026-10-20T08:00:00.000Z',
      editedAt: null,
    },
    {
      id: 'a0000000-0000-4000-8000-000000000003',
      visibility: 'PUBLIC',
      author: { type: 'AGENT', userId: AGENT, name: 'Jonah Reyes' },
      body: 'Sorry about that — the duplicate is refunded.',
      createdAt: '2026-10-20T08:20:00.000Z',
      editedAt: null,
    },
  ],
  internalNotes: [
    {
      id: 'a0000000-0000-4000-8000-000000000002',
      visibility: 'INTERNAL',
      author: { type: 'AGENT', userId: ME, name: 'Maya Chen' },
      body: 'Confirmed in Stripe: two charges.',
      createdAt: '2026-10-20T08:10:00.000Z',
      editedAt: null,
    },
  ],
  timeline: [
    {
      id: 'e0000000-0000-4000-8000-000000000001',
      type: 'CREATED',
      createdAt: '2026-10-20T08:00:00.000Z',
      actorType: 'USER',
      actor: null,
      data: {},
    },
    {
      id: 'e0000000-0000-4000-8000-000000000002',
      type: 'ASSIGNED',
      createdAt: '2026-10-20T08:05:00.000Z',
      actorType: 'USER',
      actor: { id: ME, name: 'Maya Chen' },
      data: { from: null, to: { id: AGENT, name: 'Jonah Reyes' } },
    },
    {
      id: 'e0000000-0000-4000-8000-000000000003',
      type: 'STATUS_CHANGED',
      createdAt: '2026-10-20T08:21:00.000Z',
      actorType: 'USER',
      actor: { id: AGENT, name: 'Jonah Reyes' },
      data: { from: 'OPEN', to: 'PENDING' },
    },
    {
      id: 'e0000000-0000-4000-8000-000000000004',
      type: 'TEAM_CHANGED',
      createdAt: '2026-10-20T08:22:00.000Z',
      // Made by a member whose account has since been deleted.
      actorType: 'USER',
      actor: null,
      data: { from: null, to: { id: BILLING, name: null } },
    },
    {
      id: 'e0000000-0000-4000-8000-000000000005',
      type: 'SLA_RESOLUTION_BREACHED',
      createdAt: '2026-10-20T08:23:00.000Z',
      actorType: 'SYSTEM',
      actor: null,
      data: { dueAt: '2026-10-20T08:22:00.000Z' },
    },
    {
      id: 'e0000000-0000-4000-8000-000000000006',
      type: 'STATUS_CHANGED',
      createdAt: '2026-10-20T08:24:00.000Z',
      actorType: 'SYSTEM',
      actor: null,
      data: { from: 'SOLVED', to: 'CLOSED' },
    },
  ],
};

describe('ticket detail', () => {
  it('opens from the inbox', async () => {
    const user = userEvent.setup();
    inboxApi({
      'GET /api/v1/tickets': json(page([DETAIL.ticket])),
      'GET /api/v1/tickets/12': json(DETAIL),
    });
    const { router } = renderApp('/tickets');
    await user.click(await screen.findByRole('link', { name: /#12 Refund for duplicate charge/ }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Refund for duplicate charge' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/tickets/12');
  });

  it('shows the conversation with internal notes clearly marked, in order', async () => {
    mockApi({ routes: { 'GET /api/v1/tickets/12': json(DETAIL) } });
    renderApp('/tickets/12');

    const thread = await screen.findByRole('list', { name: 'Conversation' });
    const items = within(thread).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('I was charged twice'),
      expect.stringContaining('Confirmed in Stripe'),
      expect.stringContaining('the duplicate is refunded'),
    ]);
    expect(within(items[1]!).getByText('Internal note')).toBeInTheDocument();
    expect(within(items[1]!).getByText(/only visible to your team/i)).toBeInTheDocument();
    expect(within(items[0]!).queryByText('Internal note')).not.toBeInTheDocument();
    expect(within(items[0]!).getByText('Ada Customer')).toBeInTheDocument();
  });

  it('shows ticket properties and the activity timeline', async () => {
    mockApi({ routes: { 'GET /api/v1/tickets/12': json(DETAIL) } });
    renderApp('/tickets/12');

    const details = await screen.findByRole('region', { name: 'Details' });
    expect(within(details).getByText('Pending')).toBeInTheDocument();
    expect(within(details).getByText('High')).toBeInTheDocument();
    expect(within(details).getByText('Jonah Reyes')).toBeInTheDocument();
    expect(within(details).getByText('Billing')).toBeInTheDocument();
    expect(within(details).getByText('ada@example.com')).toBeInTheDocument();

    const activity = screen.getByRole('list', { name: 'Activity' });
    const entries = within(activity)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(entries).toEqual([
      expect.stringContaining('Ticket created'),
      expect.stringMatching(/Maya Chen.*assigned the ticket to Jonah Reyes/),
      expect.stringMatching(/Jonah Reyes.*changed the status from Open to Pending/),
      expect.stringMatching(/^A former member moved the ticket to a deleted team/),
      expect.stringMatching(/^Resolution target missed/),
      expect.stringMatching(/^PulseDesk changed the status from Solved to Closed/),
    ]);
    expect(screen.getByRole('form', { name: 'Reply to the customer' })).toBeInTheDocument();
  });

  it('says so when the ticket does not exist in this organization', async () => {
    mockApi({ routes: { 'GET /api/v1/tickets/404': () => problem(404, 'NOT_FOUND') } });
    renderApp('/tickets/404');
    expect(await screen.findByRole('heading', { name: 'Ticket not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /all tickets/i })).toHaveAttribute('href', '/tickets');
  });

  it('treats a malformed ticket number as not found without calling the API', async () => {
    const fetchMock = mockApi();
    renderApp('/tickets/abc');
    expect(await screen.findByRole('heading', { name: 'Ticket not found' })).toBeInTheDocument();
    expect(requestedPaths(fetchMock).some((path) => path.startsWith('/api/v1/tickets'))).toBe(
      false,
    );
  });

  it('offers a retry when loading fails', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mockApi({
      routes: {
        'GET /api/v1/tickets/12': () =>
          ++attempts === 1 ? problem(500, 'INTERNAL_ERROR') : Response.json(DETAIL),
      },
    });
    renderApp('/tickets/12');
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Refund for duplicate charge' }),
    ).toBeInTheDocument();
  });
});
