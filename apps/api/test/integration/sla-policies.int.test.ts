import type { Database } from '@pulsedesk/db';
import {
  DEFAULT_SLA_TARGETS,
  problemDetailsSchema,
  slaPolicyResponseSchema,
  ticketDetailResponseSchema,
  type UpdateSlaPolicyRequest,
} from '@pulsedesk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  buildIntegrationApp,
  browser,
  cleanupTestData,
  createTestDb,
  registerOwner,
  signIn,
  type Browser,
  type RegisteredOwner,
} from './helpers.ts';

// SLA policy management against real PostgreSQL: the default policy created at sign-up, the
// session-scoped read and full-replacement save, the audit trail (and its absence for no-ops),
// role checks, tenant isolation, the advisory lock that serializes saves, and what a save
// means for tickets (docs/architecture/data-model.md, "SLA policies").

const MINUTE = 60_000;
const PATH = '/api/v1/sla-policy';

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];
let orgA: RegisteredOwner;
let orgB: RegisteredOwner;
let adminA: Browser;
let agentA: Browser;
let customerCounter = 0;
let foreignNumber = 90_000;

/** A complete set of targets: the defaults with the given priorities changed. */
function targets(
  overrides: Partial<UpdateSlaPolicyRequest['targets']> = {},
): UpdateSlaPolicyRequest {
  return { targets: { ...structuredClone(DEFAULT_SLA_TARGETS), ...overrides } };
}

const save = (client: Browser, body: unknown) => client.put(PATH).send(body as object);

async function saveOk(client: Browser, body: unknown) {
  const res = await save(client, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return slaPolicyResponseSchema.parse(res.body).policy!;
}

async function read(client: Browser) {
  const res = await client.get(PATH);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return slaPolicyResponseSchema.parse(res.body).policy;
}

function auditsOf(org: RegisteredOwner) {
  return db.auditLog.findMany({
    where: { organizationId: org.organizationId, action: { startsWith: 'sla_policy.' } },
    orderBy: { createdAt: 'asc' },
  });
}

async function storedTargets(org: RegisteredOwner) {
  const rows = await db.slaTarget.findMany({
    where: { organizationId: org.organizationId },
    select: { priority: true, firstResponseMinutes: true, resolutionMinutes: true },
  });
  return Object.fromEntries(rows.map(({ priority, ...minutes }) => [priority, minutes]));
}

async function createTicket(client: Browser, priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT') {
  customerCounter += 1;
  const res = await client.post('/api/v1/tickets', {
    subject: 'Policy check',
    customer: { email: `sla-policy-${customerCounter}@example.com` },
    message: 'Hello.',
    priority,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ticketDetailResponseSchema.parse(res.body).ticket;
}

async function changePriority(client: Browser, number: number, priority: string) {
  const res = await client.patch(`/api/v1/tickets/${number}`, { priority });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ticketDetailResponseSchema.parse(res.body).ticket;
}

const offset = (from: string, to: string | null) =>
  to === null ? null : (Date.parse(to) - Date.parse(from)) / MINUTE;

/** A fresh organization whose default policy was removed, as for one created before policies. */
async function orgWithoutPolicy(label: string) {
  const org = await registerOwner(app, label);
  await db.slaPolicy.deleteMany({ where: { organizationId: org.organizationId } });
  return org;
}

beforeAll(async () => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
  orgA = await registerOwner(app, 'sla-policy-a');
  orgB = await registerOwner(app, 'sla-policy-b');
  const admin = await addMember(db, orgA.organizationId, 'ADMIN', 'sla-policy-a-admin');
  const agent = await addMember(db, orgA.organizationId, 'AGENT', 'sla-policy-a-agent');
  adminA = await signIn(app, admin.email);
  agentA = await signIn(app, agent.email);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

describe('reading the SLA policy', () => {
  it('returns the default policy created at sign-up to every member', async () => {
    for (const client of [orgB.client, agentA]) {
      const policy = await read(client);
      expect(policy).toMatchObject({ name: 'Standard' });
    }
    expect((await read(orgB.client))?.targets).toEqual(DEFAULT_SLA_TARGETS);
  });

  it('requires a session', async () => {
    const anonymous = browser(app);
    for (const res of [await anonymous.get(PATH), await save(anonymous, targets())]) {
      expect(res.status).toBe(401);
      expect(problemDetailsSchema.parse(res.body).code).toBe('UNAUTHENTICATED');
    }
  });

  it('reports a missing policy and a missing target as null', async () => {
    const org = await orgWithoutPolicy('sla-policy-none-read');
    expect(await read(org.client)).toBeNull();

    const other = await registerOwner(app, 'sla-policy-partial');
    await db.slaTarget.deleteMany({
      where: { organizationId: other.organizationId, priority: 'LOW' },
    });
    expect((await read(other.client))?.targets).toEqual({ ...DEFAULT_SLA_TARGETS, LOW: null });
  });
});

describe('saving the SLA policy', () => {
  it('lets owners and admins replace the targets, with one audit entry of what changed', async () => {
    const before = await db.slaPolicy.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, isDefault: true },
    });
    const policy = await saveOk(
      orgA.client,
      targets({ URGENT: { firstResponseMinutes: 15, resolutionMinutes: 120 } }),
    );
    expect(policy).toMatchObject({ id: before.id, name: 'Standard' });
    expect(policy.targets.URGENT).toEqual({ firstResponseMinutes: 15, resolutionMinutes: 120 });
    expect(Date.parse(policy.updatedAt)).toBeGreaterThan(before.updatedAt.getTime());
    expect(await storedTargets(orgA)).toEqual(policy.targets);

    await saveOk(
      adminA,
      targets({
        URGENT: { firstResponseMinutes: 15, resolutionMinutes: 120 },
        LOW: { firstResponseMinutes: 480, resolutionMinutes: 7 * 24 * 60 },
      }),
    );
    const audits = await auditsOf(orgA);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'sla_policy.updated',
      actorUserId: orgA.userId,
      targetType: 'SlaPolicy',
      targetId: before.id,
      metadata: {
        targets: {
          URGENT: {
            firstResponseMinutes: { from: 30, to: 15 },
            resolutionMinutes: { from: 240, to: 120 },
          },
        },
      },
    });
    expect(audits[0]?.requestId).toEqual(expect.any(String));
    // Only the changed field of the changed priority is recorded.
    expect(audits[1]?.metadata).toEqual({
      targets: { LOW: { resolutionMinutes: { from: 72 * 60, to: 7 * 24 * 60 } } },
    });

    // Restore the defaults for the tests below.
    await saveOk(orgA.client, targets());
  });

  it('writes and audits nothing when nothing changes', async () => {
    const org = await registerOwner(app, 'sla-policy-noop');
    const before = await db.slaPolicy.findFirstOrThrow({
      where: { organizationId: org.organizationId },
    });
    const policy = await saveOk(org.client, targets());
    expect(policy.updatedAt).toBe(before.updatedAt.toISOString());
    expect(await auditsOf(org)).toEqual([]);
  });

  it('refuses agents, and changes nothing', async () => {
    const before = await storedTargets(orgA);
    const auditCount = (await auditsOf(orgA)).length;
    const res = await save(
      agentA,
      targets({ LOW: { firstResponseMinutes: 1, resolutionMinutes: 1 } }),
    );
    expect(res.status).toBe(403);
    expect(problemDetailsSchema.parse(res.body).code).toBe('FORBIDDEN');
    expect(await storedTargets(orgA)).toEqual(before);
    expect(await auditsOf(orgA)).toHaveLength(auditCount);
  });

  it.each([
    [
      'an incomplete policy',
      { targets: { URGENT: DEFAULT_SLA_TARGETS.URGENT } },
      'body.targets.LOW',
    ],
    [
      'an unknown priority',
      { targets: { ...DEFAULT_SLA_TARGETS, CRITICAL: DEFAULT_SLA_TARGETS.URGENT } },
      'body.targets',
    ],
    [
      'resolution before first response',
      targets({ HIGH: { firstResponseMinutes: 60, resolutionMinutes: 59 } }),
      'body.targets.HIGH.resolutionMinutes',
    ],
    [
      'a zero target',
      targets({ NORMAL: { firstResponseMinutes: 0, resolutionMinutes: 60 } }),
      'body.targets.NORMAL.firstResponseMinutes',
    ],
    [
      'a target over a year',
      targets({ LOW: { firstResponseMinutes: 60, resolutionMinutes: 525_601 } }),
      'body.targets.LOW.resolutionMinutes',
    ],
    [
      'fractional minutes',
      targets({ LOW: { firstResponseMinutes: 1.5, resolutionMinutes: 60 } }),
      'body.targets.LOW.firstResponseMinutes',
    ],
    [
      'an organization ID',
      { ...targets(), organizationId: '00000000-0000-0000-0000-000000000000' },
      'body',
    ],
    ['a non-object body', [], 'body'],
  ])('rejects %s with VALIDATION_FAILED and writes nothing', async (_, body, path) => {
    const before = await storedTargets(orgA);
    const auditCount = (await auditsOf(orgA)).length;
    const res = await save(orgA.client, body);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((error) => error.path)).toContain(path);
    expect(await storedTargets(orgA)).toEqual(before);
    expect(await auditsOf(orgA)).toHaveLength(auditCount);
  });

  it('only ever reads and writes the session’s own organization', async () => {
    const bBefore = await storedTargets(orgB);
    const aPolicy = await db.slaPolicy.findFirstOrThrow({
      where: { organizationId: orgA.organizationId },
    });
    await saveOk(
      orgA.client,
      targets({ HIGH: { firstResponseMinutes: 45, resolutionMinutes: 300 } }),
    );
    expect(await storedTargets(orgB)).toEqual(bBefore);
    expect(await auditsOf(orgB)).toEqual([]);
    expect((await read(orgB.client))?.id).not.toBe(aPolicy.id);
    await saveOk(orgA.client, targets());
  });

  it('creates the default policy on the first save of an organization without one', async () => {
    const org = await orgWithoutPolicy('sla-policy-create');
    const custom = targets({ NORMAL: { firstResponseMinutes: 120, resolutionMinutes: 600 } });
    const policy = await saveOk(org.client, custom);
    expect(policy).toMatchObject({ name: 'Standard', targets: custom.targets });
    const stored = await db.slaPolicy.findMany({ where: { organizationId: org.organizationId } });
    expect(stored).toEqual([expect.objectContaining({ id: policy.id, isDefault: true })]);
    const audits = await auditsOf(org);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'sla_policy.created',
        actorUserId: org.userId,
        targetId: policy.id,
        metadata: { name: 'Standard', targets: custom.targets },
      }),
    ]);
  });

  it('fills in a missing target, recording it as changed from null', async () => {
    const org = await registerOwner(app, 'sla-policy-fill');
    await db.slaTarget.deleteMany({
      where: { organizationId: org.organizationId, priority: 'LOW' },
    });
    const policy = await saveOk(org.client, targets());
    expect(policy.targets.LOW).toEqual(DEFAULT_SLA_TARGETS.LOW);
    expect((await auditsOf(org))[0]?.metadata).toEqual({
      targets: {
        LOW: {
          firstResponseMinutes: { from: null, to: DEFAULT_SLA_TARGETS.LOW.firstResponseMinutes },
          resolutionMinutes: { from: null, to: DEFAULT_SLA_TARGETS.LOW.resolutionMinutes },
        },
      },
    });
  });

  it('refuses, and rolls back, when a non-default policy holds the default name', async () => {
    const org = await registerOwner(app, 'sla-policy-clash');
    await db.slaPolicy.updateMany({
      where: { organizationId: org.organizationId },
      data: { isDefault: false },
    });
    const res = await save(org.client, targets());
    expect(res.status).toBe(409);
    expect(problemDetailsSchema.parse(res.body).code).toBe('CONFLICT');
    expect(await db.slaPolicy.count({ where: { organizationId: org.organizationId } })).toBe(1);
    expect(await db.slaTarget.count({ where: { organizationId: org.organizationId } })).toBe(4);
    expect(await auditsOf(org)).toEqual([]);
  });
});

describe('concurrent saves', () => {
  it('create exactly one policy when two first saves race', async () => {
    const org = await orgWithoutPolicy('sla-policy-race-create');
    const second = await signIn(app, org.email);
    const results = await Promise.all([
      save(org.client, targets({ LOW: { firstResponseMinutes: 100, resolutionMinutes: 1000 } })),
      save(second, targets({ LOW: { firstResponseMinutes: 200, resolutionMinutes: 2000 } })),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await db.slaPolicy.count({ where: { organizationId: org.organizationId } })).toBe(1);
    expect(await db.slaTarget.count({ where: { organizationId: org.organizationId } })).toBe(4);
    const audits = await auditsOf(org);
    expect(audits.map((audit) => audit.action)).toEqual([
      'sla_policy.created',
      'sla_policy.updated',
    ]);
    // The later save's "from" is what the earlier one left, and the stored state is its "to".
    const created = audits[0]?.metadata as UpdateSlaPolicyRequest;
    const updated = audits[1]?.metadata as {
      targets: { LOW: { firstResponseMinutes: { from: number; to: number } } };
    };
    expect(updated.targets.LOW.firstResponseMinutes.from).toBe(
      created.targets.LOW.firstResponseMinutes,
    );
    expect((await storedTargets(org)).LOW?.firstResponseMinutes).toBe(
      updated.targets.LOW.firstResponseMinutes.to,
    );
  });

  it('apply in turn, each audit entry continuing from the previous save', async () => {
    const org = await registerOwner(app, 'sla-policy-race-update');
    const clients = [org.client, await signIn(app, org.email), await signIn(app, org.email)];
    const minutes = [10, 20, 25];
    const results = await Promise.all(
      clients.map((client, i) =>
        save(
          client,
          targets({ URGENT: { firstResponseMinutes: minutes[i]!, resolutionMinutes: 240 } }),
        ),
      ),
    );
    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    const chain = (await auditsOf(org)).map(
      (audit) =>
        (
          audit.metadata as {
            targets: { URGENT: { firstResponseMinutes: { from: number; to: number } } };
          }
        ).targets.URGENT.firstResponseMinutes,
    );
    expect(chain).toHaveLength(3);
    expect(chain[0]?.from).toBe(30);
    expect(chain[1]?.from).toBe(chain[0]?.to);
    expect(chain[2]?.from).toBe(chain[1]?.to);
    expect((await storedTargets(org)).URGENT?.firstResponseMinutes).toBe(chain[2]?.to);
  });
});

describe('what a policy change means for tickets', () => {
  it('applies to new tickets only; existing tickets keep their due dates', async () => {
    const org = await registerOwner(app, 'sla-policy-tickets');
    const old = await createTicket(org.client, 'HIGH');
    expect(offset(old.createdAt, old.firstResponseDueAt)).toBe(60);
    expect(offset(old.createdAt, old.resolutionDueAt)).toBe(480);

    await saveOk(
      org.client,
      targets({ HIGH: { firstResponseMinutes: 20, resolutionMinutes: 200 } }),
    );

    const fresh = await createTicket(org.client, 'HIGH');
    expect(offset(fresh.createdAt, fresh.firstResponseDueAt)).toBe(20);
    expect(offset(fresh.createdAt, fresh.resolutionDueAt)).toBe(200);
    const reread = await org.client.get(`/api/v1/tickets/${old.number}`).expect(200);
    const unchanged = ticketDetailResponseSchema.parse(reread.body).ticket;
    expect(unchanged.firstResponseDueAt).toBe(old.firstResponseDueAt);
    expect(unchanged.resolutionDueAt).toBe(old.resolutionDueAt);
  });

  it('uses the current targets when an older ticket’s priority changes', async () => {
    const org = await registerOwner(app, 'sla-policy-priority');
    const ticket = await createTicket(org.client, 'LOW');
    await saveOk(
      org.client,
      targets({ URGENT: { firstResponseMinutes: 600, resolutionMinutes: 6000 } }),
    );

    const changed = await changePriority(org.client, ticket.number, 'URGENT');
    // Recomputed from creation with the policy as it is now, not as it was at creation.
    expect(offset(changed.createdAt, changed.firstResponseDueAt)).toBe(600);
    expect(offset(changed.createdAt, changed.resolutionDueAt)).toBe(6000);
  });

  it('keeps due dates already reached, and recorded breaches, through a priority change', async () => {
    const org = await registerOwner(app, 'sla-policy-breached');
    const policy = await db.slaPolicy.findFirstOrThrow({
      where: { organizationId: org.organizationId },
    });
    const customer = await db.customer.create({
      data: { organizationId: org.organizationId, email: 'breached@example.com' },
    });
    const createdAt = new Date(Date.now() - 10 * 60 * MINUTE);
    const firstResponseDueAt = new Date(createdAt.getTime() + 30 * MINUTE);
    const resolutionDueAt = new Date(createdAt.getTime() + 24 * 60 * MINUTE);
    const number = foreignNumber++;
    await db.ticket.create({
      data: {
        organizationId: org.organizationId,
        number,
        subject: 'Already late',
        customerId: customer.id,
        priority: 'URGENT',
        slaPolicyId: policy.id,
        createdAt,
        firstResponseDueAt,
        resolutionDueAt,
        firstResponseBreachedAt: new Date(firstResponseDueAt.getTime() + MINUTE),
      },
    });
    await saveOk(
      org.client,
      targets({ LOW: { firstResponseMinutes: 2000, resolutionMinutes: 9000 } }),
    );

    const changed = await changePriority(org.client, number, 'LOW');
    // First response was due 9.5 hours ago and stays; resolution is still open and follows LOW.
    expect(changed.firstResponseDueAt).toBe(firstResponseDueAt.toISOString());
    expect(offset(changed.createdAt, changed.resolutionDueAt)).toBe(9000);
    expect(changed.sla.firstResponse).toBe('breached');
  });

  it('gives no due dates without a policy, and due dates once one is saved', async () => {
    const org = await orgWithoutPolicy('sla-policy-no-policy-tickets');
    const before = await createTicket(org.client, 'NORMAL');
    expect(before).toMatchObject({ firstResponseDueAt: null, resolutionDueAt: null });
    expect(before.sla.status).toBe('none');

    await saveOk(org.client, targets());
    const after = await createTicket(org.client, 'NORMAL');
    expect(offset(after.createdAt, after.firstResponseDueAt)).toBe(4 * 60);
    expect(offset(after.createdAt, after.resolutionDueAt)).toBe(24 * 60);

    // The older ticket isn't backfilled, not even by a priority change: it has no policy.
    const changed = await changePriority(org.client, before.number, 'URGENT');
    expect(changed).toMatchObject({ firstResponseDueAt: null, resolutionDueAt: null });
    const stored = await db.ticket.findFirstOrThrow({
      where: { organizationId: org.organizationId, number: before.number },
    });
    expect(stored.slaPolicyId).toBeNull();
  });
});
