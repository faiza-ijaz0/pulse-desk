import type { Database, TicketStatus } from '@pulsedesk/db';
import {
  organizationSchema,
  problemDetailsSchema,
  ticketDetailResponseSchema,
} from '@pulsedesk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/logger.ts';
import { createAutoCloseRepository } from '../../src/modules/auto-close/auto-close.repository.ts';
import { createAutoCloseService } from '../../src/modules/auto-close/auto-close.service.ts';
import {
  addMember,
  buildIntegrationApp,
  cleanupTestData,
  createTestDb,
  registerOwner,
  signIn,
  type Browser,
  type RegisteredOwner,
} from './helpers.ts';

// Automatic closure against real PostgreSQL: the candidate SQL and its index predicate, each
// organization's own setting, row locks, the transaction that couples the status change with
// its SYSTEM event, and organization scoping (the test clients run with the tenant guard on).
//
// The sweep reads every organization, other suites leave solved tickets behind, and new
// organizations start with auto-close on. So each test works in its own time window in the
// past, with a clock inside it, each earlier than the previous test's: nothing else can be due
// at a test's clock, and nothing a test leaves is due before a later one.

const MINUTE = 60_000;
const silent = createLogger({ level: 'silent', version: 'test' });

type Org = RegisteredOwner & { customerId: string };

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];
let orgA: Org;
let orgB: Org;
let agentA: Browser;
let nextNumber = 60_000;
let windowIndex = 0;

function nextWindow(): (minutes: number) => Date {
  const start = Date.UTC(2015 - windowIndex++, 6, 1);
  return (minutes) => new Date(start + minutes * MINUTE);
}

function sweeper(now: Date, options: { batchSize?: number; maxBatches?: number } = {}) {
  return createAutoCloseService({
    repository: createAutoCloseRepository(db),
    clock: { now: () => now },
    logger: silent,
    batchSize: options.batchSize ?? 100,
    ...(options.maxBatches !== undefined && { maxBatches: options.maxBatches }),
  });
}

async function withCustomer(owner: RegisteredOwner): Promise<Org> {
  const customer = await db.customer.create({
    data: { organizationId: owner.organizationId, email: `close-${nextNumber}@example.com` },
  });
  return { ...owner, customerId: customer.id };
}

function setAutoClose(org: Org, autoCloseEnabled: boolean, autoCloseAfterMinutes = 60) {
  return db.organization.update({
    where: { id: org.organizationId },
    data: { autoCloseEnabled, autoCloseAfterMinutes },
  });
}

async function ticketIn(
  org: Org,
  setup: { status?: TicketStatus; solvedAt: Date | null; updatedAt: Date; closedAt?: Date },
) {
  return db.ticket.create({
    data: {
      organizationId: org.organizationId,
      number: nextNumber++,
      subject: 'Auto-close',
      customerId: org.customerId,
      status: setup.status ?? 'SOLVED',
      solvedAt: setup.solvedAt,
      closedAt: setup.closedAt ?? null,
      createdAt: new Date(setup.updatedAt.getTime() - 120 * MINUTE),
      updatedAt: setup.updatedAt,
    },
  });
}

function stored(org: Org, id: string) {
  return db.ticket.findUniqueOrThrow({
    where: { organizationId_id: { organizationId: org.organizationId, id } },
  });
}

function closeEvents(org: Org, ticketId: string) {
  return db.ticketEvent.findMany({
    where: { organizationId: org.organizationId, ticketId, type: 'STATUS_CHANGED' },
  });
}

beforeAll(async () => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
  orgA = await withCustomer(await registerOwner(app, 'auto-close-a'));
  orgB = await withCustomer(await registerOwner(app, 'auto-close-b'));
  const agent = await addMember(db, orgA.organizationId, 'AGENT', 'auto-close-a-agent');
  agentA = await signIn(app, agent.email);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

describe('auto-close sweep', () => {
  it('closes a due solved ticket with one SYSTEM event, in one transaction', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    const ticket = await ticketIn(orgA, { solvedAt: t(0), updatedAt: t(0) });

    const result = await sweeper(t(60)).sweep();
    expect(result).toMatchObject({ checked: 1, closed: 1, skipped: 0, unchanged: 0, failed: 0 });

    const after = await stored(orgA, ticket.id);
    expect(after).toMatchObject({
      status: 'CLOSED',
      closedAt: t(60),
      updatedAt: t(60),
      solvedAt: t(0),
    });
    const events = await closeEvents(orgA, ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorUserId: null,
      organizationId: orgA.organizationId,
      data: { from: 'SOLVED', to: 'CLOSED' },
      createdAt: t(60),
    });
  });

  it('closes exactly at the deadline, not a minute before', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    const ticket = await ticketIn(orgA, { solvedAt: t(0), updatedAt: t(0) });
    expect((await sweeper(t(59)).sweep()).closed).toBe(0);
    expect((await stored(orgA, ticket.id)).status).toBe('SOLVED');
    expect((await sweeper(t(60)).sweep()).closed).toBe(1);
  });

  it('waits a full delay after the last update when someone worked on the solved ticket', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    // Solved at 0, then a reply or property change at 45: due at 105, not 60.
    const ticket = await ticketIn(orgA, { solvedAt: t(0), updatedAt: t(45) });
    expect((await sweeper(t(100)).sweep()).closed).toBe(0);
    expect((await stored(orgA, ticket.id)).status).toBe('SOLVED');
    expect((await sweeper(t(105)).sweep()).closed).toBe(1);
  });

  it('closes nothing while the organization has auto-close off', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, false, 1);
    const ticket = await ticketIn(orgA, { solvedAt: t(0), updatedAt: t(0) });
    expect((await sweeper(t(10_000)).sweep()).closed).toBe(0);
    expect((await stored(orgA, ticket.id)).status).toBe('SOLVED');
    await setAutoClose(orgA, true, 60);
  });

  it('leaves open, pending, on-hold and already closed tickets alone', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    const untouched = await Promise.all([
      ticketIn(orgA, { status: 'OPEN', solvedAt: null, updatedAt: t(0) }),
      ticketIn(orgA, { status: 'PENDING', solvedAt: null, updatedAt: t(0) }),
      ticketIn(orgA, { status: 'ON_HOLD', solvedAt: null, updatedAt: t(0) }),
      ticketIn(orgA, { status: 'CLOSED', solvedAt: t(0), closedAt: t(10), updatedAt: t(10) }),
    ]);
    expect((await sweeper(t(10_000)).sweep()).closed).toBe(0);
    for (const ticket of untouched) {
      const after = await stored(orgA, ticket.id);
      expect(after.status).toBe(ticket.status);
      expect(after.updatedAt).toEqual(ticket.updatedAt);
      expect(await closeEvents(orgA, ticket.id)).toEqual([]);
    }
  });

  it('closes each ticket exactly once under concurrent and repeated sweeps', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    const tickets = await Promise.all(
      Array.from({ length: 4 }, () => ticketIn(orgA, { solvedAt: t(0), updatedAt: t(0) })),
    );
    const concurrent = await Promise.all([1, 2, 3].map(() => sweeper(t(60)).sweep()));
    const again = await sweeper(t(60)).sweep();

    expect(concurrent.reduce((sum, r) => sum + r.closed, 0)).toBe(4);
    expect(concurrent.every((r) => r.failed === 0)).toBe(true);
    expect(again).toMatchObject({ checked: 0, closed: 0 });
    for (const ticket of tickets) {
      expect((await stored(orgA, ticket.id)).status).toBe('CLOSED');
      expect(await closeEvents(orgA, ticket.id)).toHaveLength(1);
    }
  });

  it('never overrides a reopen that holds the ticket: skips it, then finds it open', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    const ticket = await ticketIn(orgA, { solvedAt: t(0), updatedAt: t(0) });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalReopened!: () => void;
    const reopened = new Promise<void>((resolve) => (signalReopened = resolve));
    // An agent's reopen in flight: the row is locked and already OPEN, but not committed.
    const reopen = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "Ticket"
          WHERE "organizationId" = ${orgA.organizationId}::uuid AND "id" = ${ticket.id}::uuid
          FOR UPDATE`;
        await tx.ticket.update({
          where: { organizationId_id: { organizationId: orgA.organizationId, id: ticket.id } },
          data: { status: 'OPEN', solvedAt: null, updatedAt: t(59) },
        });
        signalReopened();
        await gate;
      },
      { timeout: 20_000 },
    );

    try {
      await reopened;
      // The candidate query still sees the committed SOLVED row; the lock makes it skip.
      expect(await sweeper(t(60)).sweep()).toMatchObject({ checked: 1, skipped: 1, closed: 0 });
    } finally {
      release();
      await reopen;
    }
    expect(await sweeper(t(60)).sweep()).toMatchObject({ checked: 0, closed: 0 });
    expect(await stored(orgA, ticket.id)).toMatchObject({ status: 'OPEN', closedAt: null });
    expect(await closeEvents(orgA, ticket.id)).toEqual([]);
  });

  it('applies each organization’s own setting and writes only inside the ticket’s organization', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    await setAutoClose(orgB, false, 60);
    const inA = await ticketIn(orgA, { solvedAt: t(0), updatedAt: t(0) });
    const inB = await ticketIn(orgB, { solvedAt: t(0), updatedAt: t(0) });

    expect((await sweeper(t(60)).sweep()).closed).toBe(1);
    expect((await stored(orgA, inA.id)).status).toBe('CLOSED');
    expect((await stored(orgB, inB.id)).status).toBe('SOLVED');
    const eventsB = await db.ticketEvent.findMany({
      where: { organizationId: orgB.organizationId, ticketId: { in: [inA.id, inB.id] } },
    });
    expect(eventsB).toEqual([]);
    const eventsA = await db.ticketEvent.findMany({
      where: { organizationId: orgA.organizationId, ticketId: { in: [inA.id, inB.id] } },
    });
    expect(eventsA.map((e) => e.ticketId)).toEqual([inA.id]);

    // With B's own delay (2 h) switched on, its ticket closes at its own time.
    await setAutoClose(orgB, true, 120);
    expect((await sweeper(t(119)).sweep()).closed).toBe(0);
    expect((await sweeper(t(120)).sweep()).closed).toBe(1);
    expect((await stored(orgB, inB.id)).status).toBe('CLOSED');
  });

  it('works in bounded batches and picks up the rest on the next run', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    const tickets: Awaited<ReturnType<typeof ticketIn>>[] = [];
    for (let i = 0; i < 5; i++) {
      tickets.push(await ticketIn(orgA, { solvedAt: t(i), updatedAt: t(i) }));
    }
    const first = await sweeper(t(100), { batchSize: 2, maxBatches: 2 }).sweep();
    expect(first).toMatchObject({ checked: 4, closed: 4, truncated: true });
    const statuses = async () =>
      (await Promise.all(tickets.map((x) => stored(orgA, x.id)))).map((x) => x.status);
    expect(await statuses()).toEqual(['CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'SOLVED']);
    expect(await sweeper(t(100), { batchSize: 2, maxBatches: 2 }).sweep()).toMatchObject({
      checked: 1,
      closed: 1,
      truncated: false,
    });
  });

  it('shows the closure in the timeline, and the closed ticket is read-only', async () => {
    const t = nextWindow();
    await setAutoClose(orgA, true, 60);
    const ticket = await ticketIn(orgA, { solvedAt: t(0), updatedAt: t(0) });
    await sweeper(t(60)).sweep();

    const res = await orgA.client.get(`/api/v1/tickets/${ticket.number}`).expect(200);
    const { ticket: summary, timeline } = ticketDetailResponseSchema.parse(res.body);
    expect(summary).toMatchObject({ status: 'CLOSED', closedAt: t(60).toISOString() });
    expect(timeline.at(-1)).toMatchObject({
      type: 'STATUS_CHANGED',
      actorType: 'SYSTEM',
      actor: null,
      data: { from: 'SOLVED', to: 'CLOSED' },
    });

    const write = await orgA.client.patch(`/api/v1/tickets/${ticket.number}`, { priority: 'HIGH' });
    expect(write.status).toBe(409);
    expect(problemDetailsSchema.parse(write.body).code).toBe('TICKET_CLOSED');
  });
});

describe('auto-close settings API', () => {
  it('lets an owner change the settings, returns them, and audits exactly what changed', async () => {
    await setAutoClose(orgA, true, 5760);
    const res = await orgA.client
      .patch('/api/v1/organization', { autoCloseEnabled: false, autoCloseAfterMinutes: 1440 })
      .expect(200);
    expect(organizationSchema.parse(res.body)).toMatchObject({
      autoCloseEnabled: false,
      autoCloseAfterMinutes: 1440,
    });
    const fetched = organizationSchema.parse(
      (await orgA.client.get('/api/v1/organization').expect(200)).body,
    );
    expect(fetched).toMatchObject({ autoCloseEnabled: false, autoCloseAfterMinutes: 1440 });

    const audit = await db.auditLog.findFirst({
      where: { organizationId: orgA.organizationId, action: 'organization.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toEqual({
      autoCloseEnabled: { from: true, to: false },
      autoCloseAfterMinutes: { from: 5760, to: 1440 },
    });

    // Saving the same values writes and audits nothing.
    const before = await db.auditLog.count({ where: { organizationId: orgA.organizationId } });
    await orgA.client.patch('/api/v1/organization', { autoCloseEnabled: false }).expect(200);
    expect(await db.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(
      before,
    );
  });

  it('refuses agents, out-of-range delays and empty changes', async () => {
    expect((await agentA.patch('/api/v1/organization', { autoCloseEnabled: true })).status).toBe(
      403,
    );
    for (const body of [
      { autoCloseAfterMinutes: 0 },
      { autoCloseAfterMinutes: 525_601 },
      { autoCloseAfterMinutes: 1.5 },
      { autoCloseEnabled: 'yes' },
      {},
    ]) {
      const res = await orgA.client.patch('/api/v1/organization', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe('VALIDATION_FAILED');
    }
  });
});
