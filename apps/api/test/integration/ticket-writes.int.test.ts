import type { Database, TicketStatus } from '@pulsedesk/db';
import {
  problemDetailsSchema,
  ticketDetailResponseSchema,
  type CreateTicketRequest,
  type TicketDetailResponse,
} from '@pulsedesk/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/http/auth-context.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { createTicketsRepository } from '../../src/modules/tickets/tickets.repository.ts';
import { createTicketsService } from '../../src/modules/tickets/tickets.service.ts';
import { WEB_ORIGIN, captureLogs } from '../helpers.ts';
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

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];

type Desk = {
  owner: RegisteredOwner;
  agent: { userId: string; email: string; client: Browser };
  teamId: string;
  tagIds: { billing: string; vip: string };
};

let desk: Desk;
let other: { owner: RegisteredOwner; agentId: string; teamId: string; tagId: string };

const MINUTE = 60_000;

/**
 * An organization with an agent, a team and two tags. Its SLA policy is the default one
 * every organization gets at sign-up (DEFAULT_SLA_TARGETS in @pulsedesk/shared).
 */
async function createDesk(label: string): Promise<Desk> {
  const owner = await registerOwner(app, label);
  const organizationId = owner.organizationId;
  const agent = await addMember(db, organizationId, 'AGENT', `${label}-agent`);
  const team = await db.team.create({ data: { organizationId, name: 'Billing' } });
  const billing = await db.tag.create({
    data: { organizationId, name: 'billing', color: 'violet' },
  });
  const vip = await db.tag.create({ data: { organizationId, name: 'vip', color: 'amber' } });
  return {
    owner,
    agent: { ...agent, client: await signIn(app, agent.email) },
    teamId: team.id,
    tagIds: { billing: billing.id, vip: vip.id },
  };
}

beforeAll(async () => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
  desk = await createDesk('writes-a');
  const owner = await registerOwner(app, 'writes-b');
  const agent = await addMember(db, owner.organizationId, 'AGENT', 'writes-b-agent');
  const team = await db.team.create({
    data: { organizationId: owner.organizationId, name: 'Other' },
  });
  const tag = await db.tag.create({
    data: { organizationId: owner.organizationId, name: 'other' },
  });
  other = { owner, agentId: agent.userId, teamId: team.id, tagId: tag.id };
}, 120_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

const problemOf = (body: unknown) => problemDetailsSchema.parse(body);

/** A ticket number that exists only in the other organization (far beyond its sequence). */
async function foreignOnlyTicket(): Promise<number> {
  const organizationId = other.owner.organizationId;
  const customer = await db.customer.upsert({
    where: { organizationId_email: { organizationId, email: 'foreign-only@example.com' } },
    create: { organizationId, email: 'foreign-only@example.com' },
    update: {},
  });
  const number = 800_000;
  await db.ticket.upsert({
    where: { organizationId_number: { organizationId, number } },
    create: { organizationId, number, subject: 'Foreign only', customerId: customer.id },
    update: {},
  });
  return number;
}
const fieldPaths = (body: unknown) => problemOf(body).errors?.map((e) => e.path) ?? [];

let customerCounter = 0;
function newTicket(overrides: Partial<CreateTicketRequest> = {}): CreateTicketRequest {
  customerCounter += 1;
  return {
    subject: 'Card charged twice',
    customer: { email: `customer-${customerCounter}@example.com`, name: 'Ada Customer' },
    message: 'My card shows two charges for this month.',
    ...overrides,
  };
}

async function create(client: Browser, body: object = newTicket()): Promise<TicketDetailResponse> {
  const res = await client.post('/api/v1/tickets', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ticketDetailResponseSchema.parse(res.body);
}

const patch = (client: Browser, number: number, body: object) =>
  client.patch(`/api/v1/tickets/${number}`, body);

async function patchOk(client: Browser, number: number, body: object) {
  const res = await patch(client, number, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ticketDetailResponseSchema.parse(res.body);
}

const reply = (client: Browser, number: number, body: object) =>
  client.post(`/api/v1/tickets/${number}/messages`, body);

async function storedTicket(organizationId: string, number: number) {
  return db.ticket.findUniqueOrThrow({
    where: { organizationId_number: { organizationId, number } },
    include: {
      tags: true,
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      messages: true,
    },
  });
}

async function setStatus(organizationId: string, number: number, status: TicketStatus) {
  await db.ticket.update({
    where: { organizationId_number: { organizationId, number } },
    data: { status },
  });
}

describe('POST /api/v1/tickets', () => {
  it('opens a ticket with server-controlled number, status, SLA and timeline', async () => {
    const before = Date.now();
    const created = await create(
      desk.agent.client,
      newTicket({
        priority: 'HIGH',
        customer: { email: ' New.Person@Example.com ', name: 'New Person' },
      }),
    );
    const { ticket } = created;

    expect(ticket).toMatchObject({
      subject: 'Card charged twice',
      status: 'OPEN',
      priority: 'HIGH',
      channel: 'WEB',
      customer: { email: 'new.person@example.com', name: 'New Person' },
      assignee: null,
      team: null,
      tags: [],
      firstRespondedAt: null,
      solvedAt: null,
      closedAt: null,
      firstResponseBreachedAt: null,
      resolutionBreachedAt: null,
    });
    const createdAt = Date.parse(ticket.createdAt);
    expect(createdAt).toBeGreaterThanOrEqual(before - 1000);
    // Default policy, HIGH: first response 60 min, resolution 480 min.
    expect(Date.parse(ticket.firstResponseDueAt!)).toBe(createdAt + 60 * MINUTE);
    expect(Date.parse(ticket.resolutionDueAt!)).toBe(createdAt + 480 * MINUTE);

    expect(created.conversation).toHaveLength(1);
    expect(created.conversation[0]).toMatchObject({
      visibility: 'PUBLIC',
      body: 'My card shows two charges for this month.',
      author: { type: 'CUSTOMER', email: 'new.person@example.com', name: 'New Person' },
    });
    expect(created.internalNotes).toEqual([]);
    expect(created.timeline).toHaveLength(1);
    expect(created.timeline[0]).toMatchObject({
      type: 'CREATED',
      data: {},
      actorType: 'USER',
      actor: { id: desk.agent.userId },
    });

    const stored = await storedTicket(desk.owner.organizationId, ticket.number);
    expect(stored.slaPolicyId).not.toBeNull();
  });

  it('reuses an existing customer by case-insensitive email without overwriting their name', async () => {
    const first = await create(
      desk.owner.client,
      newTicket({ customer: { email: 'repeat@example.com', name: 'Original Name' } }),
    );
    const second = await create(
      desk.owner.client,
      newTicket({ customer: { email: 'REPEAT@example.com', name: 'Other Name' } }),
    );
    expect(second.ticket.customer).toEqual(first.ticket.customer);
    expect(second.ticket.customer.name).toBe('Original Name');
    expect(
      await db.customer.count({
        where: { organizationId: desk.owner.organizationId, email: 'repeat@example.com' },
      }),
    ).toBe(1);
  });

  it('creates a same-email customer separately in each organization', async () => {
    const a = await create(
      desk.owner.client,
      newTicket({ customer: { email: 'shared@example.com' } }),
    );
    const b = await create(
      other.owner.client,
      newTicket({ customer: { email: 'shared@example.com' } }),
    );
    expect(a.ticket.customer.id).not.toBe(b.ticket.customer.id);
    expect(b.ticket.customer.name).toBeNull();
  });

  it('assigns, teams and tags the new ticket from the active organization', async () => {
    const { ticket, timeline } = await create(
      desk.owner.client,
      newTicket({
        assigneeUserId: desk.agent.userId,
        teamId: desk.teamId,
        tagIds: [desk.tagIds.vip, desk.tagIds.billing, desk.tagIds.vip],
      }),
    );
    expect(ticket.assignee?.userId).toBe(desk.agent.userId);
    expect(ticket.team?.id).toBe(desk.teamId);
    expect(ticket.tags.map((t) => t.name)).toEqual(['billing', 'vip']);
    expect(timeline.map((e) => e.type)).toEqual(['CREATED']);
  });

  it('works without an SLA policy: due dates stay empty and the ticket has no SLA', async () => {
    // Organizations get a default policy at sign-up; one that removed it has none.
    const owner = await registerOwner(app, 'no-sla');
    await db.slaPolicy.deleteMany({ where: { organizationId: owner.organizationId } });
    const { ticket } = await create(owner.client);
    expect(ticket).toMatchObject({
      firstResponseDueAt: null,
      resolutionDueAt: null,
      sla: { status: 'none', firstResponse: 'none', resolution: 'none' },
    });
  });

  it('allocates unique, gap-free numbers under concurrent creation', async () => {
    const fresh = await registerOwner(app, 'concurrent');
    const count = 12;
    const results = await Promise.all(
      Array.from({ length: count }, () => fresh.client.post('/api/v1/tickets', newTicket())),
    );
    expect(results.map((r) => r.status)).toEqual(Array.from({ length: count }, () => 201));
    const numbers = results
      .map((r) => ticketDetailResponseSchema.parse(r.body).ticket.number)
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    const org = await db.organization.findUniqueOrThrow({ where: { id: fresh.organizationId } });
    expect(org.ticketSequence).toBe(count);
  });

  it('creates one customer when concurrent tickets name the same new email', async () => {
    const fresh = await registerOwner(app, 'same-customer');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fresh.client.post(
          '/api/v1/tickets',
          newTicket({ customer: { email: 'race@example.com' } }),
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await db.customer.count({ where: { organizationId: fresh.organizationId } })).toBe(1);
  });

  describe('references from another organization', () => {
    it.each([
      [
        'assigneeUserId',
        () => ({ assigneeUserId: other.agentId }),
        () => ({ assigneeUserId: crypto.randomUUID() }),
      ],
      ['teamId', () => ({ teamId: other.teamId }), () => ({ teamId: crypto.randomUUID() })],
      ['tagIds', () => ({ tagIds: [other.tagId] }), () => ({ tagIds: [crypto.randomUUID()] })],
    ])('rejects a foreign %s exactly like a non-existent one', async (field, foreign, missing) => {
      const sequenceBefore = (
        await db.organization.findUniqueOrThrow({ where: { id: desk.owner.organizationId } })
      ).ticketSequence;
      const foreignRes = await desk.owner.client.post('/api/v1/tickets', newTicket(foreign()));
      const missingRes = await desk.owner.client.post('/api/v1/tickets', newTicket(missing()));
      for (const res of [foreignRes, missingRes]) {
        expect(res.status).toBe(400);
        expect(problemOf(res.body).code).toBe('VALIDATION_FAILED');
        expect(fieldPaths(res.body)).toEqual([`body.${field}`]);
      }
      expect(problemOf(foreignRes.body).errors).toEqual(problemOf(missingRes.body).errors);
      // Nothing was created, not even a ticket number.
      const sequenceAfter = (
        await db.organization.findUniqueOrThrow({ where: { id: desk.owner.organizationId } })
      ).ticketSequence;
      expect(sequenceAfter).toBe(sequenceBefore);
    });
  });

  describe('validation', () => {
    it.each([
      ['missing subject', { ...newTicket(), subject: undefined }, 'body.subject'],
      ['blank message', { ...newTicket(), message: '   ' }, 'body.message'],
      ['bad email', { ...newTicket(), customer: { email: 'nope' } }, 'body.customer.email'],
      ['bad priority', { ...newTicket(), priority: 'CRITICAL' }, 'body.priority'],
      ['tag names', { ...newTicket(), tagIds: ['billing'] }, 'body.tagIds.0'],
    ])('rejects %s', async (_label, body, path) => {
      const res = await desk.owner.client.post('/api/v1/tickets', body);
      expect(res.status).toBe(400);
      expect(fieldPaths(res.body)).toContain(path);
    });

    it.each(['status', 'number', 'slaPolicyId', 'organizationId', 'customerId'])(
      'rejects the server-controlled field %s',
      async (field) => {
        const res = await desk.owner.client.post('/api/v1/tickets', {
          ...newTicket(),
          [field]: field === 'number' ? 1 : 'CLOSED',
        });
        expect(res.status).toBe(400);
        expect(problemOf(res.body).code).toBe('VALIDATION_FAILED');
      },
    );

    it('rejects a non-JSON body', async () => {
      const res = await desk.owner.client.agent
        .post('/api/v1/tickets')
        .set('Origin', WEB_ORIGIN)
        .type('form')
        .send('subject=x');
      expect(res.status).toBe(415);
    });
  });
});

describe('PATCH /api/v1/tickets/:number', () => {
  async function eventsOf(number: number) {
    return (await storedTicket(desk.owner.organizationId, number)).events;
  }

  it('records exactly one typed event per changed field, in the same request', async () => {
    const { ticket } = await create(desk.owner.client);
    const updated = await patchOk(desk.agent.client, ticket.number, {
      status: 'PENDING',
      priority: 'URGENT',
      assigneeUserId: desk.agent.userId,
      teamId: desk.teamId,
      tagIds: [desk.tagIds.billing],
    });
    expect(updated.ticket).toMatchObject({
      status: 'PENDING',
      priority: 'URGENT',
      assignee: { userId: desk.agent.userId },
      team: { id: desk.teamId },
      tags: [{ id: desk.tagIds.billing }],
    });

    const events = await eventsOf(ticket.number);
    expect(events.map((e) => [e.type, e.data, e.actorUserId])).toEqual([
      ['CREATED', {}, desk.owner.userId],
      ['STATUS_CHANGED', { from: 'OPEN', to: 'PENDING' }, desk.agent.userId],
      ['PRIORITY_CHANGED', { from: 'NORMAL', to: 'URGENT' }, desk.agent.userId],
      ['ASSIGNED', { fromUserId: null, toUserId: desk.agent.userId }, desk.agent.userId],
      ['TEAM_CHANGED', { fromTeamId: null, toTeamId: desk.teamId }, desk.agent.userId],
      [
        'TAGS_CHANGED',
        { addedTagIds: [desk.tagIds.billing], removedTagIds: [] },
        desk.agent.userId,
      ],
    ]);
    // One mutation's events are stamped consecutively, so the timeline keeps their order.
    const times = events.slice(1).map((e) => e.createdAt.getTime());
    expect(times).toEqual(times.map((_, i) => times[0]! + i));

    // The response's timeline is the typed, resolved form.
    expect(updated.timeline.at(-1)).toMatchObject({
      type: 'TAGS_CHANGED',
      data: { added: [{ id: desk.tagIds.billing, name: 'billing' }], removed: [] },
    });
    // People made these changes through the API: USER events, stored and returned.
    expect(events.map((e) => e.actorType)).toEqual(events.map(() => 'USER'));
    expect(updated.timeline.map((e) => [e.actorType, e.actor?.id])).toEqual([
      ['USER', desk.owner.userId],
      ...events.slice(1).map(() => ['USER', desk.agent.userId]),
    ]);
  });

  it('writes no events and leaves updatedAt alone when nothing changes', async () => {
    const { ticket } = await create(
      desk.owner.client,
      newTicket({ assigneeUserId: desk.agent.userId, tagIds: [desk.tagIds.vip] }),
    );
    const before = await storedTicket(desk.owner.organizationId, ticket.number);
    const same = await patchOk(desk.owner.client, ticket.number, {
      status: 'OPEN',
      priority: 'NORMAL',
      assigneeUserId: desk.agent.userId,
      teamId: null,
      tagIds: [desk.tagIds.vip],
    });
    const after = await storedTicket(desk.owner.organizationId, ticket.number);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(same.ticket.updatedAt).toBe(before.updatedAt.toISOString());
  });

  it('records only the fields that actually changed', async () => {
    const { ticket } = await create(desk.owner.client, newTicket({ tagIds: [desk.tagIds.vip] }));
    await patchOk(desk.owner.client, ticket.number, {
      status: 'OPEN',
      tagIds: [desk.tagIds.billing],
    });
    const events = await eventsOf(ticket.number);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['CREATED', {}],
      ['TAGS_CHANGED', { addedTagIds: [desk.tagIds.billing], removedTagIds: [desk.tagIds.vip] }],
    ]);
  });

  it('clears the assignee and team with null', async () => {
    const { ticket } = await create(
      desk.owner.client,
      newTicket({ assigneeUserId: desk.owner.userId, teamId: desk.teamId }),
    );
    const updated = await patchOk(desk.owner.client, ticket.number, {
      assigneeUserId: null,
      teamId: null,
    });
    expect(updated.ticket).toMatchObject({ assignee: null, team: null });
    expect((await eventsOf(ticket.number)).slice(1).map((e) => e.data)).toEqual([
      { fromUserId: desk.owner.userId, toUserId: null },
      { fromTeamId: desk.teamId, toTeamId: null },
    ]);
  });

  describe('status lifecycle', () => {
    it('stamps solvedAt when solved and clears it when reopened', async () => {
      const { ticket } = await create(desk.owner.client);
      const solved = await patchOk(desk.owner.client, ticket.number, { status: 'SOLVED' });
      expect(solved.ticket.solvedAt).not.toBeNull();
      const reopened = await patchOk(desk.owner.client, ticket.number, { status: 'OPEN' });
      expect(reopened.ticket).toMatchObject({ status: 'OPEN', solvedAt: null, closedAt: null });
    });

    it.each<[TicketStatus, TicketStatus]>([
      ['SOLVED', 'PENDING'],
      ['SOLVED', 'ON_HOLD'],
      ['OPEN', 'CLOSED'],
      ['SOLVED', 'CLOSED'],
    ])('rejects %s → %s with 409 and changes nothing', async (from, to) => {
      const { ticket } = await create(desk.owner.client);
      await setStatus(desk.owner.organizationId, ticket.number, from);
      const before = await storedTicket(desk.owner.organizationId, ticket.number);

      const res = await patch(desk.owner.client, ticket.number, { status: to, priority: 'HIGH' });
      expect(res.status).toBe(409);
      expect(problemOf(res.body).code).toBe('INVALID_STATUS_TRANSITION');

      const after = await storedTicket(desk.owner.organizationId, ticket.number);
      expect(after.status).toBe(from);
      expect(after.priority).toBe('NORMAL');
      expect(after.events).toHaveLength(before.events.length);
    });

    it('treats closed tickets as read-only', async () => {
      const { ticket } = await create(desk.owner.client);
      await setStatus(desk.owner.organizationId, ticket.number, 'CLOSED');
      for (const res of [
        await patch(desk.owner.client, ticket.number, { priority: 'HIGH' }),
        await reply(desk.owner.client, ticket.number, { body: 'Hello', visibility: 'PUBLIC' }),
        await reply(desk.owner.client, ticket.number, { body: 'Note', visibility: 'INTERNAL' }),
      ]) {
        expect(res.status).toBe(409);
        expect(problemOf(res.body).code).toBe('TICKET_CLOSED');
      }
    });
  });

  it('recomputes unmet SLA due dates when the priority changes', async () => {
    const { ticket } = await create(desk.owner.client, newTicket({ priority: 'LOW' }));
    const createdAt = Date.parse(ticket.createdAt);
    const urgent = await patchOk(desk.owner.client, ticket.number, { priority: 'URGENT' });
    expect(Date.parse(urgent.ticket.firstResponseDueAt!)).toBe(createdAt + 30 * MINUTE);
    expect(Date.parse(urgent.ticket.resolutionDueAt!)).toBe(createdAt + 240 * MINUTE);

    // Once the first response is met, its due date is history and stays put.
    await reply(desk.owner.client, ticket.number, { body: 'On it', visibility: 'PUBLIC' }).expect(
      201,
    );
    const low = await patchOk(desk.owner.client, ticket.number, { priority: 'LOW' });
    expect(Date.parse(low.ticket.firstResponseDueAt!)).toBe(createdAt + 30 * MINUTE);
    expect(Date.parse(low.ticket.resolutionDueAt!)).toBe(createdAt + 4320 * MINUTE);
    expect(low.ticket.sla).toEqual({
      status: 'on_track',
      firstResponse: 'met',
      resolution: 'on_track',
    });
  });

  it('keeps a due date that has already passed when the priority changes', async () => {
    // Pretend the ticket was opened two hours ago: its urgent first response (30 min) has
    // passed, and lowering the priority must not move it out and hide the breach.
    const { ticket } = await create(desk.owner.client, newTicket({ priority: 'URGENT' }));
    const openedAt = new Date(Date.now() - 120 * MINUTE);
    const passedDue = new Date(openedAt.getTime() + 30 * MINUTE);
    await db.ticket.update({
      where: { organizationId_id: { organizationId: desk.owner.organizationId, id: ticket.id } },
      data: {
        createdAt: openedAt,
        firstResponseDueAt: passedDue,
        resolutionDueAt: new Date(openedAt.getTime() + 240 * MINUTE),
      },
    });

    const low = await patchOk(desk.owner.client, ticket.number, { priority: 'LOW' });
    expect(low.ticket.firstResponseDueAt).toBe(passedDue.toISOString());
    // The resolution target (4 h) hasn't passed yet, so it follows the new priority (72 h).
    expect(Date.parse(low.ticket.resolutionDueAt!)).toBe(openedAt.getTime() + 4320 * MINUTE);
    expect(low.ticket.sla).toMatchObject({
      status: 'first_response_breached',
      firstResponse: 'breached',
    });
  });

  describe('references from another organization', () => {
    it.each([
      ['assigneeUserId', () => ({ assigneeUserId: other.agentId })],
      ['teamId', () => ({ teamId: other.teamId })],
      ['tagIds', () => ({ tagIds: [desk.tagIds.billing, other.tagId] })],
    ])('rejects a foreign %s and changes nothing', async (field, body) => {
      const { ticket } = await create(desk.owner.client);
      const res = await patch(desk.owner.client, ticket.number, { status: 'PENDING', ...body() });
      expect(res.status).toBe(400);
      expect(fieldPaths(res.body)).toEqual([`body.${field}`]);
      const stored = await storedTicket(desk.owner.organizationId, ticket.number);
      expect(stored).toMatchObject({
        status: 'OPEN',
        assigneeUserId: null,
        teamId: null,
        tags: [],
      });
      expect(stored.events).toHaveLength(1);
    });
  });

  it('answers a missing ticket and another organization’s ticket with the same 404', async () => {
    const foreignNumber = await foreignOnlyTicket();
    const strip = (body: unknown) => ({ ...problemOf(body), requestId: '', instance: '' });
    for (const send of [
      (n: number) => patch(desk.owner.client, n, { priority: 'HIGH' }),
      (n: number) => reply(desk.owner.client, n, { body: 'Hi', visibility: 'PUBLIC' }),
    ]) {
      const foreign = await send(foreignNumber);
      const missing = await send(900_000);
      expect(foreign.status).toBe(404);
      expect(strip(foreign.body)).toEqual(strip(missing.body));
    }
    const theirs = await storedTicket(other.owner.organizationId, foreignNumber);
    expect(theirs).toMatchObject({ priority: 'NORMAL', messages: [] });
  });

  it.each([
    ['{}', {}],
    ['an unknown field', { subject: 'Changed' }],
    ['the SLA policy (a settings field)', { slaPolicyId: crypto.randomUUID() }],
    ['a tag created by name', { tagIds: [{ name: 'brand-new-tag' }] }],
    ['a bad status', { status: 'DONE' }],
  ])('rejects %s with 400', async (_label, body) => {
    const { ticket } = await create(desk.agent.client);
    const tagsBefore = await db.tag.count({ where: { organizationId: desk.owner.organizationId } });
    const res = await patch(desk.agent.client, ticket.number, body);
    expect(res.status).toBe(400);
    expect(problemOf(res.body).code).toBe('VALIDATION_FAILED');
    expect(await db.tag.count({ where: { organizationId: desk.owner.organizationId } })).toBe(
      tagsBefore,
    );
  });

  it('rejects malformed ticket numbers', async () => {
    for (const number of ['0', 'abc', '1.5']) {
      const res = await desk.owner.client.patch(`/api/v1/tickets/${number}`, { priority: 'HIGH' });
      expect(res.status).toBe(400);
      expect(fieldPaths(res.body)).toContain('params.number');
    }
  });
});

describe('POST /api/v1/tickets/:number/messages', () => {
  it('adds a public reply, sets firstRespondedAt once and records the event', async () => {
    const { ticket } = await create(desk.owner.client);
    const res = await reply(desk.agent.client, ticket.number, {
      body: '  Thanks — refund started.\n\nIt takes 3 days.  ',
      visibility: 'PUBLIC',
    });
    expect(res.status).toBe(201);
    const first = ticketDetailResponseSchema.parse(res.body);
    const message = first.conversation.at(-1)!;
    expect(message).toMatchObject({
      visibility: 'PUBLIC',
      body: 'Thanks — refund started.\n\nIt takes 3 days.',
      author: { type: 'AGENT', userId: desk.agent.userId },
    });
    expect(first.ticket.firstRespondedAt).toBe(message.createdAt);
    expect(first.timeline.at(-1)).toMatchObject({
      type: 'MESSAGE_ADDED',
      actorType: 'USER',
      actor: { id: desk.agent.userId },
      data: { messageId: message.id, visibility: 'PUBLIC' },
    });
    expect(Date.parse(first.ticket.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(message.createdAt),
    );

    const second = ticketDetailResponseSchema.parse(
      (await reply(desk.owner.client, ticket.number, { body: 'Follow-up', visibility: 'PUBLIC' }))
        .body,
    );
    expect(second.ticket.firstRespondedAt).toBe(first.ticket.firstRespondedAt);
    expect(second.conversation).toHaveLength(3);
  });

  it('keeps internal notes out of the conversation and does not count them as a response', async () => {
    const { ticket } = await create(desk.owner.client);
    const res = await reply(desk.agent.client, ticket.number, {
      body: 'Customer is on the legacy plan.',
      visibility: 'INTERNAL',
    });
    expect(res.status).toBe(201);
    const body = ticketDetailResponseSchema.parse(res.body);
    expect(body.ticket.firstRespondedAt).toBeNull();
    expect(body.internalNotes).toEqual([
      expect.objectContaining({ visibility: 'INTERNAL', body: 'Customer is on the legacy plan.' }),
    ]);
    expect(JSON.stringify(body.conversation)).not.toContain('legacy plan');
    expect(body.timeline.at(-1)).toMatchObject({
      type: 'MESSAGE_ADDED',
      data: { visibility: 'INTERNAL' },
    });

    // The inbox list never carries message text.
    const list = await desk.owner.client.get('/api/v1/tickets?limit=100').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('legacy plan');
  });

  it('records the earliest of concurrent first replies as the first response', async () => {
    const { ticket } = await create(desk.owner.client);
    const results = await Promise.all(
      ['one', 'two', 'three', 'four'].map((body) =>
        reply(desk.agent.client, ticket.number, { body, visibility: 'PUBLIC' }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const stored = await storedTicket(desk.owner.organizationId, ticket.number);
    const agentReplies = stored.messages
      .filter((m) => m.authorType === 'AGENT')
      .map((m) => m.createdAt.getTime());
    expect(stored.firstRespondedAt?.getTime()).toBe(Math.min(...agentReplies));
    expect(stored.events.filter((e) => e.type === 'MESSAGE_ADDED')).toHaveLength(4);
  });

  it.each([
    ['an empty body', { body: '   ', visibility: 'PUBLIC' }, 'body.body'],
    ['a missing visibility', { body: 'Hi' }, 'body.visibility'],
    ['an unknown visibility', { body: 'Hi', visibility: 'PRIVATE' }, 'body.visibility'],
    ['an oversized body', { body: 'x'.repeat(10_001), visibility: 'PUBLIC' }, 'body.body'],
  ])('rejects %s', async (_label, body, path) => {
    const { ticket } = await create(desk.owner.client);
    const res = await reply(desk.owner.client, ticket.number, body);
    expect(res.status).toBe(400);
    expect(fieldPaths(res.body)).toContain(path);
  });

  it.each([
    ['a customer author type', { authorType: 'CUSTOMER' }],
    ['another author', { authorUserId: crypto.randomUUID() }],
    ['a customer ID', { authorCustomerId: crypto.randomUUID() }],
  ])('refuses to let the client choose %s', async (_label, extra) => {
    const { ticket } = await create(desk.owner.client);
    const res = await reply(desk.agent.client, ticket.number, {
      body: 'Spoofed',
      visibility: 'PUBLIC',
      ...extra,
    });
    expect(res.status).toBe(400);
    const stored = await storedTicket(desk.owner.organizationId, ticket.number);
    expect(stored.messages).toHaveLength(1);
  });

  it('returns 404 for a missing or foreign ticket', async () => {
    for (const number of [900_001, await foreignOnlyTicket()]) {
      const res = await reply(desk.owner.client, number, { body: 'Hi', visibility: 'PUBLIC' });
      expect(res.status).toBe(404);
      expect(problemOf(res.body).code).toBe('NOT_FOUND');
    }
  });
});

describe('authorization', () => {
  it.each([
    ['POST', '/api/v1/tickets'],
    ['PATCH', '/api/v1/tickets/1'],
    ['POST', '/api/v1/tickets/1/messages'],
  ])('%s %s returns 401 without a session', async (method, path) => {
    const client = request(app);
    const req = method === 'POST' ? client.post(path) : client.patch(path);
    const res = await req.set('Origin', WEB_ORIGIN).send({ priority: 'HIGH' });
    expect(res.status).toBe(401);
  });

  it('rejects writes without a trusted Origin (CSRF)', async () => {
    const res = await desk.owner.client.agent.post('/api/v1/tickets').send(newTicket());
    expect(res.status).toBe(403);
    expect(problemOf(res.body).code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it('cuts off a removed member immediately', async () => {
    const leaver = await addMember(db, desk.owner.organizationId, 'AGENT', 'writes-leaver');
    const client = await signIn(app, leaver.email);
    const { ticket } = await create(client);
    await desk.owner.client.delete(`/api/v1/members/${leaver.userId}`).expect(204);

    for (const res of [
      await client.post('/api/v1/tickets', newTicket()),
      await patch(client, ticket.number, { priority: 'HIGH' }),
      await reply(client, ticket.number, { body: 'Hi', visibility: 'PUBLIC' }),
    ]) {
      expect(res.status).toBe(403);
      expect(problemOf(res.body).code).toBe('NO_ACTIVE_ORGANIZATION');
    }
  });

  it('gives agents no settings powers through ticket endpoints', async () => {
    const organizationId = desk.owner.organizationId;
    const counts = async () => ({
      tags: await db.tag.count({ where: { organizationId } }),
      teams: await db.team.count({ where: { organizationId } }),
      policies: await db.slaPolicy.count({ where: { organizationId } }),
    });
    const before = await counts();
    const { ticket } = await create(desk.agent.client, newTicket({ tagIds: [desk.tagIds.vip] }));

    await patch(desk.agent.client, ticket.number, { slaPolicyId: crypto.randomUUID() }).expect(400);
    await patch(desk.agent.client, ticket.number, { tags: ['new-tag'] }).expect(400);
    await patch(desk.agent.client, ticket.number, { teamName: 'New team' }).expect(400);
    // The settings endpoints themselves stay closed to agents.
    await desk.agent.client.patch('/api/v1/organization', { name: 'Hijacked' }).expect(403);
    expect(await counts()).toEqual(before);
  });
});

describe('atomicity', () => {
  /** The real service over a repository whose event writes fail inside the transaction. */
  function serviceWithFailingEvents() {
    const repository = createTicketsRepository(db);
    const failing: typeof repository = {
      ...repository,
      write: (organizationId, fn) =>
        repository.write(organizationId, (scope) =>
          fn({
            ...scope,
            addEvents: () => Promise.reject(new Error('event write failed')),
          }),
        ),
    };
    const logs = captureLogs();
    return createTicketsService({
      repository: failing,
      logger: createLogger({ level: 'silent', version: 'test', destination: logs.stream }),
      clock: { now: () => new Date() },
    });
  }

  const tenant = (): TenantContext => ({
    organizationId: desk.owner.organizationId,
    userId: desk.owner.userId,
    role: 'OWNER',
    requestId: 'atomicity-test',
  });

  it('rolls back a ticket update when its event cannot be written', async () => {
    const { ticket } = await create(desk.owner.client);
    const service = serviceWithFailingEvents();
    await expect(
      service.update(tenant(), ticket.number, { status: 'SOLVED', tagIds: [desk.tagIds.vip] }),
    ).rejects.toThrow('event write failed');

    const stored = await storedTicket(desk.owner.organizationId, ticket.number);
    expect(stored).toMatchObject({ status: 'OPEN', solvedAt: null, tags: [] });
    expect(stored.events).toHaveLength(1);
  });

  it('rolls back a message when its event cannot be written', async () => {
    const { ticket } = await create(desk.owner.client);
    const service = serviceWithFailingEvents();
    await expect(
      service.addMessage(tenant(), ticket.number, { body: 'Lost reply', visibility: 'PUBLIC' }),
    ).rejects.toThrow('event write failed');

    const stored = await storedTicket(desk.owner.organizationId, ticket.number);
    expect(stored.messages).toHaveLength(1);
    expect(stored.firstRespondedAt).toBeNull();
  });

  it('rolls back ticket creation, including the number and a new customer', async () => {
    const sequenceBefore = (
      await db.organization.findUniqueOrThrow({ where: { id: desk.owner.organizationId } })
    ).ticketSequence;
    const service = serviceWithFailingEvents();
    await expect(
      service.create(tenant(), {
        subject: 'Never stored',
        customer: { email: 'rolled-back@example.com' },
        message: 'Hello',
        priority: 'NORMAL',
        channel: 'WEB',
        tagIds: [],
      }),
    ).rejects.toThrow('event write failed');

    const org = await db.organization.findUniqueOrThrow({
      where: { id: desk.owner.organizationId },
    });
    expect(org.ticketSequence).toBe(sequenceBefore);
    expect(
      await db.customer.count({
        where: { organizationId: desk.owner.organizationId, email: 'rolled-back@example.com' },
      }),
    ).toBe(0);
  });
});
