import type { InvitationPreview } from '@pulsedesk/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { bodyOf, json } from '@/test/fixtures';
import { SIGNED_IN_SESSION, mockApi, problem, renderApp } from '@/test/render';

const urlOf = (input: unknown) => (typeof input === 'string' ? input : '');

const TOKEN = 'k'.repeat(43);
const PREVIEW: InvitationPreview = {
  organizationName: 'Brightwave Energy',
  email: 'maya@brightwave.test',
  role: 'ADMIN',
  invitedByName: 'Jonah Reyes',
  expiresAt: '2099-11-06T09:00:00.000Z',
};
const JOINED = {
  ...SIGNED_IN_SESSION,
  activeOrganization: { ...SIGNED_IN_SESSION.activeOrganization, role: 'ADMIN' },
};

function openLink(token = TOKEN) {
  window.history.replaceState(null, '', `/invite#${token}`);
  renderApp(`/invite#${token}`);
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('invitation link', () => {
  it('shows the invitation, removes the token from the address bar and sends it only in a body', async () => {
    const fetchMock = mockApi({
      session: null,
      routes: { 'POST /api/v1/invitations/preview': json(PREVIEW) },
    });
    openLink();
    expect(
      await screen.findByRole('heading', { name: 'Join Brightwave Energy' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Jonah Reyes invited you', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    const previewCall = fetchMock.mock.calls.find(
      ([path]) => path === '/api/v1/invitations/preview',
    );
    expect(bodyOf(previewCall?.[1])).toEqual({ token: TOKEN });
    for (const [path] of fetchMock.mock.calls) expect(urlOf(path)).not.toContain(TOKEN);
  });

  it('creates an account with the invited email and joins', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    mockApi({
      session: null,
      routes: {
        'POST /api/v1/invitations/preview': json(PREVIEW),
        'POST /api/v1/invitations/register': (init) => {
          bodies.push(bodyOf(init));
          return Response.json(JOINED, { status: 201 });
        },
      },
    });
    openLink();
    const form = await screen.findByRole('form', { name: 'Create your account' });
    expect(within(form).getByRole('textbox', { name: 'Email' })).toHaveValue(PREVIEW.email);
    expect(within(form).getByRole('textbox', { name: 'Email' })).toHaveAttribute('readonly');

    await user.click(within(form).getByRole('button', { name: 'Create account and join' }));
    expect(within(form).getByRole('textbox', { name: /your name/i })).toHaveAccessibleDescription(
      'Enter your name',
    );
    expect(bodies).toEqual([]);

    await user.type(within(form).getByRole('textbox', { name: /your name/i }), 'Maya Chen');
    await user.type(within(form).getByLabelText(/^password/i), 'maya@brightwave.test');
    await user.click(within(form).getByRole('button', { name: 'Create account and join' }));
    expect(within(form).getByLabelText(/^password/i)).toHaveAccessibleDescription(
      /can’t be your email/,
    );

    await user.clear(within(form).getByLabelText(/^password/i));
    await user.type(within(form).getByLabelText(/^password/i), 'a long enough password');
    await user.click(within(form).getByRole('button', { name: 'Create account and join' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Support overview' }),
    ).toBeInTheDocument();
    expect(bodies).toEqual([
      { token: TOKEN, name: 'Maya Chen', password: 'a long enough password' },
    ]);
  });

  it('sends someone with an account to sign in, then signs in and accepts in one step', async () => {
    const user = userEvent.setup();
    let signedIn = false;
    mockApi({
      session: null,
      routes: {
        'POST /api/v1/invitations/preview': json(PREVIEW),
        'POST /api/v1/invitations/register': () =>
          problem(409, 'EMAIL_TAKEN', {
            detail: 'An account with this email already exists. Sign in instead.',
          }),
        'POST /api/v1/auth/login': (init) => {
          expect(bodyOf(init)).toEqual({ email: PREVIEW.email, password: 'my real password' });
          signedIn = true;
          return Response.json(SIGNED_IN_SESSION);
        },
        'POST /api/v1/invitations/accept': (init) => {
          expect(signedIn).toBe(true);
          expect(bodyOf(init)).toEqual({ token: TOKEN });
          return Response.json(JOINED);
        },
      },
    });
    openLink();
    const signup = await screen.findByRole('form', { name: 'Create your account' });
    await user.type(within(signup).getByRole('textbox', { name: /your name/i }), 'Maya');
    await user.type(within(signup).getByLabelText(/^password/i), 'a long enough password');
    await user.click(within(signup).getByRole('button', { name: 'Create account and join' }));

    const signin = await screen.findByRole('form', { name: 'Sign in to accept' });
    expect(within(signin).getByText('You already have an account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I have an account' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.type(within(signin).getByLabelText(/^password/i), 'my real password');
    await user.click(within(signin).getByRole('button', { name: 'Sign in and join' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Support overview' }),
    ).toBeInTheDocument();
  });

  it('lets the invited user accept when already signed in', async () => {
    const user = userEvent.setup();
    mockApi({
      routes: {
        'POST /api/v1/invitations/preview': json(PREVIEW),
        'POST /api/v1/invitations/accept': json(JOINED),
      },
    });
    openLink();
    await user.click(await screen.findByRole('button', { name: 'Accept and join' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Support overview' }),
    ).toBeInTheDocument();
  });

  it('tells someone signed in with another email, and offers to sign out', async () => {
    const user = userEvent.setup();
    mockApi({
      routes: {
        'POST /api/v1/invitations/preview': json({ ...PREVIEW, email: 'someone@else.test' }),
        'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
      },
    });
    openLink();
    expect(await screen.findByText('This invitation is for someone else')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and join' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(screen.getByRole('form', { name: 'Create your account' })).toBeInTheDocument(),
    );
  });

  it('explains a used, expired or revoked link', async () => {
    mockApi({
      session: null,
      routes: {
        'POST /api/v1/invitations/preview': () =>
          problem(410, 'INVITATION_INVALID', {
            detail: 'This invitation has expired. Ask for a new invitation.',
          }),
      },
    });
    openLink();
    expect(
      await screen.findByRole('heading', { name: 'This invitation can’t be used' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('This invitation has expired. Ask for a new invitation.'),
    ).toBeInTheDocument();
  });

  it('picks up another link opened on this page (only the fragment changes)', async () => {
    mockApi({ session: null, routes: { 'POST /api/v1/invitations/preview': json(PREVIEW) } });
    openLink('too-short');
    expect(
      await screen.findByRole('heading', { name: 'This invitation link is incomplete' }),
    ).toBeInTheDocument();
    window.location.hash = TOKEN;
    expect(
      await screen.findByRole('heading', { name: 'Join Brightwave Energy' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('never calls the API for an incomplete link', async () => {
    const fetchMock = mockApi({ session: null });
    openLink('too-short');
    expect(
      await screen.findByRole('heading', { name: 'This invitation link is incomplete' }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => urlOf(path).includes('invitations'))).toBe(false);
  });
});
