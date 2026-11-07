import type { Database, TicketPriority, TicketStatus } from '@pulsedesk/db';
import {
  ACTIVE_TICKET_STATUSES,
  dashboardSummaryResponseSchema,
  evaluateSla,
  problemDetailsSchema,
  SLA_STATUSES,
  type DashboardSummary,
  type Role,
} from '@pulsedesk/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDashboardRepository } from '../../src/modules/dashboard/dashboard.repository.ts';
import { createDashboardService } from '../../src/modules/dashboard/dashboard.service.ts';
import {
  addMember,
  buildIntegrationApp,
  cleanupTestData,
  createTestDb,
  registerOwner,
  signIn,
  type RegisteredOwner,
} from './helpers.ts';
import { WEB_ORIGIN } from '../helpers.ts';

// The dashboard against real PostgreSQL. HTTP tests use the production composition (and the
// real clock) for authentication, scope and tenant isolation. Metric tests call the service
// with a fixed clock, so SLA boundaries can be hit to the millisecond. The test clients run
// with the tenant guard on, so any unscoped model query would throw.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date('2030-06-15T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];
let labelIndex = 0;

type Org = RegisteredOwner & { customerId: string; nextNumber: number };

async function newOrg(label: string): Promise<Org> {
  const owner = await registerOwner(app, `dash-${label}-${labelIndex++}`);
  const customer = await db.customer.create({
    data: { organizationId: owner.organizationId, email: `dash-${labelIndex}@example.com` },
  });
  return { ...owner, customerId: customer.id, nextNumber: 1 };
}

type TicketSetup = {
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeUserId?: string | null;
  createdAt?: Date;
  firstResponseDueAt?: Date | null;
  resolutionDueAt?: Date | null;
  firstRespondedAt?: Date | null;
  solvedAt?: Date | null;
  closedAt?: Date | null;
  firstResponseBreachedAt?: Date | null;
  resolutionBreachedAt?: Date | null;
  subject?: string;
};

async function ticket(org: Org, setup: TicketSetup = {}) {
  const createdAt = setup.createdAt ?? at(-HOUR);
  return db.ticket.create({
    data: {
      organizationId: org.organizationId,
      number: org.nextNumber++,
      subject: setup.subject ?? 'Dashboard',
      customerId: org.customerId,
      status: setup.status ?? 'OPEN',
      priority: setup.priority ?? 'NORMAL',
      assigneeUserId: setup.assigneeUserId ?? null,
      createdAt,
      updatedAt: createdAt,
      firstResponseDueAt: setup.firstResponseDueAt ?? null,
      resolutionDueAt: setup.resolutionDueAt ?? null,
      firstRespondedAt: setup.firstRespondedAt ?? null,
      solvedAt: setup.solvedAt ?? null,
      closedAt: setup.closedAt ?? null,
      firstResponseBreachedAt: setup.firstResponseBreachedAt ?? null,
      resolutionBreachedAt: setup.resolutionBreachedAt ?? null,
    },
  });
}

/** The dashboard at NOW, as the given member sees it. */
async function summaryAt(org: Org, role: Role = 'OWNER', userId = org.userId) {
  const service = createDashboardService({
    repository: createDashboardRepository(db),
    clock: { now: () => NOW },
  });
  const summary = await service.summary({
    organizationId: org.organizationId,
    userId,
    role,
    requestId: 'int-test',
  });
  return dashboardSummaryResponseSchema.parse(summary);
}

async function fetchSummary(client: RegisteredOwner['client']): Promise<DashboardSummary> {
  const res = await client.get('/api/v1/dashboard').expect(200);
  return dashboardSummaryResponseSchema.parse(res.body);
}

beforeAll(() => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
});

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

describe('GET /api/v1/dashboard: access', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/api/v1/dashboard').set('Origin', WEB_ORIGIN);
    expect(res.status).toBe(401);
    expect(problemDetailsSchema.parse(res.body).code).toBe('UNAUTHENTICATED');
  });

  it('answers a signed-in owner with the organization scope, never cached', async () => {
    const org = await newOrg('access');
    const res = await org.client.get('/api/v1/dashboard').expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(dashboardSummaryResponseSchema.parse(res.body).scope).toBe('organization');
  });

  it('gives admins the organization and agents only their own tickets', async () => {
    const org = await newOrg('roles');
    const admin = await addMember(db, org.organizationId, 'ADMIN');
    const agent = await addMember(db, org.organizationId, 'AGENT');
    const other = await addMember(db, org.organizationId, 'AGENT', 'other');
    await ticket(org, { assigneeUserId: agent.userId, subject: 'Mine' });
    await ticket(org, { assigneeUserId: other.userId, subject: 'Theirs' });
    await ticket(org, { subject: 'Nobody' });

    const asAdmin = await fetchSummary(await signIn(app, admin.email));
    expect(asAdmin.scope).toBe('organization');
    expect(asAdmin.tickets.active).toBe(3);
    expect(asAdmin.tickets.unassigned).toBe(1);

    // Allow: the agent's own scope. Deny: nothing assigned to anyone else is counted, and
    // no unassigned total or other members appear.
    const asAgent = await fetchSummary(await signIn(app, agent.email));
    expect(asAgent.scope).toBe('own');
    expect(asAgent.tickets.active).toBe(1);
    expect(asAgent.tickets.byStatus.OPEN).toBe(1);
    expect(asAgent.tickets.unassigned).toBeNull();
    expect(asAgent.agents.map((a) => a.userId)).toEqual([agent.userId]);
  });
});

describe('GET /api/v1/dashboard: tenant isolation', () => {
  it("never counts or lists another organization's tickets or members", async () => {
    const a = await newOrg('iso-a');
    const b = await newOrg('iso-b');
    const agentB = await addMember(db, b.organizationId, 'AGENT');
    await ticket(a, { subject: 'A only' });
    for (let i = 0; i < 4; i++) {
      await ticket(b, {
        subject: `Secret B ${i}`,
        assigneeUserId: agentB.userId,
        firstResponseDueAt: at(-MINUTE),
        resolutionDueAt: at(HOUR),
      });
    }

    const summary = await fetchSummary(a.client);
    expect(summary.tickets.active).toBe(1);
    expect(summary.sla.attention).toEqual([]);
    expect(summary.agents.map((m) => m.userId)).toEqual([a.userId]);
    expect(JSON.stringify(summary)).not.toContain('Secret B');
  });

  it('ignores organization hints in the query string and headers', async () => {
    const a = await newOrg('hint-a');
    const b = await newOrg('hint-b');
    await ticket(b, {});
    await ticket(b, {});

    const res = await a.client
      .get(`/api/v1/dashboard?organizationId=${b.organizationId}`)
      .set('X-Organization-Id', b.organizationId)
      .expect(200);
    const summary = dashboardSummaryResponseSchema.parse(res.body);
    expect(summary.tickets.active).toBe(0);
    expect(summary.agents.map((m) => m.userId)).toEqual([a.userId]);
  });
});

describe('dashboard metrics', () => {
  it('describes an empty organization without inventing numbers', async () => {
    const org = await newOrg('empty');
    const summary = await summaryAt(org);

    expect(summary.tickets).toEqual({
      byStatus: { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 },
      active: 0,
      awaitingFirstResponse: 0,
      unassigned: 0,
    });
    expect(Object.values(summary.sla.active)).toEqual(SLA_STATUSES.map(() => 0));
    expect(summary.sla.attention).toEqual([]);
    expect(summary.responseTimes.firstResponse).toEqual({ count: 0, averageSeconds: null });
    expect(summary.responseTimes.resolution).toEqual({ count: 0, averageSeconds: null });
    expect(summary.agents).toEqual([
      expect.objectContaining({ userId: org.userId, role: 'OWNER', active: 0 }),
    ]);
  });

  it('counts every status, and only active ones as active or awaiting a reply', async () => {
    const org = await newOrg('statuses');
    await ticket(org, { status: 'OPEN' });
    await ticket(org, { status: 'OPEN', firstRespondedAt: at(-30 * MINUTE) });
    await ticket(org, { status: 'PENDING' });
    await ticket(org, { status: 'ON_HOLD', firstRespondedAt: at(-30 * MINUTE) });
    await ticket(org, { status: 'SOLVED', solvedAt: at(-MINUTE) });
    await ticket(org, { status: 'CLOSED', solvedAt: at(-DAY), closedAt: at(-MINUTE) });
    await ticket(org, { status: 'CLOSED', solvedAt: at(-DAY), closedAt: at(-MINUTE) });

    const { tickets } = await summaryAt(org);
    expect(tickets.byStatus).toEqual({ OPEN: 2, PENDING: 1, ON_HOLD: 1, SOLVED: 1, CLOSED: 2 });
    expect(tickets.active).toBe(4);
    // Solved and closed tickets without a reply aren't waiting for one.
    expect(tickets.awaitingFirstResponse).toBe(2);
  });

  it('classifies SLA states exactly like evaluateSla, boundaries included', async () => {
    const org = await newOrg('sla');
    const created = at(-HOUR);
    const later = at(10 * HOUR);
    // Each case: what it pins down. Unless stated, resolution is due much later (on track).
    const cases: TicketSetup[] = [
      { firstResponseDueAt: NOW }, // due exactly now: still at risk, not breached
      { firstResponseDueAt: at(-1) }, // 1 ms past due: breached
      { firstResponseDueAt: at(20 * MINUTE) }, // exactly 25 % of the window left: at risk
      { firstResponseDueAt: at(20 * MINUTE + 1) }, // 1 ms more than 25 % left: on track
      { firstResponseDueAt: at(-10 * MINUTE), firstRespondedAt: at(-10 * MINUTE) }, // replied at the due date: met
      { firstResponseDueAt: at(-10 * MINUTE), firstRespondedAt: at(-10 * MINUTE + 1) }, // 1 ms late: breached
      {
        firstResponseDueAt: at(HOUR),
        firstRespondedAt: at(-30 * MINUTE),
        firstResponseBreachedAt: at(-20 * MINUTE),
      }, // a recorded breach stays a breach
      { firstResponseDueAt: null, resolutionDueAt: null }, // no SLA policy: none
      { firstResponseDueAt: at(HOUR), resolutionBreachedAt: at(-MINUTE) }, // recorded resolution breach
      { firstResponseDueAt: at(-HOUR / 2), resolutionDueAt: at(-1) }, // both breached: resolution wins
      {
        firstResponseDueAt: at(-30 * MINUTE),
        firstRespondedAt: at(-40 * MINUTE),
        resolutionDueAt: null,
      }, // met, no resolution target
      { firstResponseDueAt: at(5 * MINUTE), resolutionDueAt: at(10 * MINUTE) }, // both at risk
      { status: 'PENDING', firstResponseDueAt: at(-MINUTE) }, // pending still counts
      { status: 'ON_HOLD', firstResponseDueAt: at(2 * HOUR) }, // on hold, on track
      { createdAt: at(HOUR), firstResponseDueAt: at(2 * HOUR) }, // created "in the future": odd data, no crash
      { status: 'SOLVED', firstResponseDueAt: at(-HOUR / 2), solvedAt: at(-MINUTE) }, // not active: excluded
      { status: 'CLOSED', resolutionDueAt: at(-DAY), solvedAt: at(-2 * DAY), closedAt: at(-DAY) }, // excluded
    ];
    for (const setup of cases) {
      await ticket(org, { createdAt: created, resolutionDueAt: later, ...setup });
    }

    const summary = await summaryAt(org);
    const stored = await db.ticket.findMany({ where: { organizationId: org.organizationId } });
    const active = stored.filter((t) => ACTIVE_TICKET_STATUSES.includes(t.status));
    const expected: Record<string, number> = Object.fromEntries(SLA_STATUSES.map((s) => [s, 0]));
    for (const t of active) {
      const status = evaluateSla(t, NOW).status;
      expected[status] = (expected[status] ?? 0) + 1;
    }

    expect(summary.sla.active).toEqual(expected);
    // The fixture really hits every state.
    expect(Object.values(expected).every((n) => n > 0)).toBe(true);
    // And each listed ticket carries its own evaluateSla state.
    const byNumber = new Map(stored.map((t) => [t.number, t]));
    for (const listed of summary.sla.attention) {
      const storedTicket = byNumber.get(listed.number);
      expect(storedTicket).toBeDefined();
      if (storedTicket) expect(evaluateSla(storedTicket, NOW).status).toBe(listed.status);
    }
  });

  it('lists breaches first (most overdue first), then at-risk tickets, at most five', async () => {
    const org = await newOrg('attention');
    const created = at(-2 * HOUR);
    const late = (minutes: number, subject: string) =>
      ticket(org, {
        subject,
        createdAt: created,
        firstResponseDueAt: at(-minutes * MINUTE),
        resolutionDueAt: at(10 * HOUR),
      });
    const risky = (minutes: number, subject: string) =>
      ticket(org, {
        subject,
        createdAt: created,
        firstResponseDueAt: at(minutes * MINUTE),
        resolutionDueAt: at(10 * HOUR),
      });
    await risky(10, 'risk-10');
    await late(5, 'late-5');
    await risky(2, 'risk-2');
    await late(50, 'late-50');
    await ticket(org, { subject: 'calm', createdAt: created, firstResponseDueAt: at(5 * HOUR) });
    await risky(20, 'risk-20');
    await risky(25, 'risk-25');

    const { attention } = (await summaryAt(org)).sla;
    expect(attention.map((t) => t.subject)).toEqual([
      'late-50',
      'late-5',
      'risk-2',
      'risk-10',
      'risk-20',
    ]);
    expect(attention[0]).toMatchObject({
      status: 'first_response_breached',
      target: 'firstResponse',
      dueAt: at(-50 * MINUTE).toISOString(),
    });
  });

  it('names the target that is due first when both are at risk', async () => {
    const org = await newOrg('target');
    await ticket(org, {
      createdAt: at(-HOUR),
      firstResponseDueAt: at(8 * MINUTE),
      resolutionDueAt: at(5 * MINUTE),
    });

    const [only] = (await summaryAt(org)).sla.attention;
    expect(only).toMatchObject({
      status: 'at_risk',
      target: 'resolution',
      dueAt: at(5 * MINUTE).toISOString(),
    });
  });

  it('averages first-response time over first replies sent in the last 30 days', async () => {
    const org = await newOrg('first-response');
    await ticket(org, { createdAt: at(-10 * HOUR), firstRespondedAt: at(-9 * HOUR) }); // 1 h
    await ticket(org, { createdAt: at(-3 * HOUR), firstRespondedAt: at(-2.5 * HOUR) }); // 30 min
    // Excluded: replied before the window, a reply "in the future", a reply before the
    // ticket was created (invalid data), and no reply at all.
    await ticket(org, { createdAt: at(-40 * DAY), firstRespondedAt: at(-35 * DAY) });
    await ticket(org, { createdAt: at(-HOUR), firstRespondedAt: at(HOUR) });
    await ticket(org, { createdAt: at(-HOUR), firstRespondedAt: at(-2 * HOUR) });
    await ticket(org, { createdAt: at(-HOUR) });

    const { firstResponse } = (await summaryAt(org)).responseTimes;
    expect(firstResponse).toEqual({ count: 2, averageSeconds: 2700 });
  });

  it('averages resolution time over solves in the last 30 days, solved or closed', async () => {
    const org = await newOrg('resolution');
    await ticket(org, { status: 'SOLVED', createdAt: at(-2 * DAY), solvedAt: at(-DAY) }); // 1 day
    await ticket(org, {
      status: 'CLOSED',
      createdAt: at(-5 * DAY),
      solvedAt: at(-3 * DAY),
      closedAt: at(-DAY),
    }); // 2 days
    // Excluded: reopened (solvedAt cleared), solved before the window, solved before created.
    await ticket(org, { status: 'OPEN', createdAt: at(-2 * DAY) });
    await ticket(org, { status: 'SOLVED', createdAt: at(-50 * DAY), solvedAt: at(-40 * DAY) });
    await ticket(org, { status: 'SOLVED', createdAt: at(-HOUR), solvedAt: at(-2 * HOUR) });

    const { resolution } = (await summaryAt(org)).responseTimes;
    expect(resolution).toEqual({ count: 2, averageSeconds: 1.5 * 86_400 });
  });

  it('distributes active tickets by agent, busiest first, keeping idle members', async () => {
    const org = await newOrg('agents');
    const busy = await addMember(db, org.organizationId, 'AGENT', 'Busy');
    const idle = await addMember(db, org.organizationId, 'AGENT', 'Idle');
    const created = at(-HOUR);
    await ticket(org, { assigneeUserId: busy.userId, status: 'OPEN' });
    await ticket(org, { assigneeUserId: busy.userId, status: 'PENDING' });
    await ticket(org, {
      assigneeUserId: busy.userId,
      status: 'ON_HOLD',
      createdAt: created,
      firstResponseDueAt: at(-MINUTE),
    });
    await ticket(org, {
      assigneeUserId: busy.userId,
      createdAt: created,
      firstResponseDueAt: at(5 * MINUTE),
    });
    await ticket(org, { assigneeUserId: busy.userId, status: 'SOLVED', solvedAt: at(-MINUTE) });
    await ticket(org, { assigneeUserId: org.userId });
    await ticket(org, {});

    const summary = await summaryAt(org);
    expect(summary.tickets.unassigned).toBe(1);
    expect(
      summary.agents.map((a) => [
        a.userId,
        a.active,
        a.open,
        a.pending,
        a.onHold,
        a.atRisk,
        a.breached,
      ]),
    ).toEqual([
      [busy.userId, 4, 2, 1, 1, 1, 1],
      [org.userId, 1, 1, 0, 0, 0, 0],
      [idle.userId, 0, 0, 0, 0, 0, 0],
    ]);

    // The busy agent's own view: only their tickets, solved ones in the status counts.
    const own = await summaryAt(org, 'AGENT', busy.userId);
    expect(own.tickets.byStatus).toEqual({ OPEN: 2, PENDING: 1, ON_HOLD: 1, SOLVED: 1, CLOSED: 0 });
    expect(own.sla.active.first_response_breached).toBe(1);
    expect(own.agents.map((a) => a.userId)).toEqual([busy.userId]);
  });
});
