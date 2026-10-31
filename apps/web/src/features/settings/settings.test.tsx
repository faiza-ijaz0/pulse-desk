import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { VIP_ID, bodyOf, json, sessionAs, tag } from '@/test/fixtures';
import { SIGNED_IN_SESSION, mockApi, problem, renderApp } from '@/test/render';

const ORGANIZATION = {
  id: SIGNED_IN_SESSION.activeOrganization.id,
  name: 'Brightwave Energy',
  slug: 'brightwave',
  createdAt: '2026-10-01T00:00:00.000Z',
  autoCloseEnabled: false,
  autoCloseAfterMinutes: 5760,
};

describe('organization settings', () => {
  it('renames the organization and refreshes the session', async () => {
    const user = userEvent.setup();
    let renamed = false;
    const bodies: unknown[] = [];
    mockApi({
      routes: {
        'GET /api/v1/organization': json(ORGANIZATION),
        'GET /api/v1/tags': json({ data: [] }),
        'GET /api/v1/auth/session': () =>
          Response.json(
            renamed
              ? {
                  ...SIGNED_IN_SESSION,
                  activeOrganization: {
                    ...SIGNED_IN_SESSION.activeOrganization,
                    name: 'Brightwave Group',
                  },
                }
              : SIGNED_IN_SESSION,
          ),
        'PATCH /api/v1/organization': (init) => {
          bodies.push(bodyOf(init));
          renamed = true;
          return Response.json({ ...ORGANIZATION, name: 'Brightwave Group' });
        },
      },
    });
    renderApp('/settings');

    const form = await screen.findByRole('form', { name: 'Organization profile' });
    const name = within(form).getByLabelText(/^organization name/i);
    await waitFor(() => expect(name).toHaveValue('Brightwave Energy'));
    expect(within(form).getByText('brightwave')).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, 'Brightwave Group');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    expect(await within(form).findByText('Saved')).toBeInTheDocument();
    expect(bodies).toEqual([{ name: 'Brightwave Group' }]);
    // The workspace switcher reads the session, which is refreshed after the rename.
    await waitFor(() => expect(screen.getAllByText('Brightwave Group').length).toBeGreaterThan(0));
  });

  it('validates the name before saving', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      routes: {
        'GET /api/v1/organization': json(ORGANIZATION),
        'GET /api/v1/tags': json({ data: [] }),
      },
    });
    renderApp('/settings');
    const form = await screen.findByRole('form', { name: 'Organization profile' });
    const name = within(form).getByLabelText(/^organization name/i);
    await waitFor(() => expect(name).toHaveValue('Brightwave Energy'));
    await user.clear(name);
    await user.type(name, 'B');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(name).toHaveAccessibleDescription('Use at least 2 characters');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('shows the profile read-only to agents', async () => {
    mockApi({
      session: sessionAs('AGENT'),
      routes: {
        'GET /api/v1/organization': json(ORGANIZATION),
        'GET /api/v1/tags': json({ data: [tag()] }),
      },
    });
    renderApp('/settings');
    expect(await screen.findByText('Brightwave Energy', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Organization profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New tag' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/only admins and owners/i).length).toBeGreaterThan(0);
  });
});

describe('tag management', () => {
  it('lists tags with usage, and creates one with a color', async () => {
    const user = userEvent.setup();
    let tags = [tag()];
    const bodies: unknown[] = [];
    mockApi({
      routes: {
        'GET /api/v1/organization': json(ORGANIZATION),
        'GET /api/v1/tags': () => Response.json({ data: tags }),
        'POST /api/v1/tags': (init) => {
          const body = bodyOf(init) as { name: string; color: 'red' | null };
          bodies.push(body);
          if (body.name.toLowerCase() === 'vip') {
            return problem(409, 'CONFLICT', {
              detail: 'A tag with this name already exists in this organization.',
            });
          }
          const created = tag({
            id: '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b',
            ...body,
            ticketCount: 0,
          });
          tags = [...tags, created];
          return Response.json(created, { status: 201 });
        },
      },
    });
    renderApp('/settings');

    const list = await screen.findByRole('list', { name: 'Tags' });
    expect(within(list).getByText('vip')).toBeInTheDocument();
    expect(list).toHaveTextContent('3 tickets');

    const form = screen.getByRole('form', { name: 'New tag' });
    await user.type(within(form).getByLabelText('Tag name'), 'VIP');
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    await waitFor(() =>
      expect(within(form).getByLabelText('Tag name')).toHaveAccessibleDescription(
        'A tag with this name already exists in this organization.',
      ),
    );

    await user.clear(within(form).getByLabelText('Tag name'));
    await user.type(within(form).getByLabelText('Tag name'), 'refund');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Color' }), 'red');
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    expect(await within(list).findByText('refund')).toBeInTheDocument();
    expect(bodies.at(-1)).toEqual({ name: 'refund', color: 'red' });
  });

  it('renames a tag inline', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    mockApi({
      routes: {
        'GET /api/v1/organization': json(ORGANIZATION),
        'GET /api/v1/tags': json({ data: [tag()] }),
        [`PATCH /api/v1/tags/${VIP_ID}`]: (init) => {
          bodies.push(bodyOf(init));
          return Response.json(tag({ name: 'gold' }));
        },
      },
    });
    renderApp('/settings');

    await user.click(await screen.findByRole('button', { name: 'Edit vip' }));
    const form = screen.getByRole('form', { name: 'Edit tag vip' });
    await user.clear(within(form).getByLabelText('Tag name'));
    await user.type(within(form).getByLabelText('Tag name'), 'gold');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual([{ name: 'gold', color: 'amber' }]));
  });

  it('explains what deleting a used tag does before deleting it', async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      routes: {
        'GET /api/v1/organization': json(ORGANIZATION),
        'GET /api/v1/tags': () => Response.json({ data: deleted ? [] : [tag()] }),
        [`DELETE /api/v1/tags/${VIP_ID}`]: () => {
          deleted = true;
          return new Response(null, { status: 204 });
        },
      },
    });
    renderApp('/settings');

    await user.click(await screen.findByRole('button', { name: 'Delete vip' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete the tag “vip”?' });
    expect(confirm).toHaveTextContent('It will be removed from 3 tickets');
    await user.click(within(confirm).getByRole('button', { name: 'Delete tag' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete vip' })).not.toBeInTheDocument(),
    );
  });
});

describe('auto-close settings', () => {
  const routes = (org: object, onPatch?: (body: unknown) => Response) => ({
    'GET /api/v1/organization': json(org),
    'GET /api/v1/tags': json({ data: [] }),
    ...(onPatch && { 'PATCH /api/v1/organization': (init?: RequestInit) => onPatch(bodyOf(init)) }),
  });

  it('turns auto-close on with a new delay, warning that solved tickets are included', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    mockApi({
      routes: routes(ORGANIZATION, (body) => {
        bodies.push(body);
        return Response.json({
          ...ORGANIZATION,
          autoCloseEnabled: true,
          autoCloseAfterMinutes: 2880,
        });
      }),
    });
    renderApp('/settings');

    const form = await screen.findByRole('form', { name: 'Auto-close settings' });
    const toggle = within(form).getByRole('switch', {
      name: /close solved tickets automatically/i,
    });
    expect(toggle).not.toBeChecked();
    expect(within(form).getByText('Off')).toBeInTheDocument();
    const delay = within(form).getByLabelText(/^close after/i);
    expect(delay).toHaveValue('4');
    expect(within(form).getByRole('combobox', { name: 'Unit' })).toHaveValue('days');
    expect(within(form).queryByText('Already-solved tickets are included')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(within(form).getByText('On')).toBeInTheDocument();
    expect(within(form).getByText('Already-solved tickets are included')).toBeInTheDocument();
    await user.clear(delay);
    await user.type(delay, '2');
    await user.click(within(form).getByRole('button', { name: 'Save auto-close' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(bodies).toEqual([{ autoCloseEnabled: true, autoCloseAfterMinutes: 2880 }]);
  });

  it('validates the delay before saving', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ routes: routes(ORGANIZATION) });
    renderApp('/settings');
    const form = await screen.findByRole('form', { name: 'Auto-close settings' });
    const delay = within(form).getByLabelText(/^close after/i);
    await user.clear(delay);
    await user.type(delay, '400');
    await user.click(within(form).getByRole('button', { name: 'Save auto-close' }));
    expect(delay).toHaveAccessibleDescription(/Must be at most 365 days\./);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('keeps a delay that isn’t whole hours unless the admin enters a new one', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const org = { ...ORGANIZATION, autoCloseEnabled: true, autoCloseAfterMinutes: 90 };
    mockApi({
      routes: routes(org, (body) => {
        bodies.push(body);
        return Response.json({ ...org, autoCloseEnabled: false });
      }),
    });
    renderApp('/settings');
    const form = await screen.findByRole('form', { name: 'Auto-close settings' });
    expect(within(form).getByText(/Currently 90 minutes/)).toBeInTheDocument();
    await user.click(
      within(form).getByRole('switch', { name: /close solved tickets automatically/i }),
    );
    await user.click(within(form).getByRole('button', { name: 'Save auto-close' }));
    await waitFor(() => expect(bodies).toEqual([{ autoCloseEnabled: false }]));
  });

  it('shows a server refusal next to the delay', async () => {
    const user = userEvent.setup();
    mockApi({
      routes: routes(ORGANIZATION, () =>
        problem(400, 'VALIDATION_FAILED', {
          errors: [{ path: 'body.autoCloseAfterMinutes', message: 'Must be at most 365 days' }],
        }),
      ),
    });
    renderApp('/settings');
    const form = await screen.findByRole('form', { name: 'Auto-close settings' });
    const delay = within(form).getByLabelText(/^close after/i);
    await user.clear(delay);
    await user.type(delay, '3');
    await user.click(within(form).getByRole('button', { name: 'Save auto-close' }));
    await waitFor(() => expect(delay).toHaveAccessibleDescription(/Must be at most 365 days/));
  });

  it('shows agents the settings read-only', async () => {
    mockApi({
      session: sessionAs('AGENT'),
      routes: routes({ ...ORGANIZATION, autoCloseEnabled: true }),
    });
    renderApp('/settings');
    const card = await screen.findByRole('region', { name: 'Auto-close' });
    await waitFor(() => expect(within(card).getByText('4 days')).toBeInTheDocument());
    expect(within(card).getByText('On')).toBeInTheDocument();
    expect(within(card).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Save auto-close' })).not.toBeInTheDocument();
  });
});
