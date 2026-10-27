import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockHealth, renderApp, useDesktopViewport } from '@/test/render';

describe('application shell', () => {
  it('renders the dashboard inside landmarks with the current page marked', async () => {
    mockHealth();
    renderApp('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Support overview' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: /dashboard/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('labels the dashboard as sample data', async () => {
    mockHealth();
    renderApp('/dashboard');

    expect(await screen.findByText('This dashboard is a design preview')).toBeInTheDocument();
    expect(screen.getByText('Sample data', { selector: 'span' })).toBeInTheDocument();
  });

  it('collapses the desktop sidebar with the button and remembers the choice', async () => {
    useDesktopViewport();
    mockHealth();
    const user = userEvent.setup();
    renderApp();

    const toggle = await screen.findByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(localStorage.getItem('pulsedesk-sidebar-collapsed')).toBe('true');

    // Collapsed links sit inside tooltip triggers; their classes must survive Slot merging
    // (a className callback would be stringified into the attribute).
    const railLink = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: 'Tickets',
    });
    expect(railLink).toHaveClass('size-9');
    expect(railLink.className).not.toContain('=>');
  });

  it('toggles the sidebar with the [ shortcut, but not while typing', async () => {
    useDesktopViewport();
    mockHealth();
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('button', { name: 'Collapse sidebar' });

    await user.keyboard('[['); // '[[' types a literal '['
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), '[[');
    await user.keyboard('{Escape}');
    // Typing '[' in the field did not toggle the sidebar back open.
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('opens a navigation drawer on small screens and closes it after navigating', async () => {
    mockHealth();
    const user = userEvent.setup();
    const { router } = renderApp();
    await screen.findByRole('heading', { name: 'Support overview' });

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('link', { name: /customers/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/customers');
  });

  it('shows an honest placeholder for planned features', async () => {
    mockHealth();
    renderApp('/analytics');

    expect(
      await screen.findByRole('heading', { name: 'Analytics isn’t built yet' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Planned · Phase 6/)).toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', async () => {
    mockHealth();
    renderApp('/definitely-not-a-page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('API status indicator', () => {
  it('reports the API as online when /health returns the contract', async () => {
    const fetchMock = mockHealth('ok');
    renderApp();
    expect(await screen.findAllByText('API online')).not.toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith('/health', expect.anything());
  });

  it('reports the API as unreachable when the request fails', async () => {
    mockHealth('down');
    renderApp();
    expect(await screen.findAllByText('API unreachable')).not.toHaveLength(0);
  });

  it('does not mistake a non-API response (e.g. the SPA fallback page) for a healthy API', async () => {
    mockHealth('html');
    renderApp();
    expect(await screen.findAllByText('API unreachable')).not.toHaveLength(0);
  });
});
