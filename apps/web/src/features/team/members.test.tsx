import type { Invitation } from '@pulsedesk/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_ID, ME, MEMBERS, bodyOf, json, sessionAs } from '@/test/fixtures';
import { mockApi, problem, renderApp } from '@/test/render';

const TOKEN = 'T'.repeat(43);
const PENDING: Invitation = {
  id: '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b',
  email: 'pending@example.com',
  role: 'AGENT',
  status: 'pending',
  invitedBy: { userId: ME, name: 'Maya Chen' },
  createdAt: '2026-10-30T09:00:00.000Z',
  expiresAt: '2099-11-06T09:00:00.000Z',
};
const EXPIRED: Invitation = {
  ...PENDING,
  id: '2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c',
  email: 'late@example.com',
  role: 'ADMIN',
  status: 'expired',
  expiresAt: '2026-10-01T09:00:00.000Z',
};

function routes(extra: Record<string, (init?: RequestInit) => Response> = {}) {
  return {
    'GET /api/v1/teams': json({ data: [] }),
    'GET /api/v1/members': json(MEMBERS),
    'GET /api/v1/invitations': json({ data: [PENDING, EXPIRED] }),
    ...extra,
  };
}

async function membersTable() {
  renderApp('/team');
  return screen.findByRole('table', { name: 'Organization members' });
}

describe('members', () => {
  it('changes another member’s role at once and confirms it', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    mockApi({
      routes: routes({
        [`PATCH /api/v1/members/${AGENT_ID}`]: (init) => {
          bodies.push(bodyOf(init));
          return Response.json({ ...MEMBERS.data[1], role: 'ADMIN' });
        },
      }),
    });
    const table = await membersTable();
    await user.selectOptions(
      within(table).getByRole('combobox', { name: 'Role for Jonah Reyes' }),
      'ADMIN',
    );
    expect(await screen.findByText('Jonah Reyes is now admin.')).toBeInTheDocument();
    expect(bodies).toEqual([{ role: 'ADMIN' }]);
  });

  it('asks before you change your own role, and shows a refusal on the row', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      routes: routes({
        [`PATCH /api/v1/members/${ME}`]: () =>
          problem(409, 'LAST_OWNER', {
            detail:
              'Every organization must keep at least one owner. Promote another member first.',
          }),
      }),
    });
    const table = await membersTable();
    await user.selectOptions(
      within(table).getByRole('combobox', { name: 'Role for Maya Chen' }),
      'AGENT',
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Change your own role?' });
    // Nothing is sent before confirming.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));
    const select = within(table).getByRole('combobox', { name: 'Role for Maya Chen' });
    await waitFor(() => expect(select).toHaveAccessibleDescription(/must keep at least one owner/));
    expect(select).toHaveValue('OWNER');
  });

  it('removes a member after confirmation, and refreshes invitations they may have sent', async () => {
    const user = userEvent.setup();
    let removed = false;
    const fetchMock = mockApi({
      routes: routes({
        'GET /api/v1/members': () => Response.json(removed ? { data: [MEMBERS.data[0]] } : MEMBERS),
        [`DELETE /api/v1/members/${AGENT_ID}`]: () => {
          removed = true;
          return new Response(null, { status: 204 });
        },
      }),
    });
    const table = await membersTable();
    await user.click(within(table).getByRole('button', { name: 'Remove Jonah Reyes' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Jonah Reyes?' });
    expect(dialog).toHaveTextContent(/assigned tickets become unassigned/);
    expect(dialog).toHaveTextContent(/open invitations are revoked/);
    const invitationFetches = () =>
      fetchMock.mock.calls.filter(
        ([path, init]) => path === '/api/v1/invitations' && (init?.method ?? 'GET') === 'GET',
      ).length;
    const before = invitationFetches();
    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }));
    expect(await screen.findByText('Jonah Reyes was removed.')).toBeInTheDocument();
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    // The API revokes a removed member's open invitations; the list is fetched again.
    await waitFor(() => expect(invitationFetches()).toBeGreaterThan(before));
  });

  it('shows admins owners read-only and never offers ownership', async () => {
    mockApi({ session: sessionAs('ADMIN'), routes: routes() });
    const table = await membersTable();
    expect(within(table).queryByRole('combobox', { name: 'Role for Maya Chen' })).toBeNull();
    expect(within(table).getByText('Owner')).toBeInTheDocument();
    const jonah = within(table).getByRole('combobox', { name: 'Role for Jonah Reyes' });
    expect(within(jonah).queryByRole('option', { name: 'Owner' })).toBeNull();
    expect(within(table).queryByRole('button', { name: 'Remove Maya Chen' })).toBeNull();
  });

  it('shows agents members without controls or invitations', async () => {
    const fetchMock = mockApi({ session: sessionAs('AGENT'), routes: routes() });
    const table = await membersTable();
    expect(within(table).queryByRole('combobox')).toBeNull();
    expect(within(table).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Invitations' })).toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/invitations')).toBe(false);
  });
});

describe('invitations', () => {
  it('lists open invitations with their status and expiry, and revokes after confirmation', async () => {
    const user = userEvent.setup();
    let revoked = false;
    mockApi({
      routes: routes({
        'GET /api/v1/invitations': () =>
          Response.json({ data: revoked ? [EXPIRED] : [PENDING, EXPIRED] }),
        [`DELETE /api/v1/invitations/${PENDING.id}`]: () => {
          revoked = true;
          return new Response(null, { status: 204 });
        },
      }),
    });
    renderApp('/team');
    const list = await screen.findByRole('list', { name: 'Open invitations' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/pending@example.com.*Invited by Maya Chen.*Agent.*Pending/);
    expect(items[1]).toHaveTextContent(/late@example.com.*Expired.*Admin.*Expired/);

    await user.click(
      within(list).getByRole('button', { name: 'Revoke invitation for pending@example.com' }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this invitation?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke invitation' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
  });

  it('invites by email and role, then shows the link once to copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const bodies: unknown[] = [];
    mockApi({
      routes: routes({
        'POST /api/v1/invitations': (init) => {
          const body = bodyOf(init) as { email: string; role: 'ADMIN' | 'AGENT' };
          bodies.push(body);
          if (body.email === 'jonah@brightwave.test') {
            return problem(409, 'ALREADY_MEMBER', {
              detail: 'This person is already a member of the organization.',
            });
          }
          return Response.json(
            { invitation: { ...PENDING, email: body.email, role: body.role }, token: TOKEN },
            { status: 201 },
          );
        },
      }),
    });
    renderApp('/team');
    await user.click(await screen.findByRole('button', { name: 'Invite member' }));
    const form = await screen.findByRole('form', { name: 'Invite a member' });
    const email = within(form).getByRole('textbox', { name: /email/i });

    await user.click(within(form).getByRole('button', { name: 'Create invitation' }));
    expect(email).toHaveAccessibleDescription(/Enter your email address|valid email/);
    expect(bodies).toEqual([]);

    await user.type(email, 'jonah@brightwave.test');
    await user.click(within(form).getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(email).toHaveAccessibleDescription(/already a member/));

    await user.clear(email);
    await user.type(email, 'New.Person@Example.com');
    await user.selectOptions(within(form).getByRole('combobox', { name: /role/i }), 'ADMIN');
    await user.click(within(form).getByRole('button', { name: 'Create invitation' }));

    const dialog = await screen.findByRole('dialog', { name: 'Invitation ready' });
    const link = within(dialog).getByRole('textbox', { name: 'Invitation link' });
    expect(link).toHaveValue(`${window.location.origin}/invite#${TOKEN}`);
    expect(link).toHaveAccessibleDescription(/Shown once/);
    expect(bodies.at(-1)).toEqual({ email: 'new.person@example.com', role: 'ADMIN' });
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/invite#${TOKEN}`);
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    // Closing forgets the link: reopening starts a fresh invitation.
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    expect(await screen.findByRole('form', { name: 'Invite a member' })).toBeInTheDocument();
    expect(screen.queryByText(TOKEN, { exact: false })).toBeNull();
  });
});
