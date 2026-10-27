import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADA_ID, bodyOf, customer, json, ticketSummary } from '@/test/fixtures';
import { mockApi, problem, renderApp } from '@/test/render';

const GRACE = customer({
  id: '22222222-2222-4222-8222-222222222222',
  name: null,
  email: 'grace@example.com',
  ticketCount: 0,
  activeTicketCount: 0,
});
const CURSOR = 'eyJlIjoiZ3JhY2VAZXhhbXBsZS5jb20ifQ';

const requested = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.map(([input]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );

describe('customer list', () => {
  it('lists customers with their ticket counts and links to each', async () => {
    mockApi({
      routes: { 'GET /api/v1/customers': json({ data: [customer(), GRACE], nextCursor: null }) },
    });
    renderApp('/customers');

    expect(await screen.findByRole('heading', { level: 1, name: 'Customers' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Customers' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('link', { name: /Ada Lovelace/ })).toHaveAttribute(
      'href',
      `/customers/${ADA_ID}`,
    );
    expect(rows[0]).toHaveTextContent('2 tickets');
    expect(rows[0]).toHaveTextContent('1 active');
    // A customer without a name is shown by email.
    expect(within(rows[1]!).getByRole('link', { name: /grace@example.com/ })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('No tickets');
  });

  it('searches as you type, debounced, and keeps the search in the URL', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      routes: {
        'GET /api/v1/customers': json({ data: [customer(), GRACE], nextCursor: null }),
        'GET /api/v1/customers?q=grace': json({ data: [GRACE], nextCursor: null }),
      },
    });
    const { router } = renderApp('/customers');
    await screen.findByRole('list', { name: 'Customers' });

    await user.type(screen.getByRole('searchbox', { name: 'Search customers' }), 'grace');
    await waitFor(() => expect(router.state.location.search).toBe('?q=grace'));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /Ada Lovelace/ })).not.toBeInTheDocument(),
    );
    // One request for the final text, not one per keystroke.
    expect(requested(fetchMock).filter((p) => p.startsWith('/api/v1/customers?q='))).toEqual([
      '/api/v1/customers?q=grace',
    ]);
  });

  it('explains when a search matches nothing', async () => {
    mockApi({ routes: { 'GET /api/v1/customers?q=zzz': json({ data: [], nextCursor: null }) } });
    renderApp('/customers?q=zzz');
    expect(
      await screen.findByRole('heading', { name: 'No customers match “zzz”' }),
    ).toBeInTheDocument();
  });

  it('explains an empty customer list', async () => {
    mockApi({ routes: { 'GET /api/v1/customers': json({ data: [], nextCursor: null }) } });
    renderApp('/customers');
    expect(await screen.findByRole('heading', { name: 'No customers yet' })).toBeInTheDocument();
  });

  it('loads more with the cursor', async () => {
    const user = userEvent.setup();
    mockApi({
      routes: {
        'GET /api/v1/customers': json({ data: [customer()], nextCursor: CURSOR }),
        [`GET /api/v1/customers?cursor=${CURSOR}`]: json({ data: [GRACE], nextCursor: null }),
      },
    });
    renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: 'Load more customers' }));
    expect(await screen.findByRole('link', { name: /grace@example.com/ })).toBeInTheDocument();
  });

  it('shows loading, then an error with a working retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mockApi({
      routes: {
        'GET /api/v1/customers': () =>
          ++attempts === 1
            ? problem(500, 'INTERNAL_ERROR')
            : Response.json({ data: [customer()], nextCursor: null }),
      },
    });
    renderApp('/customers');
    expect(await screen.findByRole('status', { name: 'Loading customers' })).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Ada Lovelace/ })).toBeInTheDocument();
  });
});

describe('customer detail', () => {
  const routes = {
    [`GET /api/v1/customers/${ADA_ID}`]: json(customer()),
    [`GET /api/v1/tickets?customer=${ADA_ID}`]: json({
      data: [
        ticketSummary(),
        ticketSummary({
          id: '00000000-0000-4000-8000-000000000007',
          number: 7,
          subject: 'Password reset',
          status: 'SOLVED',
        }),
      ],
      nextCursor: null,
    }),
  };

  it('shows contact details and the customer’s ticket history', async () => {
    mockApi({ routes });
    renderApp(`/customers/${ADA_ID}`);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    const history = await screen.findByRole('list', { name: 'Ticket history' });
    expect(
      within(history).getByRole('link', { name: /#12 Refund for duplicate charge/ }),
    ).toHaveAttribute('href', '/tickets/12');
    expect(within(history).getByRole('link', { name: /#7 Password reset/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open in inbox/i })).toHaveAttribute(
      'href',
      `/tickets?customer=${ADA_ID}`,
    );
  });

  it('edits contact details and shows a conflict on the email field', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let attempt = 0;
    mockApi({
      routes: {
        ...routes,
        [`PATCH /api/v1/customers/${ADA_ID}`]: (init) => {
          bodies.push(bodyOf(init));
          return ++attempt === 1
            ? problem(409, 'CONFLICT', {
                detail: 'Another customer in this organization already uses this email.',
              })
            : Response.json(customer({ name: 'Ada King', email: 'ada.king@example.com' }));
        },
      },
    });
    renderApp(`/customers/${ADA_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Edit contact details' }));
    const form = screen.getByRole('form', { name: 'Edit contact details' });
    const name = within(form).getByLabelText('Name');
    const email = within(form).getByLabelText(/email/i);
    await user.clear(name);
    await user.type(name, 'Ada King');
    await user.clear(email);
    await user.type(email, 'taken@example.com');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(email).toHaveAccessibleDescription(
        'Another customer in this organization already uses this email.',
      ),
    );
    await user.clear(email);
    await user.type(email, 'Ada.King@example.com');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Ada King' })).toBeInTheDocument();
    expect(bodies.at(-1)).toEqual({ name: 'Ada King', email: 'ada.king@example.com' });
    expect(screen.queryByRole('form', { name: 'Edit contact details' })).not.toBeInTheDocument();
  });

  it('treats an unknown or foreign customer as not found', async () => {
    mockApi({
      routes: { [`GET /api/v1/customers/${ADA_ID}`]: () => problem(404, 'NOT_FOUND') },
    });
    renderApp(`/customers/${ADA_ID}`);
    expect(await screen.findByRole('heading', { name: 'Customer not found' })).toBeInTheDocument();
  });

  it('does not call the API for a malformed customer ID', async () => {
    const fetchMock = mockApi();
    renderApp('/customers/not-an-id');
    expect(await screen.findByRole('heading', { name: 'Customer not found' })).toBeInTheDocument();
    expect(requested(fetchMock).some((p) => p.startsWith('/api/v1/customers'))).toBe(false);
  });
});
