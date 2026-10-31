import { DEFAULT_SLA_TARGETS, type SlaPolicy } from '@pulsedesk/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { bodyOf, json, sessionAs } from '@/test/fixtures';
import { mockApi, problem, renderApp } from '@/test/render';

const POLICY: SlaPolicy = {
  id: '7d0c1c55-1f6a-4c9b-a9a3-2f2b9c1e0a10',
  name: 'Standard',
  updatedAt: '2026-10-29T09:00:00.000Z',
  targets: structuredClone(DEFAULT_SLA_TARGETS),
};

type Body = { targets: SlaPolicy['targets'] };

function routes(policy: SlaPolicy | null, onSave?: (body: Body) => Response) {
  return {
    'GET /api/v1/sla-policy': json({ policy }),
    'PUT /api/v1/sla-policy': (init?: RequestInit) => {
      const body = bodyOf(init) as Body;
      return (
        onSave?.(body) ??
        Response.json({
          policy: { ...POLICY, updatedAt: '2026-10-30T10:00:00.000Z', targets: body.targets },
        })
      );
    },
  };
}

async function openForm() {
  renderApp('/sla');
  const form = await screen.findByRole('form', { name: 'SLA targets' });
  const target = (priority: string, label: 'First response' | 'Resolution') => {
    const group = within(form).getByRole('group', { name: priority });
    return {
      amount: within(group).getByRole('textbox', { name: label }),
      unit: within(group).getByRole('combobox', { name: `${label} unit` }),
    };
  };
  return { form, target };
}

describe('SLA policy page', () => {
  it('shows the stored targets in their largest whole unit and saves every priority', async () => {
    const user = userEvent.setup();
    const bodies: Body[] = [];
    mockApi({
      routes: routes(POLICY, (body) => {
        bodies.push(body);
        return Response.json({ policy: { ...POLICY, targets: body.targets } });
      }),
    });
    const { form, target } = await openForm();
    expect(screen.getByRole('heading', { level: 1, name: 'SLA policies' })).toBeInTheDocument();
    expect(screen.getByText('Standard · default')).toBeInTheDocument();
    expect(target('Urgent', 'First response').amount).toHaveValue('30');
    expect(target('Urgent', 'First response').unit).toHaveValue('minutes');
    expect(target('Urgent', 'Resolution').amount).toHaveValue('4');
    expect(target('Urgent', 'Resolution').unit).toHaveValue('hours');
    expect(target('Low', 'Resolution').amount).toHaveValue('3');
    expect(target('Low', 'Resolution').unit).toHaveValue('days');

    const urgent = target('Urgent', 'First response');
    await user.clear(urgent.amount);
    await user.type(urgent.amount, '15');
    await user.selectOptions(target('High', 'Resolution').unit, 'days');
    await user.click(within(form).getByRole('button', { name: 'Save targets' }));

    expect(await within(form).findByText('Saved')).toBeInTheDocument();
    expect(bodies).toEqual([
      {
        targets: {
          ...DEFAULT_SLA_TARGETS,
          URGENT: { firstResponseMinutes: 15, resolutionMinutes: 240 },
          HIGH: { firstResponseMinutes: 60, resolutionMinutes: 8 * 24 * 60 },
        },
      },
    ]);
  });

  it('validates every target before saving, and clears an error once it is edited', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ routes: routes(POLICY) });
    const { form, target } = await openForm();

    const high = target('High', 'Resolution');
    await user.clear(high.amount);
    await user.type(high.amount, '30');
    await user.selectOptions(high.unit, 'minutes');
    const low = target('Low', 'First response');
    await user.clear(low.amount);
    await user.type(low.amount, '1.5');
    const normal = target('Normal', 'Resolution');
    await user.clear(normal.amount);
    await user.type(normal.amount, '400');
    await user.selectOptions(normal.unit, 'days');
    const urgent = target('Urgent', 'First response');
    await user.clear(urgent.amount);
    await user.click(within(form).getByRole('button', { name: 'Save targets' }));

    expect(high.amount).toHaveAccessibleDescription('Must be at least the first-response target.');
    expect(high.amount).toHaveAttribute('aria-invalid', 'true');
    expect(low.amount).toHaveAccessibleDescription('Enter a whole number.');
    expect(normal.amount).toHaveAccessibleDescription('Must be at most 365 days.');
    expect(urgent.amount).toHaveAccessibleDescription('Enter a target.');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    await user.type(urgent.amount, '20');
    expect(urgent.amount).not.toHaveAttribute('aria-invalid');
    expect(high.amount).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a server refusal next to its target, and other failures in an alert', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    mockApi({
      routes: routes(POLICY, () =>
        ++attempt === 1
          ? problem(400, 'VALIDATION_FAILED', {
              errors: [
                { path: 'body.targets.LOW.resolutionMinutes', message: 'Must be at most 365 days' },
              ],
            })
          : problem(500, 'INTERNAL_ERROR'),
      ),
    });
    const { form, target } = await openForm();
    const save = within(form).getByRole('button', { name: 'Save targets' });

    await user.click(save);
    await waitFor(() =>
      expect(target('Low', 'Resolution').amount).toHaveAccessibleDescription(
        'Must be at most 365 days',
      ),
    );

    await user.click(save);
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t save the targets');
    expect(alert).toHaveTextContent(/Something went wrong/);
    expect(within(form).queryByText('Saved')).not.toBeInTheDocument();
    // The entered values are kept for another try.
    expect(target('Urgent', 'First response').amount).toHaveValue('30');
  });

  it('offers the recommended targets to an organization without a policy, and creates it', async () => {
    const user = userEvent.setup();
    const bodies: Body[] = [];
    mockApi({
      routes: routes(null, (body) => {
        bodies.push(body);
        return Response.json({ policy: { ...POLICY, targets: body.targets } });
      }),
    });
    const { form, target } = await openForm();
    expect(within(form).getByText('No SLA policy yet')).toBeInTheDocument();
    expect(target('Normal', 'First response').amount).toHaveValue('4');

    await user.click(within(form).getByRole('button', { name: 'Create policy' }));
    await waitFor(() => expect(bodies).toEqual([{ targets: DEFAULT_SLA_TARGETS }]));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save targets' })).toBeInTheDocument();
  });

  it('fills a missing target with its default and marks it', async () => {
    mockApi({ routes: routes({ ...POLICY, targets: { ...POLICY.targets, LOW: null } }) });
    const { form, target } = await openForm();
    expect(within(form).getByText('Not set yet')).toBeInTheDocument();
    expect(target('Low', 'First response').amount).toHaveValue('8');
    expect(target('Low', 'First response').unit).toHaveValue('hours');
  });

  it('restores the recommended targets without saving', async () => {
    const user = userEvent.setup();
    const custom = {
      ...POLICY,
      targets: { ...POLICY.targets, URGENT: { firstResponseMinutes: 5, resolutionMinutes: 60 } },
    };
    const fetchMock = mockApi({ routes: routes(custom) });
    const { form, target } = await openForm();
    expect(target('Urgent', 'First response').amount).toHaveValue('5');
    await user.click(within(form).getByRole('button', { name: 'Use recommended targets' }));
    expect(target('Urgent', 'First response').amount).toHaveValue('30');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('offers a retry when the policy can’t be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockApi({
      routes: {
        'GET /api/v1/sla-policy': () =>
          fail ? problem(500, 'INTERNAL_ERROR') : Response.json({ policy: POLICY }),
      },
    });
    renderApp('/sla');
    expect(await screen.findByText('Couldn’t load SLA targets')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('form', { name: 'SLA targets' })).toBeInTheDocument();
  });

  it('shows agents the targets read-only', async () => {
    mockApi({ session: sessionAs('AGENT'), routes: routes(POLICY) });
    renderApp('/sla');
    const table = await screen.findByRole('table', { name: 'SLA targets by priority' });
    const urgent = within(table).getByRole('row', { name: /Urgent/ });
    expect(
      within(urgent)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['30 minutes', '4 hours']);
    expect(screen.getByText('Only admins and owners can change SLA targets.')).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('tells agents when there is no policy', async () => {
    mockApi({ session: sessionAs('AGENT'), routes: routes(null) });
    renderApp('/sla');
    expect(
      await screen.findByText(/has no SLA policy, so tickets have no due dates/),
    ).toBeInTheDocument();
  });
});
