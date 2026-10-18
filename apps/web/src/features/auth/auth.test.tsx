import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN_SESSION, mockApi, problem, renderApp } from '@/test/render';

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

describe('session restoration', () => {
  it('sends a signed-out visitor to the sign-in page and back after signing in', async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const fetchMock = mockApi({
      session: null,
      routes: {
        'GET /api/v1/auth/session': () =>
          signedIn ? Response.json(SIGNED_IN_SESSION) : problem(401, 'UNAUTHENTICATED'),
        'POST /api/v1/auth/login': () => {
          signedIn = true;
          return Response.json(SIGNED_IN_SESSION);
        },
      },
    });
    const { router } = renderApp('/settings');

    expect(
      await screen.findByRole('heading', { name: 'Sign in to PulseDesk' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/email/i), ' Maya@Brightwave.test ');
    await user.type(screen.getByLabelText(/^password/i), 'pulsedesk-dev-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
    const [, init] = fetchMock.mock.calls.find(([path]) => path === '/api/v1/auth/login')!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(bodyOf(init)).toEqual({
      email: 'maya@brightwave.test',
      password: 'pulsedesk-dev-password',
    });
  });

  it('restores an existing session from the cookie without asking to sign in', async () => {
    mockApi();
    renderApp('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Support overview' })).toBeInTheDocument();
    expect(screen.getAllByText('Brightwave Energy').length).toBeGreaterThan(0);
  });

  it('keeps no session token in browser storage', async () => {
    mockApi();
    renderApp('/dashboard');
    await screen.findByRole('heading', { name: 'Support overview' });
    const stored = [localStorage, sessionStorage]
      .flatMap((store) => Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`))
      .join(' ');
    expect(stored).not.toMatch(/pd_sid|token|session/i);
  });

  it('explains when no API is reachable instead of pretending to sign in', async () => {
    mockApi({ health: 'down', session: 'down' });
    renderApp('/dashboard');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to PulseDesk' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('The PulseDesk API is unreachable')).toBeInTheDocument();
  });
});

describe('sign-in form', () => {
  it('validates fields before calling the API', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ session: null });
    renderApp('/login');

    await user.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toHaveFocus());
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/auth/login')).toBe(false);
  });

  it('shows a generic error for invalid credentials and clears the password', async () => {
    const user = userEvent.setup();
    mockApi({
      session: null,
      routes: {
        'POST /api/v1/auth/login': () =>
          problem(401, 'INVALID_CREDENTIALS', { detail: 'Incorrect email or password.' }),
      },
    });
    renderApp('/login');

    await user.type(await screen.findByLabelText(/email/i), 'maya@brightwave.test');
    await user.type(screen.getByLabelText(/^password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Incorrect email or password.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toHaveValue('');
  });

  it('explains rate limiting', async () => {
    const user = userEvent.setup();
    mockApi({
      session: null,
      routes: { 'POST /api/v1/auth/login': () => problem(429, 'RATE_LIMITED') },
    });
    renderApp('/login');

    await user.type(await screen.findByLabelText(/email/i), 'maya@brightwave.test');
    await user.type(screen.getByLabelText(/^password/i), 'whatever');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
  });

  it('toggles password visibility accessibly', async () => {
    const user = userEvent.setup();
    mockApi({ session: null });
    renderApp('/login');

    const password = await screen.findByLabelText(/^password/i);
    expect(password).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('ignores off-site redirect targets', async () => {
    const { safeRedirectTarget } = await import('./login-page');
    expect(safeRedirectTarget({ from: '/tickets' })).toBe('/tickets');
    expect(safeRedirectTarget({ from: '//evil.example' })).toBe('/dashboard');
    expect(safeRedirectTarget({ from: 'https://evil.example' })).toBe('/dashboard');
    expect(safeRedirectTarget(null)).toBe('/dashboard');
  });
});

describe('sign-up form', () => {
  async function fillSignup(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(/your name/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/work email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/organization name/i), 'Analytical Engines');
    await user.type(screen.getByLabelText(/^password/i), 'correct horse battery');
  }

  it('creates the account and lands on the dashboard with a welcome message', async () => {
    const user = userEvent.setup();
    const created = {
      ...SIGNED_IN_SESSION,
      activeOrganization: { ...SIGNED_IN_SESSION.activeOrganization, name: 'Analytical Engines' },
    };
    const fetchMock = mockApi({
      session: null,
      routes: { 'POST /api/v1/auth/register': () => Response.json(created, { status: 201 }) },
    });
    const { router } = renderApp('/signup');

    await fillSignup(user);
    expect(screen.getByText('Long enough')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Analytical Engines is ready')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/dashboard');
    const [, init] = fetchMock.mock.calls.find(([path]) => path === '/api/v1/auth/register')!;
    expect(bodyOf(init)).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      organizationName: 'Analytical Engines',
      password: 'correct horse battery',
    });
  });

  it('enforces the password policy client-side', async () => {
    const user = userEvent.setup();
    mockApi({ session: null });
    renderApp('/signup');

    await user.type(await screen.findByLabelText(/^password/i), 'short');
    expect(screen.getByText(/7 to go/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 12 characters')).toBeInTheDocument();
  });

  it('distinguishes an outage, an unreachable API and an unexpected error', async () => {
    const user = userEvent.setup();
    let reply: () => Response | Promise<Response> = () => problem(503, 'SERVICE_UNAVAILABLE');
    mockApi({ session: null, routes: { 'POST /api/v1/auth/register': () => reply() } });
    renderApp('/signup');
    await fillSignup(user);
    const submit = screen.getByRole('button', { name: 'Create account' });

    await user.click(submit);
    expect(await screen.findByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/reference/i)).not.toBeInTheDocument();

    reply = () => Promise.reject(new TypeError('Failed to fetch'));
    await user.click(submit);
    expect(await screen.findByText(/couldn’t reach PulseDesk/i)).toBeInTheDocument();

    reply = () => problem(500, 'INTERNAL_ERROR');
    await user.click(submit);
    expect(await screen.findByText(/reference test-request-id/i)).toBeInTheDocument();
  });

  it('points an existing user to sign in when the email is taken', async () => {
    const user = userEvent.setup();
    mockApi({
      session: null,
      routes: {
        'POST /api/v1/auth/register': () =>
          problem(409, 'EMAIL_TAKEN', {
            errors: [{ path: 'body.email', message: 'An account with this email already exists' }],
          }),
      },
    });
    renderApp('/signup');

    await fillSignup(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByText(/an account with this email already exists/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute('href', '/login');
    expect(screen.getByLabelText(/work email/i)).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('signed-in shell', () => {
  it('shows the real user and signs out through the API', async () => {
    const user = userEvent.setup();
    let signedIn = true;
    const fetchMock = mockApi({
      routes: {
        'GET /api/v1/auth/session': () =>
          signedIn ? Response.json(SIGNED_IN_SESSION) : problem(401, 'UNAUTHENTICATED'),
        'POST /api/v1/auth/logout': () => {
          signedIn = false;
          return new Response(null, { status: 204 });
        },
      },
    });
    const { router } = renderApp('/dashboard');

    await user.click(await screen.findByRole('button', { name: 'Account menu for Maya Chen' }));
    expect(await screen.findByText('maya@brightwave.test')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/auth/logout')).toBe(true);
  });

  it('switches organization through the API', async () => {
    const user = userEvent.setup();
    const switched = {
      ...SIGNED_IN_SESSION,
      activeOrganization: SIGNED_IN_SESSION.organizations[1],
    };
    const fetchMock = mockApi({
      routes: { 'POST /api/v1/auth/active-organization': () => Response.json(switched) },
    });
    renderApp('/dashboard');

    const [trigger] = await screen.findAllByRole('button', {
      name: 'Switch organization. Current: Brightwave Energy',
    });
    await user.click(trigger!);
    await user.click(await screen.findByRole('menuitemradio', { name: /kestrel outfitters/i }));

    expect(
      (
        await screen.findAllByRole('button', {
          name: 'Switch organization. Current: Kestrel Outfitters',
        })
      ).length,
    ).toBeGreaterThan(0);
    const [, init] = fetchMock.mock.calls.find(
      ([path]) => path === '/api/v1/auth/active-organization',
    )!;
    expect(bodyOf(init)).toEqual({ organizationId: SIGNED_IN_SESSION.organizations[1]!.id });
  });

  it('asks a removed member to choose another organization', async () => {
    mockApi({ session: { ...SIGNED_IN_SESSION, activeOrganization: null } });
    renderApp('/dashboard');
    expect(await screen.findByText('Choose an organization')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kestrel Outfitters' })).toBeInTheDocument();
  });
});
