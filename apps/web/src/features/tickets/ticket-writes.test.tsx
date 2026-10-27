import type { TicketDetailResponse, TicketSummary } from '@pulsedesk/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN_SESSION, mockApi, problem, renderApp } from '@/test/render';

const ME = SIGNED_IN_SESSION.user.id;
const AGENT = '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f';
const BILLING = '7e6d5c4b-3a29-4f18-8e07-d6c5b4a39281';
const VIP = '3b2a1908-f7e6-4d5c-8b4a-39281706f5e4';
const REFUND = '4c3b2a19-08f7-4e6d-9c5b-4a3928170605';

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

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
  'GET /api/v1/tags': json({
    data: [
      { id: REFUND, name: 'refund', color: 'red', ticketCount: 0 },
      { id: VIP, name: 'vip', color: 'amber', ticketCount: 0 },
    ],
  }),
};

function summary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: '00000000-0000-4000-8000-000000000012',
    number: 12,
    subject: 'Refund for duplicate charge',
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
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
    ...overrides,
  };
}

function detail(
  ticket: Partial<TicketSummary> = {},
  extra: Partial<TicketDetailResponse> = {},
): TicketDetailResponse {
  return {
    ticket: summary(ticket),
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
        body: 'I was charged twice.',
        createdAt: '2026-10-20T08:00:00.000Z',
        editedAt: null,
      },
    ],
    internalNotes: [],
    timeline: [
      {
        id: 'e0000000-0000-4000-8000-000000000001',
        type: 'CREATED',
        createdAt: '2026-10-20T08:00:00.000Z',
        actor: { id: ME, name: 'Maya Chen' },
        data: {},
      },
    ],
    ...extra,
  };
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

/** Resolves when the test calls `release`, to observe pending and optimistic states. */
function deferred() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release: (response: Response) => release(response) };
}

const detailsRegion = () => screen.findByRole('region', { name: 'Details' });

describe('creating a ticket', () => {
  it('validates required fields before sending anything', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      routes: { ...OPTIONS, 'GET /api/v1/tickets': json({ data: [], nextCursor: null }) },
    });
    renderApp('/tickets');

    await user.click(await screen.findByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ticket' });
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));

    expect(within(dialog).getByLabelText(/customer email/i)).toHaveAccessibleDescription(
      'Enter the customer’s email address',
    );
    expect(within(dialog).getByLabelText(/^subject/i)).toHaveAccessibleDescription(
      'Enter a subject',
    );
    expect(within(dialog).getByLabelText(/^subject/i)).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByLabelText(/customer email/i)).toHaveFocus();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('creates the ticket and opens it', async () => {
    const user = userEvent.setup();
    const created = detail({ number: 31, subject: 'Card declined', priority: 'HIGH' });
    const fetchMock = mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets': json({ data: [], nextCursor: null }),
        'POST /api/v1/tickets': json(created, 201),
        'GET /api/v1/tickets/31': json(created),
      },
    });
    const { router } = renderApp('/tickets');

    await user.click(await screen.findByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ticket' });
    await user.type(within(dialog).getByLabelText(/customer email/i), ' Ada@Example.com ');
    await user.type(within(dialog).getByLabelText(/customer name/i), 'Ada Customer');
    await user.type(within(dialog).getByLabelText(/^subject/i), 'Card declined');
    await user.type(within(dialog).getByLabelText(/^message/i), 'My card was declined.');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Priority' }), 'HIGH');
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/tickets/31'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Card declined' }),
    ).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(
      ([path, init]) => path === '/api/v1/tickets' && init?.method === 'POST',
    )!;
    expect(bodyOf(init)).toEqual({
      subject: 'Card declined',
      customer: { email: 'ada@example.com', name: 'Ada Customer' },
      message: 'My card was declined.',
      priority: 'HIGH',
      channel: 'WEB',
      tagIds: [],
    });
  });

  it('shows server validation errors on the matching fields and keeps the input', async () => {
    const user = userEvent.setup();
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets': json({ data: [], nextCursor: null }),
        'POST /api/v1/tickets': () =>
          problem(400, 'VALIDATION_FAILED', {
            errors: [{ path: 'body.customer.email', message: 'This address is blocked' }],
          }),
      },
    });
    renderApp('/tickets');

    await user.click(await screen.findByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ticket' });
    await user.type(within(dialog).getByLabelText(/customer email/i), 'blocked@example.com');
    await user.type(within(dialog).getByLabelText(/^subject/i), 'Hello');
    await user.type(within(dialog).getByLabelText(/^message/i), 'Body');
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));

    const email = within(dialog).getByLabelText(/customer email/i);
    await waitFor(() => expect(email).toHaveAccessibleDescription('This address is blocked'));
    expect(email).toHaveValue('blocked@example.com');
    expect(within(dialog).getByLabelText(/^subject/i)).toHaveValue('Hello');
  });

  it('offers a retry when the API is unreachable', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const created = detail({ number: 32, subject: 'Retry me' });
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets': json({ data: [], nextCursor: null }),
        'POST /api/v1/tickets': () =>
          ++attempts === 1
            ? new Response('<html>Bad gateway</html>', { status: 502 })
            : Response.json(created, { status: 201 }),
        'GET /api/v1/tickets/32': json(created),
      },
    });
    const { router } = renderApp('/tickets');

    await user.click(await screen.findByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ticket' });
    await user.type(within(dialog).getByLabelText(/customer email/i), 'ada@example.com');
    await user.type(within(dialog).getByLabelText(/^subject/i), 'Retry me');
    await user.type(within(dialog).getByLabelText(/^message/i), 'Body');
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/try again/i);
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/tickets/32'));
  });
});

describe('updating ticket properties', () => {
  it('changes the status optimistically and keeps the server’s answer', async () => {
    const user = userEvent.setup();
    const save = deferred();
    const fetchMock = mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(detail()),
        'PATCH /api/v1/tickets/12': () => save.promise,
      },
    });
    renderApp('/tickets/12');

    const details = await detailsRegion();
    await user.selectOptions(within(details).getByRole('combobox', { name: 'Status' }), 'PENDING');

    // Shown immediately, before the server answers.
    expect(within(details).getByRole('combobox', { name: 'Status' })).toHaveValue('PENDING');
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
    save.release(Response.json(detail({ status: 'PENDING' })));

    expect(await within(details).findByText('Saved')).toBeInTheDocument();
    expect(within(details).getByRole('combobox', { name: 'Status' })).toHaveValue('PENDING');
    expect(within(details).queryByRole('alert')).not.toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH')!;
    expect(bodyOf(init)).toEqual({ status: 'PENDING' });
  });

  it('rolls back and explains a rejected change', async () => {
    const user = userEvent.setup();
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(detail()),
        'PATCH /api/v1/tickets/12': () =>
          problem(409, 'INVALID_STATUS_TRANSITION', {
            detail: 'A ticket can’t move from Open to Solved right now.',
          }),
      },
    });
    renderApp('/tickets/12');

    const details = await detailsRegion();
    const status = within(details).getByRole('combobox', { name: 'Status' });
    await user.selectOptions(status, 'SOLVED');

    expect(await within(details).findByRole('alert')).toHaveTextContent(
      'A ticket can’t move from Open to Solved right now.',
    );
    expect(status).toHaveValue('OPEN');
  });

  it('only offers the statuses the lifecycle allows', async () => {
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(
          detail({ status: 'SOLVED', solvedAt: '2026-10-21T00:00:00.000Z' }),
        ),
      },
    });
    renderApp('/tickets/12');

    const status = within(await detailsRegion()).getByRole('combobox', { name: 'Status' });
    const options = within(status)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Solved', 'Open']);
  });

  it('assigns, moves teams and changes priority with one request each', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(detail()),
        'PATCH /api/v1/tickets/12': (init) => {
          bodies.push(bodyOf(init));
          return Response.json(detail());
        },
      },
    });
    renderApp('/tickets/12');

    const details = await detailsRegion();
    await waitFor(() =>
      expect(within(details).getByRole('option', { name: 'Jonah Reyes' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(details).getByRole('combobox', { name: 'Assignee' }), AGENT);
    await waitFor(() => expect(bodies).toHaveLength(1));
    await user.selectOptions(within(details).getByRole('combobox', { name: 'Team' }), BILLING);
    await waitFor(() => expect(bodies).toHaveLength(2));
    await user.selectOptions(within(details).getByRole('combobox', { name: 'Priority' }), 'URGENT');
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies).toEqual([
      { assigneeUserId: AGENT },
      { teamId: BILLING },
      { priority: 'URGENT' },
    ]);
  });

  it('edits tags as a set', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(
          detail({ tags: [{ id: VIP, name: 'vip', color: 'amber' }] }),
        ),
        'PATCH /api/v1/tickets/12': (init) => {
          bodies.push(bodyOf(init));
          return Response.json(
            detail({
              tags: [
                { id: REFUND, name: 'refund', color: 'red' },
                { id: VIP, name: 'vip', color: 'amber' },
              ],
            }),
          );
        },
      },
    });
    renderApp('/tickets/12');

    await user.click(await screen.findByRole('button', { name: 'Edit tags' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'refund' }));
    await waitFor(() => expect(bodies).toEqual([{ tagIds: [VIP, REFUND] }]));
  });
});

describe('replying and adding notes', () => {
  it('posts a public reply, clears the composer and shows the new message', async () => {
    const user = userEvent.setup();
    const save = deferred();
    const fetchMock = mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(detail()),
        'POST /api/v1/tickets/12/messages': () => save.promise,
      },
    });
    renderApp('/tickets/12');

    const composer = await screen.findByRole('form', { name: 'Reply to the customer' });
    expect(within(composer).getByText(/isn’t sent by email/i)).toBeInTheDocument();
    await user.type(within(composer).getByRole('textbox', { name: 'Reply' }), 'Refund started.');
    await user.click(within(composer).getByRole('button', { name: 'Send reply' }));

    expect(within(composer).getByRole('button', { name: 'Send reply' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    const withReply = detail(
      {},
      {
        conversation: [
          ...detail().conversation,
          {
            id: 'a0000000-0000-4000-8000-000000000009',
            visibility: 'PUBLIC',
            author: { type: 'AGENT', userId: ME, name: 'Maya Chen' },
            body: 'Refund started.',
            createdAt: '2026-10-20T09:00:00.000Z',
            editedAt: null,
          },
        ],
      },
    );
    save.release(Response.json(withReply, { status: 201 }));

    const thread = await screen.findByRole('list', { name: 'Conversation' });
    expect(await within(thread).findByText('Refund started.')).toBeInTheDocument();
    expect(within(composer).getByRole('textbox', { name: 'Reply' })).toHaveValue('');
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(bodyOf(init)).toEqual({ body: 'Refund started.', visibility: 'PUBLIC' });
  });

  it('adds an internal note from the note tab', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(detail()),
        'POST /api/v1/tickets/12/messages': (init) => {
          bodies.push(bodyOf(init));
          return Response.json(
            detail(
              {},
              {
                internalNotes: [
                  {
                    id: 'a0000000-0000-4000-8000-000000000010',
                    visibility: 'INTERNAL',
                    author: { type: 'AGENT', userId: ME, name: 'Maya Chen' },
                    body: 'Check Stripe first.',
                    createdAt: '2026-10-20T09:00:00.000Z',
                    editedAt: null,
                  },
                ],
              },
            ),
            { status: 201 },
          );
        },
      },
    });
    renderApp('/tickets/12');

    await user.click(await screen.findByRole('radio', { name: 'Internal note' }));
    const composer = screen.getByRole('form', { name: 'Add an internal note' });
    expect(within(composer).getByText(/only your team/i)).toBeInTheDocument();
    await user.type(within(composer).getByRole('textbox', { name: 'Note' }), 'Check Stripe first.');
    await user.click(within(composer).getByRole('button', { name: 'Add note' }));

    const thread = await screen.findByRole('list', { name: 'Conversation' });
    const note = (await within(thread).findByText('Check Stripe first.')).closest('li')!;
    expect(within(note).getByText('Internal note')).toBeInTheDocument();
    expect(bodies).toEqual([{ body: 'Check Stripe first.', visibility: 'INTERNAL' }]);
  });

  it('refuses an empty message without calling the API', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      routes: { ...OPTIONS, 'GET /api/v1/tickets/12': json(detail()) },
    });
    renderApp('/tickets/12');

    const composer = await screen.findByRole('form', { name: 'Reply to the customer' });
    await user.type(within(composer).getByRole('textbox', { name: 'Reply' }), '   ');
    await user.click(within(composer).getByRole('button', { name: 'Send reply' }));
    expect(within(composer).getByRole('textbox', { name: 'Reply' })).toHaveAccessibleDescription(
      'Write a message',
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps the draft and offers a retry when sending fails', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(detail()),
        'POST /api/v1/tickets/12/messages': () =>
          ++attempts === 1
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Response.json(detail(), { status: 201 }),
      },
    });
    renderApp('/tickets/12');

    const composer = await screen.findByRole('form', { name: 'Reply to the customer' });
    const textbox = within(composer).getByRole('textbox', { name: 'Reply' });
    await user.type(textbox, 'Draft that must survive');
    await user.click(within(composer).getByRole('button', { name: 'Send reply' }));

    expect(await within(composer).findByRole('alert')).toHaveTextContent(/couldn’t reach/i);
    expect(textbox).toHaveValue('Draft that must survive');
    await user.click(within(composer).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(textbox).toHaveValue(''));
    expect(attempts).toBe(2);
  });

  it('makes closed tickets read-only', async () => {
    mockApi({
      routes: {
        ...OPTIONS,
        'GET /api/v1/tickets/12': json(
          detail({
            status: 'CLOSED',
            solvedAt: '2026-10-21T00:00:00.000Z',
            closedAt: '2026-10-24T00:00:00.000Z',
          }),
        ),
      },
    });
    renderApp('/tickets/12');

    const details = await detailsRegion();
    expect(within(details).queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByText(/closed tickets are read-only/i)).toBeInTheDocument();
  });
});
