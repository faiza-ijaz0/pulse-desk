import { render, screen, waitFor, within } from '@testing-library/react';
import { BarChart3 } from 'lucide-react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PlannedPage } from '@/pages/planned-page';
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

  it('no longer marks the dashboard as a preview (it shows live data)', async () => {
    mockHealth();
    renderApp('/dashboard');

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const dashboardLink = within(nav).getByRole('link', { name: /dashboard/i });
    expect(within(dashboardLink).queryByText(/preview/i)).not.toBeInTheDocument();
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

    // The link closes the drawer on click, but /customers is a lazy route: the location only
    // changes once its module has loaded, which can be after the drawer is gone.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(router.state.location.pathname).toBe('/customers'));
  });

  it('shows an honest placeholder for planned features', () => {
    // No nav item is planned right now; the placeholder stays for the next one.
    render(
      <MemoryRouter>
        <PlannedPage
          item={{
            label: 'Reports',
            to: '/reports',
            icon: BarChart3,
            status: 'planned',
            phase: 'Phase 9',
            summary: 'Scheduled reports by email.',
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Reports isn’t built yet' })).toBeInTheDocument();
    expect(screen.getByText(/Planned · Phase 9/)).toBeInTheDocument();
  });

  it('serves Analytics as a real page, not a placeholder', async () => {
    mockHealth();
    renderApp('/analytics');

    expect(await screen.findByRole('heading', { level: 1, name: 'Analytics' })).toBeInTheDocument();
    expect(screen.queryByText(/isn’t built yet/)).not.toBeInTheDocument();
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
