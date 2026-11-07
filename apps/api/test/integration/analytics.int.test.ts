import type {
  Database,
  MessageVisibility,
  TicketEventActorType,
  TicketPriority,
  TicketStatus,
} from '@pulsedesk/db';
import {
  analyticsReportResponseSchema,
  problemDetailsSchema,
  type AnalyticsQuery,
  type AnalyticsReport,
  type Role,
} from '@pulsedesk/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsRepository } from '../../src/modules/analytics/analytics.repository.ts';
import { createAnalyticsService } from '../../src/modules/analytics/analytics.service.ts';
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

// Analytics against real PostgreSQL. HTTP tests use the production composition (and the real
// clock) for authentication, validation, scope and tenant isolation. Metric tests call the
// service with a fixed clock, so bucket and SLA boundaries can be hit to the millisecond. The
// test clients run with the tenant guard on, so any unscoped model query would throw.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A Saturday noon (UTC). The default report covers 2030-05-17 … 2030-06-15. */
const NOW = new Date('2030-06-15T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
/** The week before NOW, today included: 2030-06-09 … 2030-06-15 (UTC). */
const WEEK: AnalyticsQuery = { from: '2030-06-09', to: '2030-06-15', tz: 'UTC' };
const DAY_START = (date: string) => new Date(`${date}T00:00:00.000Z`);

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];
let labelIndex = 0;

type Org = RegisteredOwner & { customerId: string; nextNumber: number };

async function newOrg(label: string): Promise<Org> {
  const owner = await registerOwner(app, `stats-${label}-${labelIndex++}`);
  const customer = await db.customer.create({
    data: { organizationId: owner.organizationId, email: `stats-${labelIndex}@example.com` },
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
};

async function ticket(org: Org, setup: TicketSetup = {}) {
  const createdAt = setup.createdAt ?? at(-HOUR);
  return db.ticket.create({
    data: {
      organizationId: org.organizationId,
      number: org.nextNumber++,
      subject: 'Analytics',
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

/** A status change on the timeline, as the API (USER) or a sweep (SYSTEM) writes it. */
async function statusChange(
  org: Org,
  ticketId: string,
  from: TicketStatus,
  to: TicketStatus,
  createdAt: Date,
  actor: { type: TicketEventActorType; userId: string | null } = {
    type: 'USER',
    userId: org.userId,
  },
) {
  await db.ticketEvent.create({
    data: {
      organizationId: org.organizationId,
      ticketId,
      type: 'STATUS_CHANGED',
      actorType: actor.type,
      actorUserId: actor.userId,
      data: { from, to },
      createdAt,
    },
  });
}

async function agentMessage(
  org: Org,
  ticketId: string,
  authorUserId: string,
  createdAt: Date,
  visibility: MessageVisibility = 'PUBLIC',
) {
  await db.message.create({
    data: {
      organizationId: org.organizationId,
      ticketId,
      authorType: 'AGENT',
      authorUserId,
      visibility,
      body: 'Reply',
      createdAt,
    },
  });
}

/** A ticket answered by `authorUserId` at `respondedAt`, as the reply endpoint writes it. */
async function answered(
  org: Org,
  authorUserId: string,
  setup: TicketSetup & { firstRespondedAt: Date },
) {
  const created = await ticket(org, setup);
  await agentMessage(org, created.id, authorUserId, setup.firstRespondedAt);
  return created;
}

async function reportAt(
  org: Org,
  query: AnalyticsQuery = WEEK,
  role: Role = 'OWNER',
  userId = org.userId,
): Promise<AnalyticsReport> {
  const service = createAnalyticsService({
    repository: createAnalyticsRepository(db),
    clock: { now: () => NOW },
  });
  const report = await service.report(
    { organizationId: org.organizationId, userId, role, requestId: 'int-test' },
    query,
  );
  return analyticsReportResponseSchema.parse(report);
}

const bucket = (report: AnalyticsReport, start: string) => {
  const found = report.buckets.find((b) => b.start === start);
  if (!found) throw new Error(`No bucket starting ${start}`);
  return found;
};

beforeAll(() => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
});

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

describe('GET /api/v1/analytics: access and validation', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/api/v1/analytics').set('Origin', WEB_ORIGIN);
    expect(res.status).toBe(401);
    expect(problemDetailsSchema.parse(res.body).code).toBe('UNAUTHENTICATED');
  });

  it('answers an owner with the organization over the last 30 UTC days, never cached', async () => {
    const org = await newOrg('access');
    const res = await org.client.get('/api/v1/analytics').expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    const report = analyticsReportResponseSchema.parse(res.body);
    expect(report.scope).toBe('organization');
    expect(report.range).toMatchObject({ timeZone: 'UTC', granularity: 'day' });
    expect(report.buckets).toHaveLength(30);
  });

  it.each([
    ['an impossible date', '?from=2030-02-30'],
    ['a reversed range', '?from=2026-11-07&to=2026-11-01'],
    ['a range over 366 days', '?from=2024-01-01&to=2026-01-01'],
    ['a date before 2000', '?from=1999-12-31&to=2000-01-02'],
    ['an unknown time zone', '?tz=Mars/Olympus'],
    ['a repeated parameter', '?tz=UTC&tz=Europe/Berlin'],
    ['an organization hint', '?organizationId=6f1c2b7e-0000-4000-8000-000000000000'],
    ['a future end date', '?to=2999-01-01'],
  ])('rejects %s with field errors', async (_label, query) => {
    const org = await newOrg('invalid');
    const res = await org.client.get(`/api/v1/analytics${query}`).expect(400);
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem.code).toBe('VALIDATION_FAILED');
    // Unknown parameters are reported on `query` itself; the rest on `query.<name>`.
    expect(problem.errors?.[0]?.path).toMatch(/^query(\.|$)/);
  });

  it('gives admins the organization and agents only their tickets and actions', async () => {
    const org = await newOrg('roles');
    const admin = await addMember(db, org.organizationId, 'ADMIN');
    const agent = await addMember(db, org.organizationId, 'AGENT');
    const other = await addMember(db, org.organizationId, 'AGENT', 'other');
    const mine = await ticket(org, {
      assigneeUserId: agent.userId,
      createdAt: new Date(Date.now() - HOUR),
    });
    await ticket(org, { assigneeUserId: other.userId, createdAt: new Date(Date.now() - HOUR) });
    await ticket(org, { createdAt: new Date(Date.now() - HOUR) });
    await agentMessage(org, mine.id, other.userId, new Date(Date.now() - MINUTE));

    const asAdmin = analyticsReportResponseSchema.parse(
      (await (await signIn(app, admin.email)).get('/api/v1/analytics').expect(200)).body,
    );
    expect(asAdmin.scope).toBe('organization');
    expect(asAdmin.totals.created).toBe(3);
    expect(asAdmin.agents).toHaveLength(4);

    const asAgent = analyticsReportResponseSchema.parse(
      (await (await signIn(app, agent.email)).get('/api/v1/analytics').expect(200)).body,
    );
    expect(asAgent.scope).toBe('own');
    expect(asAgent.totals.created).toBe(1);
    expect(asAgent.createdByCurrentStatus.OPEN).toBe(1);
    // Only the caller is listed, and someone else's reply on their ticket isn't theirs.
    expect(asAgent.agents.map((a) => [a.userId, a.publicReplies])).toEqual([[agent.userId, 0]]);
  });
});

describe('GET /api/v1/analytics: tenant isolation', () => {
  it("never counts another organization's tickets, events, replies or members", async () => {
    const a = await newOrg('iso-a');
    const b = await newOrg('iso-b');
    const recent = new Date(Date.now() - HOUR);
    const theirs = await ticket(b, {
      status: 'SOLVED',
      createdAt: recent,
      firstRespondedAt: new Date(Date.now() - 30 * MINUTE),
      solvedAt: new Date(Date.now() - 10 * MINUTE),
      firstResponseDueAt: new Date(Date.now() + HOUR),
      resolutionDueAt: new Date(Date.now() + HOUR),
    });
    await agentMessage(b, theirs.id, b.userId, new Date(Date.now() - 30 * MINUTE));
    await statusChange(b, theirs.id, 'OPEN', 'SOLVED', new Date(Date.now() - 10 * MINUTE), {
      type: 'USER',
      userId: b.userId,
    });

    const report = analyticsReportResponseSchema.parse(
      (await a.client.get('/api/v1/analytics').expect(200)).body,
    );
    expect(report.totals).toEqual({ created: 0, solved: 0, reopened: 0 });
    expect(report.responseTimes.firstResponse.count).toBe(0);
    expect(report.responseTimes.resolution.count).toBe(0);
    expect(report.sla.firstResponse).toEqual({ met: 0, breached: 0 });
    expect(report.agents.map((agent) => agent.userId)).toEqual([a.userId]);
    expect(report.agents[0]).toMatchObject({ solved: 0, publicReplies: 0 });

    const own = analyticsReportResponseSchema.parse(
      (await b.client.get('/api/v1/analytics').expect(200)).body,
    );
    expect(own.totals).toMatchObject({ created: 1, solved: 1 });
  });
});

describe('analytics metrics', () => {
  it('describes an empty organization without inventing numbers', async () => {
    const org = await newOrg('empty');
    const report = await reportAt(org);

    expect(report.range).toEqual({
      from: '2030-06-09',
      to: '2030-06-15',
      timeZone: 'UTC',
      granularity: 'day',
      startsAt: '2030-06-09T00:00:00.000Z',
      endsAt: '2030-06-16T00:00:00.000Z',
    });
    expect(report.buckets.map((b) => b.start)).toEqual([
      '2030-06-09',
      '2030-06-10',
      '2030-06-11',
      '2030-06-12',
      '2030-06-13',
      '2030-06-14',
      '2030-06-15',
    ]);
    for (const b of report.buckets) {
      expect(b).toMatchObject({ created: 0, solved: 0, reopened: 0 });
      expect(b.firstResponse).toEqual({ count: 0, averageSeconds: null });
    }
    expect(report.responseTimes.firstResponse).toEqual({
      count: 0,
      averageSeconds: null,
      medianSeconds: null,
    });
    expect(
      report.sla.byPriority.every((p) => p.firstResponse.met + p.resolution.breached === 0),
    ).toBe(true);
    expect(report.agents.map(({ name: _name, ...agent }) => agent)).toEqual([
      {
        userId: org.userId,
        role: 'OWNER',
        solved: 0,
        publicReplies: 0,
        firstResponses: { count: 0, averageSeconds: null },
      },
    ]);
  });

  it('buckets created tickets by local day, start included and end excluded', async () => {
    const org = await newOrg('created');
    await ticket(org, { createdAt: DAY_START('2030-06-09') }); // the first instant: in
    await ticket(org, { createdAt: new Date(DAY_START('2030-06-09').getTime() - 1) }); // out
    await ticket(org, { createdAt: new Date('2030-06-14T23:30:00.000Z') });
    await ticket(org, { createdAt: at(-HOUR), status: 'SOLVED', solvedAt: at(-MINUTE) });

    const utc = await reportAt(org);
    expect(utc.buckets.map((b) => b.created)).toEqual([1, 0, 0, 0, 0, 1, 1]);
    expect(utc.totals.created).toBe(3);
    expect(utc.createdByCurrentStatus).toEqual({
      OPEN: 2,
      PENDING: 0,
      ON_HOLD: 0,
      SOLVED: 1,
      CLOSED: 0,
    });

    // In Berlin (UTC+2 in June) 23:30 UTC on the 14th is already the 15th, and the
    // first instant of the 9th UTC is 02:00 local: still the 9th.
    const berlin = await reportAt(org, { ...WEEK, tz: 'Europe/Berlin' });
    expect(berlin.range.startsAt).toBe('2030-06-08T22:00:00.000Z');
    expect(bucket(berlin, '2030-06-14').created).toBe(0);
    expect(bucket(berlin, '2030-06-15').created).toBe(2);
    // The ticket 1 ms before midnight UTC on the 9th is 01:59 on the 9th in Berlin.
    expect(bucket(berlin, '2030-06-09').created).toBe(2);
  });

  it('counts solves and reopens from the timeline, not from current ticket state', async () => {
    const org = await newOrg('throughput');
    const agent = await addMember(db, org.organizationId, 'AGENT');
    const t = await ticket(org, { createdAt: at(-10 * DAY), status: 'CLOSED' });
    // Solved, reopened, solved again, then closed by the system (not a solve or a reopen).
    await statusChange(org, t.id, 'OPEN', 'SOLVED', at(-3 * DAY));
    await statusChange(org, t.id, 'SOLVED', 'OPEN', at(-2 * DAY));
    await statusChange(org, t.id, 'OPEN', 'SOLVED', at(-2 * DAY + HOUR), {
      type: 'USER',
      userId: agent.userId,
    });
    await statusChange(org, t.id, 'SOLVED', 'CLOSED', at(-HOUR), { type: 'SYSTEM', userId: null });
    // Other changes and a solve before the range don't count.
    await statusChange(org, t.id, 'OPEN', 'PENDING', at(-4 * DAY));
    await statusChange(org, t.id, 'OPEN', 'SOLVED', at(-8 * DAY));

    const report = await reportAt(org);
    expect(report.totals).toEqual({ created: 0, solved: 2, reopened: 1 });
    expect(bucket(report, '2030-06-12')).toMatchObject({ solved: 1, reopened: 0 });
    expect(bucket(report, '2030-06-13')).toMatchObject({ solved: 1, reopened: 1 });
    expect(report.agents.find((a) => a.userId === agent.userId)?.solved).toBe(1);
    expect(report.agents.find((a) => a.userId === org.userId)?.solved).toBe(1);
  });

  it('averages first-response time with a median, skipping invalid and future replies', async () => {
    const org = await newOrg('first-response');
    await ticket(org, { createdAt: at(-10 * HOUR), firstRespondedAt: at(-9 * HOUR) }); // 1 h
    await ticket(org, { createdAt: at(-3 * HOUR), firstRespondedAt: at(-2.5 * HOUR) }); // 30 min
    await ticket(org, { createdAt: at(-2 * DAY - 4 * HOUR), firstRespondedAt: at(-2 * DAY) }); // 4 h
    // Excluded: replied before the range, in the future, before creation, or not at all.
    await ticket(org, { createdAt: at(-40 * DAY), firstRespondedAt: at(-35 * DAY) });
    await ticket(org, { createdAt: at(-HOUR), firstRespondedAt: at(HOUR) });
    await ticket(org, { createdAt: at(-HOUR), firstRespondedAt: at(-2 * HOUR) });
    await ticket(org, { createdAt: at(-HOUR) });

    const { firstResponse } = (await reportAt(org)).responseTimes;
    expect(firstResponse).toEqual({
      count: 3,
      averageSeconds: (5.5 * 3600) / 3,
      medianSeconds: 3600,
    });
    const report = await reportAt(org);
    expect(bucket(report, '2030-06-15').firstResponse).toEqual({ count: 2, averageSeconds: 2700 });
    expect(bucket(report, '2030-06-13').firstResponse).toEqual({
      count: 1,
      averageSeconds: 14_400,
    });
  });

  it('averages resolution time over tickets still solved or closed, by the latest solve', async () => {
    const org = await newOrg('resolution');
    await ticket(org, { status: 'SOLVED', createdAt: at(-2 * DAY), solvedAt: at(-DAY) }); // 1 d
    await ticket(org, {
      status: 'CLOSED',
      createdAt: at(-5 * DAY),
      solvedAt: at(-3 * DAY),
      closedAt: at(-DAY),
    }); // 2 d
    await ticket(org, { status: 'SOLVED', createdAt: at(-5 * DAY), solvedAt: at(-HOUR) }); // ~5 d
    // Excluded: reopened (solvedAt cleared), solved before the range, solved before created.
    await ticket(org, { status: 'OPEN', createdAt: at(-2 * DAY) });
    await ticket(org, { status: 'SOLVED', createdAt: at(-50 * DAY), solvedAt: at(-40 * DAY) });
    await ticket(org, { status: 'SOLVED', createdAt: at(-HOUR), solvedAt: at(-2 * HOUR) });

    const { resolution } = (await reportAt(org)).responseTimes;
    const fiveDays = 5 * 86_400 - 3600;
    expect(resolution.count).toBe(3);
    expect(resolution.averageSeconds).toBeCloseTo((86_400 + 2 * 86_400 + fiveDays) / 3, 6);
    expect(resolution.medianSeconds).toBe(2 * 86_400);
  });

  it('decides SLA outcomes like evaluateSla, dated when they were decided', async () => {
    const org = await newOrg('sla');
    const created = at(-2 * DAY);
    const due = at(-2 * DAY + HOUR);
    // First response: met at the due date exactly; late without a recorded breach; recorded
    // breach (a later reply doesn't undo it); still running; no SLA; breach before the range.
    await ticket(org, {
      priority: 'HIGH',
      createdAt: created,
      firstResponseDueAt: due,
      firstRespondedAt: due,
    });
    await ticket(org, {
      priority: 'HIGH',
      createdAt: created,
      firstResponseDueAt: due,
      firstRespondedAt: new Date(due.getTime() + 1),
    });
    await ticket(org, {
      priority: 'URGENT',
      createdAt: created,
      firstResponseDueAt: due,
      firstResponseBreachedAt: new Date(due.getTime() + MINUTE),
      firstRespondedAt: at(-DAY),
    });
    await ticket(org, { createdAt: at(-HOUR), firstResponseDueAt: at(HOUR) });
    await ticket(org, { createdAt: created, firstRespondedAt: due });
    await ticket(org, {
      createdAt: at(-20 * DAY),
      firstResponseDueAt: at(-20 * DAY + HOUR),
      firstResponseBreachedAt: at(-20 * DAY + 2 * HOUR),
    });
    // Resolution: solved in time; closed without solvedAt, late; recorded breach; reopened
    // after a solve (running again: no outcome).
    await ticket(org, {
      status: 'SOLVED',
      priority: 'LOW',
      createdAt: created,
      resolutionDueAt: at(-DAY),
      solvedAt: at(-DAY - HOUR),
    });
    await ticket(org, {
      status: 'CLOSED',
      priority: 'LOW',
      createdAt: created,
      resolutionDueAt: at(-DAY),
      closedAt: at(-HOUR),
    });
    await ticket(org, {
      priority: 'URGENT',
      createdAt: created,
      resolutionDueAt: at(-DAY),
      resolutionBreachedAt: at(-DAY + MINUTE),
    });
    await ticket(org, { status: 'OPEN', createdAt: created, resolutionDueAt: at(DAY) });

    const report = await reportAt(org);
    expect(report.sla.firstResponse).toEqual({ met: 1, breached: 2 });
    expect(report.sla.resolution).toEqual({ met: 1, breached: 2 });
    const byPriority = Object.fromEntries(report.sla.byPriority.map((p) => [p.priority, p]));
    expect(byPriority.HIGH?.firstResponse).toEqual({ met: 1, breached: 1 });
    expect(byPriority.URGENT).toMatchObject({
      firstResponse: { met: 0, breached: 1 },
      resolution: { met: 0, breached: 1 },
    });
    expect(byPriority.LOW?.resolution).toEqual({ met: 1, breached: 1 });
    expect(byPriority.NORMAL).toMatchObject({
      firstResponse: { met: 0, breached: 0 },
      resolution: { met: 0, breached: 0 },
    });
    // Breaches by the day they were decided: both first-response breaches on the 13th, the
    // resolution breaches on the 14th (recorded) and the 15th (closed late).
    expect(bucket(report, '2030-06-13').firstResponseBreaches).toBe(2);
    expect(bucket(report, '2030-06-14').resolutionBreaches).toBe(1);
    expect(bucket(report, '2030-06-15').resolutionBreaches).toBe(1);
  });

  it('credits activity to the member who acted, including on tickets assigned to others', async () => {
    const org = await newOrg('agents');
    const busy = await addMember(db, org.organizationId, 'AGENT', 'Busy');
    const idle = await addMember(db, org.organizationId, 'AGENT', 'Idle');
    // Busy answers first on two tickets (1 h and 3 h), one of them assigned to the owner.
    const first = await answered(org, busy.userId, {
      assigneeUserId: busy.userId,
      createdAt: at(-5 * HOUR),
      firstRespondedAt: at(-4 * HOUR),
    });
    await answered(org, busy.userId, {
      assigneeUserId: org.userId,
      createdAt: at(-6 * HOUR),
      firstRespondedAt: at(-3 * HOUR),
    });
    // The owner replies later on Busy's ticket: a public reply, not a first response.
    await agentMessage(org, first.id, org.userId, at(-2 * HOUR));
    await agentMessage(org, first.id, busy.userId, at(-90 * MINUTE), 'INTERNAL');
    await statusChange(org, first.id, 'OPEN', 'SOLVED', at(-HOUR), {
      type: 'USER',
      userId: busy.userId,
    });

    const report = await reportAt(org);
    expect(
      report.agents.map((a) => [a.userId, a.solved, a.publicReplies, a.firstResponses]),
    ).toEqual([
      [busy.userId, 1, 2, { count: 2, averageSeconds: 2 * 3600 }],
      [org.userId, 0, 1, { count: 0, averageSeconds: null }],
      [idle.userId, 0, 0, { count: 0, averageSeconds: null }],
    ]);

    // Busy's own view: tickets assigned to them; their actions wherever they acted.
    const own = await reportAt(org, WEEK, 'AGENT', busy.userId);
    expect(own.scope).toBe('own');
    expect(own.totals.created).toBe(1);
    expect(own.responseTimes.firstResponse.count).toBe(1);
    expect(own.agents).toEqual([
      expect.objectContaining({
        userId: busy.userId,
        solved: 1,
        publicReplies: 2,
        firstResponses: { count: 2, averageSeconds: 2 * 3600 },
      }),
    ]);
  });

  it('uses 7-day buckets for long ranges, the last one ending on `to`', async () => {
    const org = await newOrg('weekly');
    await ticket(org, { createdAt: at(-HOUR) });
    await ticket(org, { createdAt: new Date('2030-03-01T12:00:00.000Z') });

    const report = await reportAt(org, { from: '2030-03-01', to: '2030-06-15', tz: 'UTC' });
    expect(report.range.granularity).toBe('week');
    expect(report.buckets).toHaveLength(16); // 107 days
    expect(report.buckets[0]).toMatchObject({ start: '2030-03-01', end: '2030-03-07', created: 1 });
    expect(report.buckets.at(-1)).toMatchObject({
      start: '2030-06-14',
      end: '2030-06-15',
      created: 1,
    });
    expect(report.totals.created).toBe(2);
  });

  it('defaults to the last 30 days and refuses a range that ends after today', async () => {
    const org = await newOrg('defaults');
    const report = await reportAt(org, {});
    expect(report.range).toMatchObject({ from: '2030-05-17', to: '2030-06-15', timeZone: 'UTC' });

    // Noon UTC on the 15th is already the 16th in Kiritimati (UTC+14): that's "today" there.
    const ahead = await reportAt(org, { to: '2030-06-16', tz: 'Pacific/Kiritimati' });
    expect(ahead.range.to).toBe('2030-06-16');
    await expect(reportAt(org, { to: '2030-06-16', tz: 'UTC' })).rejects.toMatchObject({
      status: 400,
      fieldErrors: [{ path: 'query.to', message: 'Must not be after today (2030-06-15 in UTC)' }],
    });
    // A `from` after the default `to` (today) is reversed.
    await expect(reportAt(org, { from: '2030-06-20' })).rejects.toMatchObject({ status: 400 });
  });
});
