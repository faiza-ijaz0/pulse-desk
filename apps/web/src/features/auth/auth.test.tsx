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

  it('explains when no API is attached instead of pretending to sign in', async () => {
    // A frontend-only deployment: the host answers /health and /api with its own 404 page.
    const notFound = () => new Response('Not found', { status: 404 });
    mockApi({ routes: { 'GET /health': notFound, 'GET /api/v1/auth/session': notFound } });
    renderApp('/dashboard');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to PulseDesk' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('The PulseDesk API is unreachable')).toBeInTheDocument();
  });
});

describe('temporary API unavailability (e.g. a sleeping API host)', () => {
  const FAST = { maxRetries: 3, baseDelayMs: 5, maxDelayMs: 20, random: () => 0 };
  const gateway = (status: number) => () =>
    new Response('<html>gateway</html>', { status, headers: { 'Content-Type': 'text/html' } });

  /** A reply that stays pending until `release()`, so intermediate states can be asserted. */
  function held() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { release, reply: () => gate.then(() => Response.json(SIGNED_IN_SESSION)) };
  }

  function sessionCalls(fetchMock: ReturnType<typeof mockApi>) {
    return fetchMock.mock.calls.filter(([path]) => path === '/api/v1/auth/session').length;
  }

  it('shows a reconnecting state during a cold start, then restores the session', async () => {
    const wake = held();
    const sequence = [gateway(503), gateway(502), wake.reply];
    const fetchMock = mockApi({
      routes: { 'GET /api/v1/auth/session': () => (sequence.shift() ?? wake.reply)() },
    });
    renderApp('/dashboard', { retryPolicy: FAST });

    // Announced politely through a live region, with an explanation of the wait.
    const message = await screen.findByText('Connecting to PulseDesk…');
    expect(message.closest('[role="status"]')).toHaveTextContent(/can take up to a minute/);
    expect(screen.queryByText(/unreachable/i)).not.toBeInTheDocument();

    wake.release();
    expect(await screen.findByRole('heading', { name: 'Support overview' })).toBeInTheDocument();
    expect(sessionCalls(fetchMock)).toBe(3);
  });

  it('stops after a bounded number of retries and offers a manual retry', async () => {
    const user = userEvent.setup();
    let reachable = false;
    const fetchMock = mockApi({
      routes: {
        'GET /api/v1/auth/session': () =>
          reachable ? Response.json(SIGNED_IN_SESSION) : Promise.reject(new TypeError('offline')),
      },
    });
    renderApp('/dashboard', { retryPolicy: FAST });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('PulseDesk isn’t responding')).toBeInTheDocument();
    expect(sessionCalls(fetchMock)).toBe(FAST.maxRetries + 1);

    reachable = true;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Support overview' })).toBeInTheDocument();
  });

  it('does not retry an answer from the API, such as a 403', async () => {
    const fetchMock = mockApi({
      routes: { 'GET /api/v1/auth/session': () => problem(403, 'FORBIDDEN') },
    });
    renderApp('/dashboard', { retryPolicy: FAST });

    expect(await screen.findByText('We couldn’t load your session')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionCalls(fetchMock)).toBe(1);
  });

  it('stops retrying when the page is left mid-retry', async () => {
    const fetchMock = mockApi({ routes: { 'GET /api/v1/auth/session': gateway(503) } });
    const slow = { ...FAST, baseDelayMs: 50, maxDelayMs: 50 };
    const { unmount } = renderApp('/dashboard', { retryPolicy: slow });

    await screen.findByText('Connecting to PulseDesk…');
    unmount();
    const callsAtUnmount = sessionCalls(fetchMock);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sessionCalls(fetchMock)).toBe(callsAtUnmount);
  });

  it('says the API is connecting on the sign-in page, not that it is unreachable', async () => {
    const wake = held();
    let healthCalls = 0;
    mockApi({
      session: null,
      routes: {
        'GET /health': () => (healthCalls++ === 0 ? gateway(504)() : wake.reply()),
      },
    });
    renderApp('/login', { retryPolicy: FAST });

    expect(await screen.findByText('Connecting to PulseDesk…')).toBeInTheDocument();
    expect(screen.queryByText('The PulseDesk API is unreachable')).not.toBeInTheDocument();
  });

  it('never resubmits a sign-in automatically', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      session: null,
      routes: { 'POST /api/v1/auth/login': gateway(503) },
    });
    renderApp('/login', { retryPolicy: FAST });

    await user.type(await screen.findByLabelText(/email/i), 'maya@brightwave.test');
    await user.type(screen.getByLabelText(/^password/i), 'pulsedesk-dev-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/starting up or briefly unavailable/i)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logins = fetchMock.mock.calls.filter(([path]) => path === '/api/v1/auth/login');
    expect(logins).toHaveLength(1);
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
