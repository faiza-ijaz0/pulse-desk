import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockHealth, renderApp } from '@/test/render';

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

  it('explains that record search is not available yet when nothing matches', async () => {
    mockHealth();
    const { user, input } = await openPalette();
    await user.type(input, 'invoice 1042');
    expect(
      screen.getByText(/Searching tickets and customers arrives with the ticket inbox/),
    ).toBeInTheDocument();
  });
});
