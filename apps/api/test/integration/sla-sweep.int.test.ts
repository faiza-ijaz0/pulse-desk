import { createPrismaClient, type Database, type TicketPriority } from '@pulsedesk/db';
import { ticketDetailResponseSchema } from '@pulsedesk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/logger.ts';
import { createSlaSweepRepository } from '../../src/modules/sla/sla-sweep.repository.ts';
import { createSlaSweepService } from '../../src/modules/sla/sla-sweep.service.ts';
import {
  buildIntegrationApp,
  cleanupTestData,
  createTestDb,
  registerOwner,
  testDatabaseUrl,
  type RegisteredOwner,
} from './helpers.ts';

// The SLA breach sweep against real PostgreSQL: the candidate SQL and its index predicates,
// row locks, the one-breach-per-target unique index, and organization scoping (these test
// clients run with the tenant guard on, so any unscoped model query would throw).
//
// The sweep reads every organization, and the test database may hold other rows (the seed's
// demo tickets, for one). So each test works in its own time window in the past, with a
// clock inside it, and each window is earlier than the previous test's: no other ticket can
// be overdue at a test's clock, and nothing a test leaves behind is due before a later one.

const MINUTE = 60_000;
const silent = createLogger({ level: 'silent', version: 'test' });

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];
let orgA: RegisteredOwner & { customerId: string };
let orgB: RegisteredOwner & { customerId: string };
let nextNumber = 50_000;
let windowIndex = 0;

/** A fresh window: midnight UTC on 1 January of a year that moves back with every call. */
function nextWindow(): (minutes: number) => Date {
  const start = Date.UTC(2015 - windowIndex++, 0, 1);
  return (minutes) => new Date(start + minutes * MINUTE);
}

function sweeper(now: Date, options: { batchSize?: number; maxBatchesPerTarget?: number } = {}) {
  return createSlaSweepService({
    repository: createSlaSweepRepository(db),
    clock: { now: () => now },
    logger: silent,
    batchSize: options.batchSize ?? 100,
    ...(options.maxBatchesPerTarget !== undefined && {
      maxBatchesPerTarget: options.maxBatchesPerTarget,
    }),
  });
}

async function withCustomer(owner: RegisteredOwner) {
  const customer = await db.customer.create({
    data: { organizationId: owner.organizationId, email: `sla-${nextNumber}@example.com` },
  });
  return { ...owner, customerId: customer.id };
}

type TicketSetup = {
  createdAt: Date;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  status?: 'OPEN' | 'PENDING' | 'ON_HOLD' | 'SOLVED' | 'CLOSED';
  priority?: TicketPriority;
  firstRespondedAt?: Date | null;
  solvedAt?: Date | null;
};

async function ticketIn(org: typeof orgA, setup: TicketSetup) {
  return db.ticket.create({
    data: {
      organizationId: org.organizationId,
      number: nextNumber++,
      subject: 'SLA sweep',
      customerId: org.customerId,
      status: setup.status ?? 'OPEN',
      priority: setup.priority ?? 'NORMAL',
      createdAt: setup.createdAt,
      updatedAt: setup.createdAt,
      firstResponseDueAt: setup.firstResponseDueAt,
      resolutionDueAt: setup.resolutionDueAt,
      firstRespondedAt: setup.firstRespondedAt ?? null,
      solvedAt: setup.solvedAt ?? null,
    },
  });
}

function stored(org: typeof orgA, id: string) {
  return db.ticket.findUniqueOrThrow({
    where: { organizationId_id: { organizationId: org.organizationId, id } },
  });
}

function breachEvents(org: typeof orgA, ticketId: string) {
  return db.ticketEvent.findMany({
    where: {
      organizationId: org.organizationId,
      ticketId,
      type: { in: ['SLA_FIRST_RESPONSE_BREACHED', 'SLA_RESOLUTION_BREACHED'] },
    },
    orderBy: { type: 'asc' },
  });
}

beforeAll(async () => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
  orgA = await withCustomer(await registerOwner(app, 'sla-sweep-a'));
  orgB = await withCustomer(await registerOwner(app, 'sla-sweep-b'));
}, 60_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

describe('SLA breach sweep', () => {
  it('records an overdue target once: the marker and a SYSTEM event with the missed due date', async () => {
    const t = nextWindow();
    const ticket = await ticketIn(orgA, {
      createdAt: t(0),
      firstResponseDueAt: t(30),
      resolutionDueAt: t(240),
    });

    const result = await sweeper(t(31)).sweep();
    expect(result).toMatchObject({ checked: 1, skipped: 0, failed: 0 });
    expect(result.recorded).toEqual({ firstResponse: 1, resolution: 0 });

    const after = await stored(orgA, ticket.id);
    expect(after.firstResponseBreachedAt).toEqual(t(31));
    expect(after.resolutionBreachedAt).toBeNull();
    // A breach is not an edit: the "recently updated" order is unchanged.
    expect(after.updatedAt).toEqual(ticket.updatedAt);

    const events = await breachEvents(orgA, ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'SLA_FIRST_RESPONSE_BREACHED',
      actorType: 'SYSTEM',
      actorUserId: null,
      organizationId: orgA.organizationId,
      data: { dueAt: t(30).toISOString() },
      createdAt: t(31),
    });
  });

  it('records exactly one event per target under concurrent and repeated sweeps', async () => {
    const t = nextWindow();
    const tickets = await Promise.all(
      Array.from({ length: 4 }, () =>
        ticketIn(orgA, { createdAt: t(0), firstResponseDueAt: t(30), resolutionDueAt: t(240) }),
      ),
    );

    // Three processes' worth of sweeps at once, then one more after a "restart".
    const concurrent = await Promise.all([1, 2, 3].map(() => sweeper(t(300)).sweep()));
    const again = await sweeper(t(300)).sweep();

    const total = (key: 'firstResponse' | 'resolution') =>
      concurrent.reduce((sum, r) => sum + r.recorded[key], 0);
    expect(total('firstResponse')).toBe(4);
    expect(total('resolution')).toBe(4);
    expect(concurrent.every((r) => r.failed === 0)).toBe(true);
    expect(again.recorded).toEqual({ firstResponse: 0, resolution: 0 });
    expect(again.checked).toBe(0);

    for (const ticket of tickets) {
      expect((await breachEvents(orgA, ticket.id)).map((e) => e.type)).toEqual([
        'SLA_FIRST_RESPONSE_BREACHED',
        'SLA_RESOLUTION_BREACHED',
      ]);
    }
  });

  it('leaves met, not-yet-due, solved-in-time and no-SLA tickets untouched', async () => {
    const t = nextWindow();
    const now = t(300);
    const untouched = await Promise.all([
      // Replied in time; resolution still running.
      ticketIn(orgA, {
        createdAt: t(0),
        firstResponseDueAt: t(30),
        resolutionDueAt: t(1440),
        firstRespondedAt: t(10),
      }),
      // Not due yet.
      ticketIn(orgA, { createdAt: t(0), firstResponseDueAt: t(301), resolutionDueAt: t(2000) }),
      // Due exactly now: still met until one millisecond later.
      ticketIn(orgA, { createdAt: t(0), firstResponseDueAt: now, resolutionDueAt: t(2000) }),
      // Solved in time, both targets met.
      ticketIn(orgA, {
        createdAt: t(0),
        status: 'SOLVED',
        firstResponseDueAt: t(30),
        resolutionDueAt: t(240),
        firstRespondedAt: t(5),
        solvedAt: t(200),
      }),
      // No SLA policy applied.
      ticketIn(orgA, { createdAt: t(0), firstResponseDueAt: null, resolutionDueAt: null }),
    ]);

    const result = await sweeper(now).sweep();
    expect(result.recorded).toEqual({ firstResponse: 0, resolution: 0 });
    for (const ticket of untouched) {
      const after = await stored(orgA, ticket.id);
      expect(after.firstResponseBreachedAt).toBeNull();
      expect(after.resolutionBreachedAt).toBeNull();
      expect(await breachEvents(orgA, ticket.id)).toEqual([]);
    }
  });

  it('records late replies and late solves, which stopped after the due date', async () => {
    const t = nextWindow();
    const lateReply = await ticketIn(orgA, {
      createdAt: t(0),
      firstResponseDueAt: t(30),
      resolutionDueAt: t(1440),
      firstRespondedAt: t(45),
    });
    const lateSolve = await ticketIn(orgA, {
      createdAt: t(0),
      status: 'SOLVED',
      firstResponseDueAt: t(30),
      resolutionDueAt: t(240),
      firstRespondedAt: t(5),
      solvedAt: t(250),
    });

    await sweeper(t(300)).sweep();
    expect((await stored(orgA, lateReply.id)).firstResponseBreachedAt).toEqual(t(300));
    expect((await stored(orgA, lateReply.id)).resolutionBreachedAt).toBeNull();
    expect((await stored(orgA, lateSolve.id)).firstResponseBreachedAt).toBeNull();
    expect((await stored(orgA, lateSolve.id)).resolutionBreachedAt).toEqual(t(300));
  });

  it('writes each breach only inside the ticket’s own organization', async () => {
    const t = nextWindow();
    const inA = await ticketIn(orgA, {
      createdAt: t(0),
      firstResponseDueAt: t(30),
      resolutionDueAt: t(2000),
    });
    const inB = await ticketIn(orgB, {
      createdAt: t(0),
      firstResponseDueAt: t(30),
      resolutionDueAt: t(2000),
    });
    const notDueInB = await ticketIn(orgB, {
      createdAt: t(0),
      firstResponseDueAt: t(500),
      resolutionDueAt: t(2000),
    });

    const result = await sweeper(t(100)).sweep();
    expect(result.recorded.firstResponse).toBe(2);

    const eventsA = await db.ticketEvent.findMany({
      where: { organizationId: orgA.organizationId, ticketId: { in: [inA.id, inB.id] } },
    });
    const eventsB = await db.ticketEvent.findMany({
      where: {
        organizationId: orgB.organizationId,
        ticketId: { in: [inA.id, inB.id, notDueInB.id] },
      },
    });
    expect(eventsA.map((e) => e.ticketId)).toEqual([inA.id]);
    expect(eventsB.map((e) => e.ticketId)).toEqual([inB.id]);
    expect((await stored(orgB, notDueInB.id)).firstResponseBreachedAt).toBeNull();
  });

  it('compares due dates in UTC whatever the database session’s time zone', async () => {
    // The columns hold UTC without a zone. A comparison that depended on the session's
    // TimeZone would be hours off; run the sweep on sessions far east and far west of UTC.
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const t = nextWindow();
      const overdue = await ticketIn(orgA, {
        createdAt: t(0),
        firstResponseDueAt: t(59),
        resolutionDueAt: t(5000),
      });
      const notYet = await ticketIn(orgA, {
        createdAt: t(0),
        firstResponseDueAt: t(61),
        resolutionDueAt: t(5000),
      });

      const url = new URL(testDatabaseUrl());
      url.searchParams.set('options', `-c TimeZone=${zone}`);
      const zoned = createPrismaClient({ connectionString: url.toString(), tenantGuard: true });
      try {
        const settings = await zoned.$queryRaw<{ zone: string }[]>`
          SELECT current_setting('TimeZone') AS zone`;
        expect(settings[0]?.zone).toBe(zone);

        const result = await createSlaSweepService({
          repository: createSlaSweepRepository(zoned),
          clock: { now: () => t(60) },
          logger: silent,
          batchSize: 100,
        }).sweep();
        expect(result.recorded.firstResponse, zone).toBe(1);
      } finally {
        await zoned.$disconnect();
      }
      expect((await stored(orgA, overdue.id)).firstResponseBreachedAt, zone).toEqual(t(60));
      expect((await stored(orgA, notYet.id)).firstResponseBreachedAt, zone).toBeNull();
    }
  });

  it('works in bounded batches and picks up the rest on the next run', async () => {
    const t = nextWindow();
    const tickets: Awaited<ReturnType<typeof ticketIn>>[] = [];
    for (let i = 0; i < 5; i++) {
      // One at a time, so ticket IDs and due dates line up in creation order.
      tickets.push(
        await ticketIn(orgA, {
          createdAt: t(0),
          firstResponseDueAt: t(10 + i),
          resolutionDueAt: t(5000),
        }),
      );
    }

    const first = await sweeper(t(100), { batchSize: 2, maxBatchesPerTarget: 2 }).sweep();
    expect(first).toMatchObject({ checked: 4, truncated: true });
    expect(first.recorded.firstResponse).toBe(4);
    const marked = async () =>
      (await Promise.all(tickets.map((x) => stored(orgA, x.id)))).map(
        (x) => x.firstResponseBreachedAt !== null,
      );
    // Due-date order: the four earliest first.
    expect(await marked()).toEqual([true, true, true, true, false]);

    const second = await sweeper(t(100), { batchSize: 2, maxBatchesPerTarget: 2 }).sweep();
    expect(second).toMatchObject({ checked: 1, truncated: false });
    expect(await marked()).toEqual([true, true, true, true, true]);
  });

  it('skips a ticket another transaction has locked, without waiting, and records it later', async () => {
    const t = nextWindow();
    const ticket = await ticketIn(orgA, {
      createdAt: t(0),
      firstResponseDueAt: t(30),
      resolutionDueAt: t(5000),
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "Ticket"
          WHERE "organizationId" = ${orgA.organizationId}::uuid AND "id" = ${ticket.id}::uuid
          FOR UPDATE`;
        signalLocked();
        await gate;
      },
      { timeout: 20_000 },
    );

    try {
      await locked;
      const whileLocked = await sweeper(t(100)).sweep();
      expect(whileLocked).toMatchObject({ checked: 1, skipped: 1 });
      expect((await stored(orgA, ticket.id)).firstResponseBreachedAt).toBeNull();
    } finally {
      release();
      await holder;
    }

    expect((await sweeper(t(100)).sweep()).recorded.firstResponse).toBe(1);
    expect(await breachEvents(orgA, ticket.id)).toHaveLength(1);
  });

  it('repairs a breach event that lost its marker, without a second event', async () => {
    const t = nextWindow();
    const ticket = await ticketIn(orgA, {
      createdAt: t(0),
      firstResponseDueAt: t(30),
      resolutionDueAt: t(5000),
    });
    await db.ticketEvent.create({
      data: {
        organizationId: orgA.organizationId,
        ticketId: ticket.id,
        actorType: 'SYSTEM',
        type: 'SLA_FIRST_RESPONSE_BREACHED',
        data: { dueAt: t(30).toISOString() },
        createdAt: t(35),
      },
    });

    const result = await sweeper(t(100)).sweep();
    expect(result).toMatchObject({ failed: 0, recorded: { firstResponse: 1, resolution: 0 } });
    expect((await stored(orgA, ticket.id)).firstResponseBreachedAt).toEqual(t(100));
    expect(await breachEvents(orgA, ticket.id)).toHaveLength(1);
  });

  it('keeps a recorded breach through a later priority change, as the API reports it', async () => {
    const t = nextWindow();
    const policy = await db.slaPolicy.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, isDefault: true },
    });
    const ticket = await db.ticket.create({
      data: {
        organizationId: orgA.organizationId,
        number: nextNumber++,
        subject: 'Urgent, missed',
        customerId: orgA.customerId,
        priority: 'URGENT',
        slaPolicyId: policy.id,
        createdAt: t(0),
        firstResponseDueAt: t(30),
        resolutionDueAt: t(240),
      },
    });
    await sweeper(t(31)).sweep();
    const marker = (await stored(orgA, ticket.id)).firstResponseBreachedAt;
    expect(marker).toEqual(t(31));

    const res = await orgA.client
      .patch(`/api/v1/tickets/${ticket.number}`, { priority: 'LOW' })
      .expect(200);
    const { ticket: after, timeline } = ticketDetailResponseSchema.parse(res.body);
    expect(after.firstResponseBreachedAt).toBe(marker!.toISOString());
    expect(after.sla.firstResponse).toBe('breached');
    expect(after.sla.status).toBe('resolution_breached'); // 4 h resolution passed long ago too
    expect(timeline.find((e) => e.type === 'SLA_FIRST_RESPONSE_BREACHED')).toMatchObject({
      actorType: 'SYSTEM',
      actor: null,
      data: { dueAt: t(30).toISOString() },
    });

    // Another sweep doesn't record the same breach again.
    await sweeper(t(31)).sweep();
    expect(
      (await breachEvents(orgA, ticket.id)).filter((e) => e.type === 'SLA_FIRST_RESPONSE_BREACHED'),
    ).toHaveLength(1);
  });
});
