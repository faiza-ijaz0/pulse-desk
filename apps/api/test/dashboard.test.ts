import { dashboardSummaryResponseSchema } from '@pulsedesk/shared';
import { describe, expect, it } from 'vitest';
import type {
  DashboardFilter,
  DashboardRepository,
  DashboardSnapshot,
  WorkloadRow,
} from '../src/modules/dashboard/dashboard.repository.ts';
import {
  createDashboardService,
  dashboardScope,
} from '../src/modules/dashboard/dashboard.service.ts';

// The service's own decisions, without a database: the scope rule, the window, totals from
// per-assignee rows, and "no data" as null. test/integration/dashboard.int.test.ts covers the
// SQL, the SLA classification and tenant isolation.

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const AGENT = '00000000-0000-4000-8000-0000000000b2';
const IDLE = '00000000-0000-4000-8000-0000000000b3';
const NOW = new Date('2026-11-04T12:00:00.000Z');

function workload(assigneeUserId: string | null, counts: Partial<WorkloadRow>): WorkloadRow {
  return {
    assigneeUserId,
    active: 0,
    open: 0,
    pending: 0,
    onHold: 0,
    awaitingFirstResponse: 0,
    none: 0,
    met: 0,
    on_track: 0,
    at_risk: 0,
    first_response_breached: 0,
    resolution_breached: 0,
    ...counts,
  };
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
  statusCounts: [],
  workload: [],
  attention: [],
  timing: {
    firstResponseCount: 0,
    firstResponseAverageSeconds: null,
    resolutionCount: 0,
    resolutionAverageSeconds: null,
  },
  members: [],
};

function serviceWith(snapshot: Partial<DashboardSnapshot>) {
  const calls: { filter: DashboardFilter; now: Date; windowStart: Date }[] = [];
  const repository: DashboardRepository = {
    snapshot(filter, now, windowStart) {
      calls.push({ filter, now, windowStart });
      return Promise.resolve({ ...EMPTY_SNAPSHOT, ...snapshot });
    },
  };
  const service = createDashboardService({ repository, clock: { now: () => NOW } });
  return { service, calls };
}

const tenant = (role: 'OWNER' | 'ADMIN' | 'AGENT', userId = OWNER) => ({
  organizationId: ORG,
  userId,
  role,
  requestId: 'test',
});

describe('dashboardScope', () => {
  it('gives owners and admins the organization, agents only their own tickets', () => {
    expect(dashboardScope('OWNER')).toBe('organization');
    expect(dashboardScope('ADMIN')).toBe('organization');
    expect(dashboardScope('AGENT')).toBe('own');
  });
});

describe('dashboard service', () => {
  it('queries the session organization, narrowed to the caller for agents', async () => {
    const { service, calls } = serviceWith({});
    await service.summary(tenant('ADMIN'));
    await service.summary(tenant('AGENT', AGENT));

    expect(calls.map((c) => c.filter)).toEqual([
      { organizationId: ORG, assigneeUserId: null },
      { organizationId: ORG, assigneeUserId: AGENT },
    ]);
  });

  it('averages over the 30 days before the clock', async () => {
    const { service, calls } = serviceWith({});
    const summary = await service.summary(tenant('OWNER'));

    expect(calls[0]?.now).toEqual(NOW);
    expect(calls[0]?.windowStart).toEqual(new Date('2026-10-05T12:00:00.000Z'));
    expect(summary.generatedAt).toBe(NOW.toISOString());
    expect(summary.responseTimes).toMatchObject({
      windowDays: 30,
      windowStart: '2026-10-05T12:00:00.000Z',
    });
  });

  it('describes an empty organization with zeros and no averages', async () => {
    const { service } = serviceWith({
      members: [{ userId: OWNER, role: 'OWNER', user: { name: 'Only Owner' } }],
    });
    const summary = dashboardSummaryResponseSchema.parse(await service.summary(tenant('OWNER')));

    expect(summary.tickets).toEqual({
      byStatus: { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 },
      active: 0,
      awaitingFirstResponse: 0,
      unassigned: 0,
    });
    expect(Object.values(summary.sla.active).every((n) => n === 0)).toBe(true);
    expect(summary.responseTimes.firstResponse).toEqual({ count: 0, averageSeconds: null });
    expect(summary.responseTimes.resolution).toEqual({ count: 0, averageSeconds: null });
    expect(summary.agents).toEqual([
      expect.objectContaining({ userId: OWNER, active: 0, atRisk: 0, breached: 0 }),
    ]);
  });

  it('totals the per-assignee rows and keeps members without tickets', async () => {
    const { service } = serviceWith({
      statusCounts: [
        { status: 'OPEN', count: 4 },
        { status: 'PENDING', count: 1 },
        { status: 'CLOSED', count: 7 },
      ],
      workload: [
        workload(AGENT, { active: 3, open: 2, pending: 1, at_risk: 1, resolution_breached: 2 }),
        workload(null, { active: 2, open: 2, awaitingFirstResponse: 2, on_track: 1, none: 1 }),
      ],
      members: [
        { userId: OWNER, role: 'OWNER', user: { name: 'Zed Owner' } },
        { userId: IDLE, role: 'AGENT', user: { name: 'Ada Idle' } },
        { userId: AGENT, role: 'AGENT', user: { name: 'Busy Agent' } },
      ],
    });
    const summary = dashboardSummaryResponseSchema.parse(await service.summary(tenant('OWNER')));

    expect(summary.tickets).toMatchObject({
      byStatus: { OPEN: 4, PENDING: 1, ON_HOLD: 0, SOLVED: 0, CLOSED: 7 },
      active: 5,
      awaitingFirstResponse: 2,
      unassigned: 2,
    });
    expect(summary.sla.active).toEqual({
      none: 1,
      met: 0,
      on_track: 1,
      at_risk: 1,
      first_response_breached: 0,
      resolution_breached: 2,
    });
    // Busiest first, then by name; members without tickets stay, at zero.
    expect(summary.agents.map((a) => [a.name, a.active, a.atRisk, a.breached])).toEqual([
      ['Busy Agent', 3, 1, 2],
      ['Ada Idle', 0, 0, 0],
      ['Zed Owner', 0, 0, 0],
    ]);
  });

  it('has no unassigned count in the own scope', async () => {
    const { service } = serviceWith({
      workload: [workload(AGENT, { active: 1, open: 1 })],
      members: [{ userId: AGENT, role: 'AGENT', user: { name: 'Agent' } }],
    });
    const summary = await service.summary(tenant('AGENT', AGENT));

    expect(summary.scope).toBe('own');
    expect(summary.tickets.unassigned).toBeNull();
    expect(summary.agents.map((a) => a.userId)).toEqual([AGENT]);
  });

  it('never reports an average without tickets behind it', async () => {
    const { service } = serviceWith({
      timing: {
        firstResponseCount: 0,
        firstResponseAverageSeconds: 12,
        resolutionCount: 2,
        resolutionAverageSeconds: 5400,
      },
    });
    const { responseTimes } = await service.summary(tenant('OWNER'));

    expect(responseTimes.firstResponse).toEqual({ count: 0, averageSeconds: null });
    expect(responseTimes.resolution).toEqual({ count: 2, averageSeconds: 5400 });
  });

  it('serializes attention due dates, keeping a missing one as null', async () => {
    const { service } = serviceWith({
      attention: [
        {
          number: 7,
          subject: 'Late',
          priority: 'URGENT',
          status: 'resolution_breached',
          target: 'resolution',
          dueAt: new Date('2026-11-04T10:00:00.000Z'),
        },
        {
          number: 8,
          subject: 'Odd data',
          priority: 'LOW',
          status: 'first_response_breached',
          target: 'firstResponse',
          dueAt: null,
        },
      ],
    });
    const { sla } = dashboardSummaryResponseSchema.parse(await service.summary(tenant('OWNER')));

    expect(sla.attention.map((t) => [t.number, t.dueAt])).toEqual([
      [7, '2026-11-04T10:00:00.000Z'],
      [8, null],
    ]);
  });
});
