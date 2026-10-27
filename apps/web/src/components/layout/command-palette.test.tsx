import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { customer, json, ticketSummary } from '@/test/fixtures';
import { mockApi, mockHealth, problem, renderApp } from '@/test/render';

async function openPalette() {
  const user = userEvent.setup();
  const utils = renderApp();
  await screen.findByRole('heading', { name: 'Support overview' });
  await user.keyboard('{Control>}k{/Control}');
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  return { user, input, ...utils };
}

describe('command palette', () => {
  it('opens with Ctrl+K and focuses the search field', async () => {
    mockHealth();
    const { input } = await openPalette();
    expect(input).toHaveFocus();
    expect(screen.getByRole('option', { name: /dashboard/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('filters commands and navigates with Enter', async () => {
    mockHealth();
    const { user, input, router } = await openPalette();

    await user.type(input, 'sla');
    // Label matches rank above matches in page descriptions.
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('SLA policies');
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('SLA policies');

    await user.keyboard('{Enter}');

    await waitFor(() => expect(router.state.location.pathname).toBe('/sla'));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('moves the active option with arrow keys and exposes it via aria-activedescendant', async () => {
    mockHealth();
    const { user, input } = await openPalette();

    await user.keyboard('{ArrowDown}');
    const active = screen.getByRole('option', { selected: true });
    expect(active).toHaveTextContent('Tickets');
    expect(input).toHaveAttribute('aria-activedescendant', active.id);
  });

  it('runs theme commands', async () => {
    mockHealth();
    const { user, input } = await openPalette();

    await user.type(input, 'dark');
    await user.keyboard('{Enter}');

    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('pulsedesk-theme')).toBe('dark');
  });

  it('searches tickets and customers and opens the chosen record', async () => {
    let requests = 0;
    mockApi({
      routes: {
        'GET /api/v1/search?q=invoice': () => {
          requests += 1;
          return Response.json({
            tickets: [ticketSummary({ number: 42, subject: 'Invoice charged twice' })],
            customers: [customer({ name: 'Invoice Ltd', email: 'billing@invoice.example' })],
          });
        },
      },
    });
    const { user, input, router } = await openPalette();

    await user.type(input, 'invoice');
    const tickets = await screen.findByRole('group', { name: 'Tickets' });
    expect(
      within(tickets).getByRole('option', { name: /#42 Invoice charged twice/ }),
    ).toBeInTheDocument();
    const customers = screen.getByRole('group', { name: 'Customers' });
    expect(within(customers).getByRole('option', { name: /Invoice Ltd/ })).toBeInTheDocument();
    // Typing seven characters sent one request for the final text.
    expect(requests).toBe(1);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/tickets/42'));
  });

  it('says when nothing matches', async () => {
    mockApi({
      routes: { 'GET /api/v1/search?q=zzzz': json({ tickets: [], customers: [] }) },
    });
    const { user, input } = await openPalette();
    await user.type(input, 'zzzz');
    expect(
      await screen.findByText('No tickets, customers or commands match “zzzz”'),
    ).toBeInTheDocument();
  });

  it('offers a retry when search fails', async () => {
    let attempts = 0;
    mockApi({
      routes: {
        'GET /api/v1/search?q=ada': () =>
          ++attempts === 1
            ? problem(500, 'INTERNAL_ERROR')
            : Response.json({ tickets: [], customers: [customer()] }),
      },
    });
    const { user, input } = await openPalette();
    await user.type(input, 'ada');
    const retry = await screen.findByRole('option', { name: /retry search/i });
    await user.click(retry);
    expect(await screen.findByRole('option', { name: /Ada Lovelace/ })).toBeInTheDocument();
  });

  it('waits for at least two characters before searching', async () => {
    const fetchMock = mockApi();
    const { user, input } = await openPalette();
    await user.type(input, 'a');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      fetchMock.mock.calls.some(
        ([path]) => typeof path === 'string' && path.startsWith('/api/v1/search'),
      ),
    ).toBe(false);
  });
});
