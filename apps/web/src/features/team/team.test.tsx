import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AGENT_ID, BILLING_ID, MEMBERS, bodyOf, json, sessionAs, team } from '@/test/fixtures';
import { mockApi, problem, renderApp } from '@/test/render';

const BILLING = team({ members: [{ userId: AGENT_ID, name: 'Jonah Reyes' }] });

describe('agents & teams page', () => {
  it('lists teams with their members, and organization members with roles', async () => {
    mockApi({
      routes: {
        'GET /api/v1/teams': json({ data: [BILLING] }),
        'GET /api/v1/members': json(MEMBERS),
      },
    });
    renderApp('/team');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Agents & teams' }),
    ).toBeInTheDocument();
    const billing = await screen.findByRole('region', { name: 'Billing' });
    expect(within(billing).getByText('Jonah Reyes')).toBeInTheDocument();
    const members = screen.getByRole('list', { name: 'Organization members' });
    expect(within(members).getAllByRole('listitem')).toHaveLength(2);
    expect(members).toHaveTextContent('Owner');
    expect(members).toHaveTextContent('Agent');
  });

  it('creates a team and shows validation and conflict errors', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let teams = [BILLING];
    mockApi({
      routes: {
        'GET /api/v1/teams': () => Response.json({ data: teams }),
        'GET /api/v1/members': json(MEMBERS),
        'POST /api/v1/teams': (init) => {
          const body = bodyOf(init) as { name: string };
          bodies.push(body);
          if (body.name === 'Billing') {
            return problem(409, 'CONFLICT', {
              detail: 'A team with this name already exists in this organization.',
            });
          }
          const created = team({ id: '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a', name: body.name });
          teams = [...teams, created];
          return Response.json(created, { status: 201 });
        },
      },
    });
    renderApp('/team');

    const form = await screen.findByRole('form', { name: 'New team' });
    const name = within(form).getByLabelText('Team name');
    await user.click(within(form).getByRole('button', { name: 'Create team' }));
    expect(name).toHaveAccessibleDescription('Enter a team name');
    expect(bodies).toEqual([]);

    await user.type(name, 'Billing');
    await user.click(within(form).getByRole('button', { name: 'Create team' }));
    await waitFor(() =>
      expect(name).toHaveAccessibleDescription(
        'A team with this name already exists in this organization.',
      ),
    );

    await user.clear(name);
    await user.type(name, 'Escalations');
    await user.click(within(form).getByRole('button', { name: 'Create team' }));
    expect(await screen.findByRole('region', { name: 'Escalations' })).toBeInTheDocument();
    expect(name).toHaveValue('');
  });

  it('adds and removes team members', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    let current = team();
    mockApi({
      routes: {
        'GET /api/v1/teams': () => Response.json({ data: [current] }),
        'GET /api/v1/members': json(MEMBERS),
        [`PUT /api/v1/teams/${BILLING_ID}/members/${AGENT_ID}`]: () => {
          calls.push('add');
          current = BILLING;
          return Response.json(BILLING);
        },
        [`DELETE /api/v1/teams/${BILLING_ID}/members/${AGENT_ID}`]: () => {
          calls.push('remove');
          current = team();
          return new Response(null, { status: 204 });
        },
      },
    });
    renderApp('/team');

    const billing = await screen.findByRole('region', { name: 'Billing' });
    await waitFor(() =>
      expect(within(billing).getByRole('option', { name: 'Jonah Reyes' })).toBeInTheDocument(),
    );
    await user.selectOptions(
      within(billing).getByRole('combobox', { name: 'Add a member to Billing' }),
      AGENT_ID,
    );
    await user.click(within(billing).getByRole('button', { name: 'Add' }));
    await user.click(
      await within(billing).findByRole('button', { name: 'Remove Jonah Reyes from Billing' }),
    );
    await waitFor(() => expect(calls).toEqual(['add', 'remove']));
  });

  it('renames and deletes a team after confirmation', async () => {
    const user = userEvent.setup();
    const calls: unknown[] = [];
    mockApi({
      routes: {
        'GET /api/v1/teams': json({ data: [team()] }),
        'GET /api/v1/members': json(MEMBERS),
        [`PATCH /api/v1/teams/${BILLING_ID}`]: (init) => {
          calls.push(bodyOf(init));
          return Response.json(team({ name: 'Billing EU' }));
        },
        [`DELETE /api/v1/teams/${BILLING_ID}`]: () => {
          calls.push('delete');
          return new Response(null, { status: 204 });
        },
      },
    });
    renderApp('/team');

    const billing = await screen.findByRole('region', { name: 'Billing' });
    await user.click(within(billing).getByRole('button', { name: 'Rename Billing' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename team' });
    await user.clear(within(rename).getByLabelText('Team name'));
    await user.type(within(rename).getByLabelText('Team name'), 'Billing EU');
    await user.click(within(rename).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toEqual([{ name: 'Billing EU' }]));

    await user.click(within(billing).getByRole('button', { name: 'Delete Billing' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete Billing?' });
    expect(confirm).toHaveTextContent(/tickets in this team keep their history/i);
    await user.click(within(confirm).getByRole('button', { name: 'Delete team' }));
    await waitFor(() => expect(calls).toEqual([{ name: 'Billing EU' }, 'delete']));
  });

  it('shows teams read-only to agents', async () => {
    mockApi({
      session: sessionAs('AGENT'),
      routes: {
        'GET /api/v1/teams': json({ data: [BILLING] }),
        'GET /api/v1/members': json(MEMBERS),
      },
    });
    renderApp('/team');

    const billing = await screen.findByRole('region', { name: 'Billing' });
    expect(within(billing).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New team' })).not.toBeInTheDocument();
    expect(screen.getByText(/only admins and owners can manage teams/i)).toBeInTheDocument();
  });
});
