import type { Database } from '@pulsedesk/db';
import { tagSchema, teamSchema } from '@pulsedesk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/http/auth-context.ts';
import { ValidationError } from '../../src/http/errors.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { createCustomersRepository } from '../../src/modules/customers/customers.repository.ts';
import { createCustomersService } from '../../src/modules/customers/customers.service.ts';
import { createMembersRepository } from '../../src/modules/members/members.repository.ts';
import { createMembersService } from '../../src/modules/members/members.service.ts';
import { createOrganizationsRepository } from '../../src/modules/organizations/organizations.repository.ts';
import { createOrganizationsService } from '../../src/modules/organizations/organizations.service.ts';
import { TagNameTakenError, createTagsRepository } from '../../src/modules/tags/tags.repository.ts';
import { createTagsService } from '../../src/modules/tags/tags.service.ts';
import {
  TeamNameTakenError,
  createTeamsRepository,
} from '../../src/modules/teams/teams.repository.ts';
import { createTeamsService } from '../../src/modules/teams/teams.service.ts';
import { createTicketsRepository } from '../../src/modules/tickets/tickets.repository.ts';
import { createTicketsService } from '../../src/modules/tickets/tickets.service.ts';
import { captureLogs } from '../helpers.ts';
import {
  addMember,
  buildIntegrationApp,
  cleanupTestData,
  createTestDb,
  registerOwner,
  type RegisteredOwner,
} from './helpers.ts';

// Each scenario pauses one operation inside its transaction at a known point, starts the
// competing operation, waits until that one is either blocked on a database lock or done
// (observed through pg_stat_activity — no fixed sleeps), then releases the first. Final
// persisted state and activity history are asserted after every scenario.

let db: Database;
let org: RegisteredOwner;
let adminId: string;
let agentId: string;
let customerId: string;
let nextNumber = 0;

const clock = { now: () => new Date() };
const logger = createLogger({
  level: 'silent',
  version: 'test',
  destination: captureLogs().stream,
});
const meta = { requestId: 'concurrency-test', ipAddress: undefined, userAgent: undefined };

const as = (userId: string, role: TenantContext['role']): TenantContext => ({
  organizationId: org.organizationId,
  userId,
  role,
  requestId: 'concurrency-test',
});

/** A one-shot gate: `reached` resolves when the paused code arrives, `release` lets it go. */
function gate() {
  let arrive: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (open = resolve));
  let used = false;
  return {
    reached,
    release: () => open(),
    /** Called by the paused code; pauses only the first time (not on a retry). */
    async pass() {
      if (used) return;
      used = true;
      arrive();
      await released;
    },
  };
}

/** Wraps `object` so the first call of `method` completes, then waits at `g`. */
function pauseAfter<T extends object>(object: T, method: keyof T, g: ReturnType<typeof gate>): T {
  const original = object[method];
  if (typeof original !== 'function') throw new Error(`${String(method)} is not a method`);
  return {
    ...object,
    [method]: async (...args: unknown[]) => {
      const result: unknown = await (original as (...a: unknown[]) => Promise<unknown>).apply(
        object,
        args,
      );
      await g.pass();
      return result;
    },
  };
}

/** Resolves once some session in this database is waiting for a lock. */
async function someoneWaitsForALock(timeoutMs = 10_000): Promise<'waiting'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) > 0) return 'waiting';
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('No session started waiting for a lock');
}

/** Whichever comes first: `operation` settles, or it is seen blocked on a lock. */
async function finishedOrBlocked(operation: Promise<unknown>): Promise<'finished' | 'waiting'> {
  return Promise.race([
    operation.then(
      () => 'finished' as const,
      () => 'finished' as const,
    ),
    someoneWaitsForALock(),
  ]);
}

function ticketsService(repository = createTicketsRepository(db)) {
  return createTicketsService({ repository, logger, clock });
}

/** The tickets service with its transaction paused after reference validation. */
function ticketsPausedAfterValidation(g: ReturnType<typeof gate>) {
  const repository = createTicketsRepository(db);
  return ticketsService({
    ...repository,
    write: (organizationId, fn) =>
      repository.write(organizationId, (scope) => fn(pauseAfter(scope, 'existingReferences', g))),
  });
}

/** Team/tag services whose transaction pauses right after loading (and locking) the row. */
function teamsPausedAfterFind(g: ReturnType<typeof gate>) {
  const repository = createTeamsRepository(db);
  return createTeamsService({
    clock,
    repository: {
      ...repository,
      serialized: (organizationId, audit, fn) =>
        repository.serialized(organizationId, audit, (scope) => fn(pauseAfter(scope, 'find', g))),
    },
  });
}

function tagsPausedAfterFind(g: ReturnType<typeof gate>) {
  const repository = createTagsRepository(db);
  return createTagsService({
    clock,
    repository: {
      ...repository,
      serialized: (organizationId, audit, fn) =>
        repository.serialized(organizationId, audit, (scope) => fn(pauseAfter(scope, 'find', g))),
    },
  });
}

async function newTicket(teamId: string | null = null) {
  nextNumber += 1;
  await db.organization.update({
    where: { id: org.organizationId },
    data: { ticketSequence: nextNumber },
  });
  return db.ticket.create({
    data: {
      organizationId: org.organizationId,
      number: nextNumber,
      subject: `Concurrency ${nextNumber}`,
      customerId,
      teamId,
    },
  });
}

async function stored(ticketId: string) {
  return db.ticket.findFirstOrThrow({
    where: { id: ticketId, organizationId: org.organizationId },
    include: {
      tags: true,
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
}

const eventsOf = (ticket: Awaited<ReturnType<typeof stored>>) =>
  ticket.events.map((e) => [e.type, e.data, e.actorUserId]);

async function newTeam(name: string) {
  return teamSchema.parse(
    await createTeamsService({ repository: createTeamsRepository(db), clock }).create(
      as(org.userId, 'OWNER'),
      name,
      meta,
    ),
  );
}

async function newTag(name: string) {
  return tagSchema.parse(
    await createTagsService({ repository: createTagsRepository(db), clock }).create(
      as(org.userId, 'OWNER'),
      { name, color: null },
      meta,
    ),
  );
}

beforeAll(async () => {
  db = createTestDb();
  const { app } = buildIntegrationApp(db);
  org = await registerOwner(app, 'concurrency');
  adminId = (await addMember(db, org.organizationId, 'ADMIN', 'concurrency-admin')).userId;
  agentId = (await addMember(db, org.organizationId, 'AGENT', 'concurrency-agent')).userId;
  customerId = (
    await db.customer.create({
      data: { organizationId: org.organizationId, email: 'race@example.com' },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

describe('team deletion racing a ticket assignment', () => {
  it('assignment first: the delete waits, then unassigns the ticket and records both moves', async () => {
    const team = await newTeam('Race team A');
    const ticket = await newTicket();
    const g = gate();
    const assign = ticketsPausedAfterValidation(g).update(as(agentId, 'AGENT'), ticket.number, {
      teamId: team.id,
    });
    await g.reached;

    const del = createTeamsService({ repository: createTeamsRepository(db), clock }).remove(
      as(adminId, 'ADMIN'),
      team.id,
      meta,
    );
    expect(await finishedOrBlocked(del)).toBe('waiting');
    g.release();

    // The response is the ticket re-read after commit, which the waiting delete may already
    // have changed, so the history below (not the response) shows the assignment landed.
    await expect(assign).resolves.toBeDefined();
    await expect(del).resolves.toBeUndefined();

    const after = await stored(ticket.id);
    expect(after.teamId).toBeNull();
    expect(eventsOf(after)).toEqual([
      ['TEAM_CHANGED', { fromTeamId: null, toTeamId: team.id }, agentId],
      ['TEAM_CHANGED', { fromTeamId: team.id, toTeamId: null }, adminId],
    ]);
    expect(
      await db.team.count({ where: { organizationId: org.organizationId, id: team.id } }),
    ).toBe(0);
  });

  it('delete first: the assignment waits, then fails validation like a missing team', async () => {
    const team = await newTeam('Race team B');
    const ticket = await newTicket();
    const g = gate();
    const del = teamsPausedAfterFind(g).remove(as(adminId, 'ADMIN'), team.id, meta);
    await g.reached;

    const assign = ticketsService().update(as(agentId, 'AGENT'), ticket.number, {
      teamId: team.id,
    });
    expect(await finishedOrBlocked(assign)).toBe('waiting');
    g.release();

    await expect(del).resolves.toBeUndefined();
    const error: unknown = await assign.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fieldErrors?.map((e) => e.path)).toEqual(['body.teamId']);

    const after = await stored(ticket.id);
    expect(after.teamId).toBeNull();
    expect(after.events).toEqual([]);
  });

  it('a ticket created into the team while it is deleted ends up unassigned, with history', async () => {
    const team = await newTeam('Race team C');
    const g = gate();
    const create = ticketsPausedAfterValidation(g).create(as(agentId, 'AGENT'), {
      subject: 'Created during delete',
      customer: { email: 'race@example.com' },
      message: 'Hello',
      priority: 'NORMAL',
      channel: 'WEB',
      teamId: team.id,
      tagIds: [],
    });
    await g.reached;

    const del = createTeamsService({ repository: createTeamsRepository(db), clock }).remove(
      as(adminId, 'ADMIN'),
      team.id,
      meta,
    );
    expect(await finishedOrBlocked(del)).toBe('waiting');
    g.release();

    const created = await create;
    nextNumber = created.ticket.number;
    await expect(del).resolves.toBeUndefined();
    const after = await stored(created.ticket.id);
    expect(after.teamId).toBeNull();
    expect(eventsOf(after).map(([type, data]) => [type, data])).toEqual([
      ['CREATED', {}],
      ['TEAM_CHANGED', { fromTeamId: team.id, toTeamId: null }],
    ]);
  });
});

describe('tag deletion racing a tag assignment', () => {
  it('assignment first: the delete waits, then removes the tag and records the removal', async () => {
    const tag = await newTag('race-tag-a');
    const ticket = await newTicket();
    const g = gate();
    const assign = ticketsPausedAfterValidation(g).update(as(agentId, 'AGENT'), ticket.number, {
      tagIds: [tag.id],
    });
    await g.reached;

    const del = createTagsService({ repository: createTagsRepository(db), clock }).remove(
      as(adminId, 'ADMIN'),
      tag.id,
      meta,
    );
    expect(await finishedOrBlocked(del)).toBe('waiting');
    g.release();

    await expect(assign).resolves.toBeDefined();
    await expect(del).resolves.toBeUndefined();

    const after = await stored(ticket.id);
    expect(after.tags).toEqual([]);
    // Every link that disappeared has a matching removal event: history stays consistent.
    expect(eventsOf(after)).toEqual([
      ['TAGS_CHANGED', { addedTagIds: [tag.id], removedTagIds: [] }, agentId],
      ['TAGS_CHANGED', { addedTagIds: [], removedTagIds: [tag.id] }, adminId],
    ]);
  });

  it('delete first: the assignment waits, then fails validation like a missing tag', async () => {
    const tag = await newTag('race-tag-b');
    const keep = await newTag('race-tag-keep');
    const ticket = await newTicket();
    const g = gate();
    const del = tagsPausedAfterFind(g).remove(as(adminId, 'ADMIN'), tag.id, meta);
    await g.reached;

    const assign = ticketsService().update(as(agentId, 'AGENT'), ticket.number, {
      tagIds: [keep.id, tag.id],
    });
    expect(await finishedOrBlocked(assign)).toBe('waiting');
    g.release();

    await expect(del).resolves.toBeUndefined();
    const error: unknown = await assign.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);

    const after = await stored(ticket.id);
    expect(after.tags).toEqual([]);
    expect(after.events).toEqual([]);
  });
});

describe('member removal racing a ticket assignment', () => {
  function membersPausedAfterLock(g: ReturnType<typeof gate>) {
    const repository = createMembersRepository(db);
    return createMembersService({
      repository: {
        ...repository,
        withMemberLock: (organizationId, target, fn) =>
          repository.withMemberLock(organizationId, target, (scope) =>
            fn(pauseAfter(scope, 'find', g)),
          ),
      },
    });
  }

  it('assignment first: the removal waits, then unassigns the ticket', async () => {
    const member = await addMember(db, org.organizationId, 'AGENT', 'race-member-a');
    const ticket = await newTicket();
    const g = gate();
    const assign = ticketsPausedAfterValidation(g).update(as(agentId, 'AGENT'), ticket.number, {
      assigneeUserId: member.userId,
    });
    await g.reached;

    const removal = createMembersService({ repository: createMembersRepository(db) }).remove(
      as(org.userId, 'OWNER'),
      member.userId,
      meta,
    );
    expect(await finishedOrBlocked(removal)).toBe('waiting');
    g.release();

    await expect(assign).resolves.toBeDefined();
    await expect(removal).resolves.toBeUndefined();
    const after = await stored(ticket.id);
    expect(after.assigneeUserId).toBeNull();
    // The assignment committed before the removal unassigned it, and both are on record.
    expect(eventsOf(after)).toEqual([
      ['ASSIGNED', { fromUserId: null, toUserId: member.userId }, agentId],
      ['ASSIGNED', { fromUserId: member.userId, toUserId: null }, org.userId],
    ]);
  });

  it('removal first: the assignment waits, then fails validation like a missing member', async () => {
    const member = await addMember(db, org.organizationId, 'AGENT', 'race-member-b');
    const ticket = await newTicket();
    const g = gate();
    const removal = membersPausedAfterLock(g).remove(as(org.userId, 'OWNER'), member.userId, meta);
    await g.reached;

    const assign = ticketsService().update(as(agentId, 'AGENT'), ticket.number, {
      assigneeUserId: member.userId,
    });
    expect(await finishedOrBlocked(assign)).toBe('waiting');
    g.release();

    await expect(removal).resolves.toBeUndefined();
    const error: unknown = await assign.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    const after = await stored(ticket.id);
    expect(after.assigneeUserId).toBeNull();
    expect(after.events).toEqual([]);
  });
});

describe('case-insensitive name uniqueness under concurrency', () => {
  it('lets exactly one of two coordinated creates win, regardless of case', async () => {
    const tags = createTagsService({ repository: createTagsRepository(db), clock });
    const g = gate();
    const repository = createTagsRepository(db);
    const paused = createTagsService({
      clock,
      repository: {
        ...repository,
        serialized: (organizationId, audit, fn) =>
          repository.serialized(organizationId, audit, (scope) =>
            fn(pauseAfter(scope, 'assertNameFree', g)),
          ),
      },
    });
    const first = paused.create(as(adminId, 'ADMIN'), { name: 'Priority', color: null }, meta);
    await g.reached;
    // Without serialization, this would also pass the name check and insert "PRIORITY".
    const second = tags.create(as(org.userId, 'OWNER'), { name: 'PRIORITY', color: null }, meta);
    expect(await finishedOrBlocked(second)).toBe('waiting');
    g.release();

    await expect(first).resolves.toMatchObject({ name: 'Priority' });
    await expect(second).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    const names = await db.tag.findMany({
      where: {
        organizationId: org.organizationId,
        name: { equals: 'priority', mode: 'insensitive' },
      },
    });
    expect(names.map((t) => t.name)).toEqual(['Priority']);
  });

  it('keeps one team per name under a burst of mixed-case creates', async () => {
    const teams = createTeamsService({ repository: createTeamsRepository(db), clock });
    const results = await Promise.allSettled(
      ['Escalate', 'ESCALATE', 'escalate', 'EsCaLaTe', 'Escalate'].map((name) =>
        teams.create(as(adminId, 'ADMIN'), name, meta),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect(r.reason).toMatchObject({ status: 409, code: 'CONFLICT' });
    }
    expect(
      await db.team.count({
        where: {
          organizationId: org.organizationId,
          name: { equals: 'escalate', mode: 'insensitive' },
        },
      }),
    ).toBe(1);
  });
});

describe('no-op updates', () => {
  async function auditCount(action: string, targetId: string) {
    return db.auditLog.count({ where: { organizationId: org.organizationId, action, targetId } });
  }

  it('write no audit entry when nothing changes', async () => {
    const owner = as(org.userId, 'OWNER');
    const customer = await db.customer.create({
      data: { organizationId: org.organizationId, email: 'noop@example.com', name: 'Noop' },
    });
    const customers = createCustomersService({ repository: createCustomersRepository(db) });
    await customers.update(owner, customer.id, { name: 'Noop', email: 'noop@example.com' }, meta);
    expect(await auditCount('customer.updated', customer.id)).toBe(0);
    await customers.update(owner, customer.id, { name: 'Changed' }, meta);
    expect(await auditCount('customer.updated', customer.id)).toBe(1);

    const tag = await newTag('noop-tag');
    const tags = createTagsService({ repository: createTagsRepository(db), clock });
    await tags.update(owner, tag.id, { name: 'noop-tag', color: null }, meta);
    expect(await auditCount('tag.updated', tag.id)).toBe(0);
    const organizations = createOrganizationsService({
      repository: createOrganizationsRepository(db),
    });
    const current = await organizations.getCurrent(owner);
    await organizations.update(owner, { name: current.name }, meta);
    expect(await auditCount('organization.updated', org.organizationId)).toBe(0);
  });
});

describe('audit trails under concurrent edits', () => {
  /**
   * The entries must form one unbroken chain from `start`: each "from" is the value an
   * earlier edit left, and no two edits started from the same value (which is what a stale,
   * unlocked read produces). Order-independent: createdAt is each transaction's start time.
   */
  function expectUnbrokenChain(entries: { metadata: unknown }[], start: string) {
    const steps = entries.map((e) => (e.metadata as { name: { from: string; to: string } }).name);
    expect(new Set(steps.map((step) => step.from)).size, 'distinct "from" values').toBe(
      steps.length,
    );
    const next = new Map(steps.map((step) => [step.from, step.to]));
    let current = start;
    for (let i = 0; i < steps.length; i++) {
      const to = next.get(current);
      expect(to, `step ${i} from ${current}`).toBeDefined();
      current = to!;
    }
  }

  it('keeps the customer audit chain consistent', async () => {
    const owner = as(org.userId, 'OWNER');
    const customer = await db.customer.create({
      data: { organizationId: org.organizationId, email: 'chain@example.com', name: 'Start' },
    });
    const customers = createCustomersService({ repository: createCustomersRepository(db) });
    await Promise.all(
      ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((name) =>
        customers.update(owner, customer.id, { name }, meta),
      ),
    );
    const entries = await db.auditLog.findMany({
      where: {
        organizationId: org.organizationId,
        action: 'customer.updated',
        targetId: customer.id,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(entries).toHaveLength(6);
    expectUnbrokenChain(entries, 'Start');
  });

  it('keeps the organization rename chain consistent', async () => {
    const owner = as(org.userId, 'OWNER');
    const organizations = createOrganizationsService({
      repository: createOrganizationsRepository(db),
    });
    const { name: start } = await organizations.getCurrent(owner);
    await Promise.all(
      ['Chain A', 'Chain B', 'Chain C', 'Chain D', 'Chain E'].map((name) =>
        organizations.update(owner, { name }, meta),
      ),
    );
    const entries = await db.auditLog.findMany({
      where: { organizationId: org.organizationId, action: 'organization.updated' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(entries).toHaveLength(5);
    expectUnbrokenChain(entries, start);
  });
});

describe('database-level name uniqueness backs the API check', () => {
  const audit = { actorUserId: '', ipAddress: undefined, requestId: 'concurrency-test' };

  it('maps a case-insensitive index violation to "name taken" for teams and tags', async () => {
    await newTeam('Backstop Team');
    await newTag('backstop-tag');
    audit.actorUserId = org.userId;
    // Skip assertNameFree on purpose: only the database index stands in the way now.
    await expect(
      createTeamsRepository(db).serialized(org.organizationId, audit, (teams) =>
        teams.create('BACKSTOP TEAM'),
      ),
    ).rejects.toBeInstanceOf(TeamNameTakenError);
    await expect(
      createTagsRepository(db).serialized(org.organizationId, audit, (tags) =>
        tags.create('BACKSTOP-TAG', null),
      ),
    ).rejects.toBeInstanceOf(TagNameTakenError);
  });
});
