import type {
  Database,
  Prisma,
  TicketEventType,
  TicketPriority,
  TicketStatus,
} from '@pulsedesk/db';
import {
  problemDetailsSchema,
  tagListResponseSchema,
  teamListResponseSchema,
  ticketDetailResponseSchema,
  ticketListResponseSchema,
  type TicketSort,
  type TicketSummary,
} from '@pulsedesk/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN } from '../helpers.ts';
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
let built: ReturnType<typeof buildIntegrationApp>;
let app: ReturnType<typeof buildIntegrationApp>['app'];

const T0 = new Date('2026-09-01T09:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

type Key = 'owner' | 'agent1' | 'agent2';
type FixtureTicket = {
  number: number;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: Key | null;
  team: 'Billing' | 'Technical' | null;
  tags: ('refund' | 'vip' | 'bug')[];
  created: number;
  updated: number;
};

// Tickets 4, 5 and 6 share a creation time and 5–7 share an update time, so every sort
// order has ties that only the ticket number can break.
const TICKETS: FixtureTicket[] = [
  {
    number: 1,
    status: 'OPEN',
    priority: 'URGENT',
    assignee: 'owner',
    team: 'Billing',
    tags: ['refund', 'vip'],
    created: 0,
    updated: 100,
  },
  {
    number: 2,
    status: 'PENDING',
    priority: 'HIGH',
    assignee: 'agent1',
    team: 'Technical',
    tags: ['bug'],
    created: 10,
    updated: 90,
  },
  {
    number: 3,
    status: 'OPEN',
    priority: 'NORMAL',
    assignee: null,
    team: null,
    tags: [],
    created: 20,
    updated: 20,
  },
  {
    number: 4,
    status: 'SOLVED',
    priority: 'LOW',
    assignee: 'agent1',
    team: 'Billing',
    tags: ['refund'],
    created: 30,
    updated: 60,
  },
  {
    number: 5,
    status: 'ON_HOLD',
    priority: 'NORMAL',
    assignee: 'agent2',
    team: 'Technical',
    tags: ['vip'],
    created: 30,
    updated: 70,
  },
  {
    number: 6,
    status: 'CLOSED',
    priority: 'HIGH',
    assignee: 'owner',
    team: null,
    tags: ['bug', 'vip'],
    created: 30,
    updated: 70,
  },
  {
    number: 7,
    status: 'OPEN',
    priority: 'HIGH',
    assignee: 'agent2',
    team: 'Billing',
    tags: [],
    created: 40,
    updated: 70,
  },
];

const INTERNAL_NOTE = 'INTERNAL: customer is on the legacy plan, do not offer a refund';
const PUBLIC_REPLY = 'Thanks for reaching out — we are looking into the invoice now.';
const FOREIGN_SUBJECT = 'Kestrel-only secret subject';

type Helpdesk = {
  owner: RegisteredOwner;
  agent1: { userId: string; email: string; client: Browser };
  agent2: { userId: string; email: string };
  teams: Record<'Billing' | 'Technical', string>;
  tags: Record<'refund' | 'vip' | 'bug', string>;
  ticketIds: Record<number, string>;
  customerId: string;
};

type Foreign = {
  owner: RegisteredOwner;
  agent: { userId: string; email: string };
  teamId: string;
  tagId: string;
};

let desk: Helpdesk;
let foreign: Foreign;

async function createHelpdesk(): Promise<Helpdesk> {
  const owner = await registerOwner(app, 'tickets-a');
  const organizationId = owner.organizationId;
  const agent1 = await addMember(db, organizationId, 'AGENT', 'agent-one');
  const agent2 = await addMember(db, organizationId, 'AGENT', 'agent-two');
  const users: Record<Key, string> = {
    owner: owner.userId,
    agent1: agent1.userId,
    agent2: agent2.userId,
  };

  const team = (name: string) => db.team.create({ data: { organizationId, name } });
  const teams = { Billing: (await team('Billing')).id, Technical: (await team('Technical')).id };
  const tag = (name: string, color: string | null) =>
    db.tag.create({ data: { organizationId, name, color } });
  const tags = {
    refund: (await tag('refund', '#d97706')).id,
    vip: (await tag('vip', null)).id,
    bug: (await tag('bug', '#dc2626')).id,
  };
  const customer = await db.customer.create({
    data: { organizationId, email: 'ada@example.com', name: 'Ada Customer' },
  });

  const ticketIds: Record<number, string> = {};
  for (const t of TICKETS) {
    const ticket = await db.ticket.create({
      data: {
        organizationId,
        number: t.number,
        subject: `Ticket ${t.number}`,
        status: t.status,
        priority: t.priority,
        customerId: customer.id,
        assigneeUserId: t.assignee ? users[t.assignee] : null,
        teamId: t.team ? teams[t.team] : null,
        createdAt: at(t.created),
        updatedAt: at(t.updated),
      },
    });
    ticketIds[t.number] = ticket.id;
    if (t.tags.length > 0) {
      await db.ticketTag.createMany({
        data: t.tags.map((name) => ({ organizationId, ticketId: ticket.id, tagId: tags[name] })),
      });
    }
  }
  await db.organization.update({
    where: { id: organizationId },
    data: { ticketSequence: TICKETS.length },
  });

  return {
    owner,
    agent1: { ...agent1, client: await signIn(app, agent1.email) },
    agent2,
    teams,
    tags,
    ticketIds,
    customerId: customer.id,
  };
}

async function createForeignTenant(): Promise<Foreign> {
  const owner = await registerOwner(app, 'tickets-b');
  const organizationId = owner.organizationId;
  const agent = await addMember(db, organizationId, 'AGENT', 'foreign-agent');
  const team = await db.team.create({ data: { organizationId, name: 'Foreign team' } });
  const tag = await db.tag.create({ data: { organizationId, name: 'foreign-tag' } });
  const customer = await db.customer.create({
    data: { organizationId, email: 'kestrel-customer@example.com' },
  });
  // Numbers overlap with tenant A's on purpose: #1 exists in both, #50 only here.
  for (const number of [1, 50]) {
    const ticket = await db.ticket.create({
      data: {
        organizationId,
        number,
        subject: FOREIGN_SUBJECT,
        customerId: customer.id,
        assigneeUserId: agent.userId,
        teamId: team.id,
        createdAt: at(5),
      },
    });
    await db.ticketTag.create({ data: { organizationId, ticketId: ticket.id, tagId: tag.id } });
    await db.message.create({
      data: {
        organizationId,
        ticketId: ticket.id,
        authorType: 'CUSTOMER',
        authorCustomerId: customer.id,
        body: 'Kestrel conversation',
      },
    });
  }
  return { owner, agent, teamId: team.id, tagId: tag.id };
}

/** Conversation, notes and timeline for tenant A's ticket #1. */
async function addTicketOneHistory() {
  const organizationId = desk.owner.organizationId;
  const ticketId = desk.ticketIds[1]!;
  const message = (data: Omit<Prisma.MessageUncheckedCreateInput, 'organizationId' | 'ticketId'>) =>
    db.message.create({ data: { organizationId, ticketId, ...data } });

  await message({
    authorType: 'CUSTOMER',
    authorCustomerId: desk.customerId,
    body: 'My invoice is wrong.',
    createdAt: at(0),
  });
  await message({
    authorType: 'AGENT',
    authorUserId: desk.owner.userId,
    body: PUBLIC_REPLY,
    createdAt: at(5),
  });
  const note = await message({
    authorType: 'AGENT',
    authorUserId: desk.agent1.userId,
    visibility: 'INTERNAL',
    body: INTERNAL_NOTE,
    createdAt: at(6),
  });
  await message({ authorType: 'SYSTEM', body: 'Ticket merged from #12.', createdAt: at(7) });

  const event = (
    minutes: number,
    type: TicketEventType,
    data: object,
    actorUserId?: string,
    actorType: 'USER' | 'SYSTEM' = 'USER',
  ) =>
    db.ticketEvent.create({
      data: {
        organizationId,
        ticketId,
        type,
        data,
        actorType,
        actorUserId: actorUserId ?? null,
        createdAt: at(minutes),
      },
    });
  await event(0, 'CREATED', {});
  await event(1, 'ASSIGNED', { fromUserId: null, toUserId: desk.owner.userId }, desk.owner.userId);
  await event(2, 'TEAM_CHANGED', { fromTeamId: foreign.teamId, toTeamId: desk.teams.Billing });
  await event(3, 'TAGS_CHANGED', {
    addedTagIds: [desk.tags.refund, foreign.tagId],
    removedTagIds: [],
  });
  await event(4, 'ASSIGNED', { fromUserId: foreign.agent.userId, toUserId: desk.owner.userId });
  await event(6, 'MESSAGE_ADDED', { messageId: note.id, visibility: 'INTERNAL' });
  await event(8, 'STATUS_CHANGED', { from: 'OPEN', to: 'PENDING' }, desk.owner.userId);
  // Written by a buggy or future version: must be dropped, never echoed back as-is.
  await event(9, 'STATUS_CHANGED', { from: 'OPEN', to: 'LOST', secret: 'raw-json' });
  await event(
    10,
    'SLA_FIRST_RESPONSE_BREACHED',
    { dueAt: at(9).toISOString() },
    undefined,
    'SYSTEM',
  );
}

beforeAll(async () => {
  db = createTestDb();
  built = buildIntegrationApp(db);
  app = built.app;
  desk = await createHelpdesk();
  foreign = await createForeignTenant();
  await addTicketOneHistory();
}, 120_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

function problemOf(body: unknown) {
  return problemDetailsSchema.parse(body);
}

async function list(client: Browser, query = ''): Promise<TicketSummary[]> {
  const res = await client.get(`/api/v1/tickets${query}`).expect(200);
  return ticketListResponseSchema.parse(res.body).data;
}

const numbers = (tickets: TicketSummary[]) => tickets.map((t) => t.number);

/** The expected order of `rows` under `sort`, mirroring the API's documented ordering. */
function ordered(rows: FixtureTicket[], sort: TicketSort = 'newest'): number[] {
  const key = (t: FixtureTicket) => (sort === 'updated' ? t.updated : t.created);
  const direction = sort === 'oldest' ? 1 : -1;
  return [...rows]
    .sort((a, b) => direction * (key(a) - key(b) || a.number - b.number))
    .map((t) => t.number);
}

const expectNumbers = (predicate: (t: FixtureTicket) => boolean, sort?: TicketSort) =>
  ordered(TICKETS.filter(predicate), sort);

describe('authentication and permissions', () => {
  it.each(['/api/v1/tickets', '/api/v1/tickets/1', '/api/v1/teams', '/api/v1/tags'])(
    'GET %s returns 401 without a session',
    async (path) => {
      const res = await request(app).get(path).set('Origin', WEB_ORIGIN);
      expect(res.status).toBe(401);
      expect(problemOf(res.body).code).toBe('UNAUTHENTICATED');
    },
  );

  it('lets every role in the organization read tickets', async () => {
    expect(numbers(await list(desk.owner.client))).toHaveLength(TICKETS.length);
    expect(numbers(await list(desk.agent1.client))).toHaveLength(TICKETS.length);
    await desk.agent1.client.get('/api/v1/tickets/1').expect(200);
  });

  it('cuts off a member as soon as they are removed', async () => {
    const leaver = await addMember(db, desk.owner.organizationId, 'AGENT', 'leaver');
    const client = await signIn(app, leaver.email);
    await client.get('/api/v1/tickets').expect(200);

    await desk.owner.client.delete(`/api/v1/members/${leaver.userId}`).expect(204);

    for (const path of ['/api/v1/tickets', '/api/v1/tickets/1']) {
      const res = await client.get(path);
      expect(res.status).toBe(403);
      expect(problemOf(res.body).code).toBe('NO_ACTIVE_ORGANIZATION');
    }
  });
});

describe('GET /api/v1/tickets', () => {
  it('lists only the active organization’s tickets, newest first, matching the contract', async () => {
    const res = await desk.owner.client.get('/api/v1/tickets').expect(200);
    const body = ticketListResponseSchema.parse(res.body);
    expect(numbers(body.data)).toEqual(ordered(TICKETS));
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(FOREIGN_SUBJECT);
  });

  it('shapes each row from the ticket’s own organization', async () => {
    const one = (await list(desk.owner.client)).find((t) => t.number === 1)!;
    expect(one).toMatchObject({
      id: desk.ticketIds[1],
      subject: 'Ticket 1',
      status: 'OPEN',
      priority: 'URGENT',
      channel: 'WEB',
      customer: { name: 'Ada Customer', email: 'ada@example.com' },
      assignee: { userId: desk.owner.userId, name: 'Owner tickets-a' },
      team: { id: desk.teams.Billing, name: 'Billing' },
      createdAt: at(0).toISOString(),
      updatedAt: at(100).toISOString(),
    });
    expect(one.tags).toEqual([
      { id: desk.tags.refund, name: 'refund', color: '#d97706' },
      { id: desk.tags.vip, name: 'vip', color: null },
    ]);
  });

  it('never includes message content, so internal notes cannot leak into the list', async () => {
    const res = await desk.owner.client.get('/api/v1/tickets').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(INTERNAL_NOTE);
    expect(text).not.toContain(PUBLIC_REPLY);
  });

  it('shows the other organization only its own tickets', async () => {
    const theirs = await list(foreign.owner.client);
    expect(theirs.map((t) => t.subject)).toEqual([FOREIGN_SUBJECT, FOREIGN_SUBJECT]);
  });

  describe('filters', () => {
    it.each<[string, (t: FixtureTicket) => boolean]>([
      ['status=OPEN', (t) => t.status === 'OPEN'],
      ['status=PENDING,ON_HOLD', (t) => t.status === 'PENDING' || t.status === 'ON_HOLD'],
      ['priority=HIGH', (t) => t.priority === 'HIGH'],
      ['priority=URGENT,LOW', (t) => t.priority === 'URGENT' || t.priority === 'LOW'],
      ['assignee=me', (t) => t.assignee === 'owner'],
      ['assignee=unassigned', (t) => t.assignee === null],
      ['team=none', (t) => t.team === null],
    ])('%s', async (query, predicate) => {
      expect(numbers(await list(desk.owner.client, `?${query}`))).toEqual(expectNumbers(predicate));
    });

    it('assignee=me means the signed-in user', async () => {
      expect(numbers(await list(desk.agent1.client, '?assignee=me'))).toEqual(
        expectNumbers((t) => t.assignee === 'agent1'),
      );
    });

    it('filters by a specific assignee, team and tag ID', async () => {
      expect(numbers(await list(desk.owner.client, `?assignee=${desk.agent2.userId}`))).toEqual(
        expectNumbers((t) => t.assignee === 'agent2'),
      );
      expect(numbers(await list(desk.owner.client, `?team=${desk.teams.Technical}`))).toEqual(
        expectNumbers((t) => t.team === 'Technical'),
      );
      expect(numbers(await list(desk.owner.client, `?tag=${desk.tags.vip}`))).toEqual(
        expectNumbers((t) => t.tags.includes('vip')),
      );
    });

    it('combines filters with AND', async () => {
      const query = `?status=OPEN,CLOSED&priority=HIGH,URGENT&assignee=me&tag=${desk.tags.vip}`;
      expect(numbers(await list(desk.owner.client, query))).toEqual(
        expectNumbers(
          (t) =>
            (t.status === 'OPEN' || t.status === 'CLOSED') &&
            (t.priority === 'HIGH' || t.priority === 'URGENT') &&
            t.assignee === 'owner' &&
            t.tags.includes('vip'),
        ),
      );
      expect(
        numbers(
          await list(desk.owner.client, `?team=${desk.teams.Billing}&status=OPEN&sort=oldest`),
        ),
      ).toEqual(expectNumbers((t) => t.team === 'Billing' && t.status === 'OPEN', 'oldest'));
    });

    it('returns an empty page for a filter that matches nothing', async () => {
      const res = await desk.owner.client.get('/api/v1/tickets?status=SOLVED&priority=URGENT');
      expect(ticketListResponseSchema.parse(res.body)).toEqual({ data: [], nextCursor: null });
    });

    it('treats another organization’s assignee, team and tag IDs as matching nothing', async () => {
      for (const query of [
        `assignee=${foreign.agent.userId}`,
        `team=${foreign.teamId}`,
        `tag=${foreign.tagId}`,
      ]) {
        expect(await list(desk.owner.client, `?${query}`), query).toEqual([]);
      }
    });
  });

  describe('cursor pagination', () => {
    async function walk(client: Browser, query: string, limit: number) {
      const pages: number[][] = [];
      let cursor: string | null = null;
      do {
        const separator = query ? '&' : '?';
        const suffix = cursor === null ? '' : `&cursor=${cursor}`;
        const res = await client.get(`/api/v1/tickets${query}${separator}limit=${limit}${suffix}`);
        expect(res.status).toBe(200);
        const body = ticketListResponseSchema.parse(res.body);
        pages.push(numbers(body.data));
        cursor = body.nextCursor;
        expect(pages.length).toBeLessThan(20);
      } while (cursor !== null);
      return pages;
    }

    it.each<TicketSort>(['newest', 'oldest', 'updated'])(
      'visits every ticket exactly once in %s order, across ties',
      async (sort) => {
        for (const limit of [1, 2, 3]) {
          const pages = await walk(desk.owner.client, `?sort=${sort}`, limit);
          expect(pages.flat(), `limit=${limit}`).toEqual(ordered(TICKETS, sort));
          expect(pages.every((page) => page.length <= limit)).toBe(true);
        }
      },
    );

    it('keeps filters applied on every page', async () => {
      const pages = await walk(desk.owner.client, '?status=OPEN,CLOSED', 2);
      expect(pages.flat()).toEqual(
        expectNumbers((t) => t.status === 'OPEN' || t.status === 'CLOSED'),
      );
    });

    it('ends without a cursor when the last page is exactly full', async () => {
      const res = await desk.owner.client.get(`/api/v1/tickets?limit=${TICKETS.length}`);
      expect(ticketListResponseSchema.parse(res.body).nextCursor).toBeNull();
    });
  });

  describe('validation', () => {
    it.each([
      ['?status=open', 'query.status'],
      ['?priority=CRITICAL', 'query.priority'],
      ['?assignee=someone', 'query.assignee'],
      ['?team=abc', 'query.team'],
      ['?tag=billing', 'query.tag'],
      ['?sort=priority', 'query.sort'],
      ['?limit=0', 'query.limit'],
      ['?limit=101', 'query.limit'],
      ['?limit=ten', 'query.limit'],
      ['?status=OPEN&status=PENDING', 'query.status'],
      ['?cursor=not-a-cursor', 'query.cursor'],
      ['?cursor=e30', 'query.cursor'],
    ])('%s → 400 at %s', async (query, path) => {
      const res = await desk.owner.client.get(`/api/v1/tickets${query}`);
      expect(res.status).toBe(400);
      const problem = problemOf(res.body);
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.map((e) => e.path)).toContain(path);
    });

    it('rejects unknown parameters, including an attempt to pick the organization', async () => {
      const res = await desk.owner.client.get(
        `/api/v1/tickets?organizationId=${foreign.owner.organizationId}`,
      );
      expect(res.status).toBe(400);
      expect(problemOf(res.body).code).toBe('VALIDATION_FAILED');
    });

    it('rejects a cursor issued for a different sort order', async () => {
      const first = await desk.owner.client.get('/api/v1/tickets?limit=2&sort=newest').expect(200);
      const { nextCursor } = ticketListResponseSchema.parse(first.body);
      const res = await desk.owner.client.get(`/api/v1/tickets?sort=oldest&cursor=${nextCursor}`);
      expect(res.status).toBe(400);
      expect(problemOf(res.body).errors?.map((e) => e.path)).toContain('query.cursor');
    });
  });
});

describe('GET /api/v1/tickets/:number', () => {
  async function detail(client: Browser, number: number | string) {
    const res = await client.get(`/api/v1/tickets/${number}`).expect(200);
    return ticketDetailResponseSchema.parse(res.body);
  }

  it('resolves the number within the active organization', async () => {
    expect((await detail(desk.owner.client, 1)).ticket.id).toBe(desk.ticketIds[1]);
    const theirs = await detail(foreign.owner.client, 1);
    expect(theirs.ticket.subject).toBe(FOREIGN_SUBJECT);
    expect(theirs.ticket.id).not.toBe(desk.ticketIds[1]);
  });

  it('answers another organization’s ticket exactly like a missing one', async () => {
    const foreignOnly = await desk.owner.client.get('/api/v1/tickets/50');
    const missing = await desk.owner.client.get('/api/v1/tickets/999');
    expect(foreignOnly.status).toBe(404);
    expect(missing.status).toBe(404);
    // Only the per-request fields (request ID and the echoed path) may differ.
    const strip = (body: unknown) => ({
      ...problemOf(body),
      requestId: undefined,
      instance: undefined,
    });
    expect(strip(foreignOnly.body)).toEqual(strip(missing.body));
    expect(problemOf(missing.body).code).toBe('NOT_FOUND');
    expect(JSON.stringify(foreignOnly.body)).not.toContain(FOREIGN_SUBJECT);
  });

  it.each(['0', '-1', 'abc', '1.5', '01', '99999999999'])(
    'rejects the malformed number %j with 400',
    async (number) => {
      const res = await desk.owner.client.get(`/api/v1/tickets/${number}`);
      expect(res.status).toBe(400);
      expect(problemOf(res.body).errors?.map((e) => e.path)).toContain('params.number');
    },
  );

  it('rejects query parameters on the detail route', async () => {
    const res = await desk.owner.client.get('/api/v1/tickets/1?include=everything');
    expect(res.status).toBe(400);
  });

  it('returns the public conversation in order, without internal notes', async () => {
    const { conversation } = await detail(desk.owner.client, 1);
    expect(conversation.map((m) => [m.author.type, m.visibility])).toEqual([
      ['CUSTOMER', 'PUBLIC'],
      ['AGENT', 'PUBLIC'],
      ['SYSTEM', 'PUBLIC'],
    ]);
    expect(conversation[0]?.author).toMatchObject({
      type: 'CUSTOMER',
      customerId: desk.customerId,
      name: 'Ada Customer',
      email: 'ada@example.com',
    });
    expect(conversation[1]).toMatchObject({
      author: { type: 'AGENT', userId: desk.owner.userId, name: 'Owner tickets-a' },
      body: PUBLIC_REPLY,
      createdAt: at(5).toISOString(),
      editedAt: null,
    });
    expect(JSON.stringify(conversation)).not.toContain(INTERNAL_NOTE);
  });

  it('returns internal notes separately, for the agent view', async () => {
    const { internalNotes } = await detail(desk.agent1.client, 1);
    expect(internalNotes).toEqual([
      expect.objectContaining({
        visibility: 'INTERNAL',
        body: INTERNAL_NOTE,
        author: { type: 'AGENT', userId: desk.agent1.userId, name: 'Member agent-one' },
      }),
    ]);
  });

  it('returns a typed timeline whose references never resolve outside the organization', async () => {
    const { timeline } = await detail(desk.owner.client, 1);
    expect(timeline.map((e) => e.type)).toEqual([
      'CREATED',
      'ASSIGNED',
      'TEAM_CHANGED',
      'TAGS_CHANGED',
      'ASSIGNED',
      'MESSAGE_ADDED',
      'STATUS_CHANGED',
      'SLA_FIRST_RESPONSE_BREACHED',
    ]);
    const [created, assigned, team, tags, reassigned, , status, breach] = timeline;
    // A USER event without an actor: its account was deleted (here: never set).
    expect(created).toMatchObject({ actorType: 'USER', actor: null, data: {} });
    expect(assigned).toMatchObject({
      actor: { id: desk.owner.userId, name: 'Owner tickets-a' },
      data: { from: null, to: { id: desk.owner.userId, name: 'Owner tickets-a' } },
    });
    expect(team?.data).toEqual({
      from: { id: foreign.teamId, name: null },
      to: { id: desk.teams.Billing, name: 'Billing' },
    });
    expect(tags?.data).toEqual({
      added: [
        { id: desk.tags.refund, name: 'refund' },
        { id: foreign.tagId, name: null },
      ],
      removed: [],
    });
    expect(reassigned?.data).toEqual({
      from: { id: foreign.agent.userId, name: null },
      to: { id: desk.owner.userId, name: 'Owner tickets-a' },
    });
    expect(status?.data).toEqual({ from: 'OPEN', to: 'PENDING' });
    expect(breach).toMatchObject({ actorType: 'SYSTEM', actor: null });
    expect(breach?.data).toEqual({ dueAt: at(9).toISOString() });

    const text = JSON.stringify(timeline);
    expect(text).not.toContain('Foreign team');
    expect(text).not.toContain('foreign-tag');
    expect(text).not.toContain('Member foreign-agent');
  });

  it('drops malformed stored event data instead of echoing it, and logs it', async () => {
    const res = await desk.owner.client.get('/api/v1/tickets/1').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('raw-json');
    expect(built.logs.text()).toContain('Skipped a ticket event with invalid data');
  });

  it('returns an empty history for a ticket without messages or events', async () => {
    const body = await detail(desk.owner.client, 3);
    expect(body).toMatchObject({ conversation: [], internalNotes: [], timeline: [] });
    expect(body.ticket).toMatchObject({ number: 3, assignee: null, team: null, tags: [] });
  });

  it('returns recorded breach markers as ISO timestamps, in the list and the detail', async () => {
    const fixture = TICKETS.find((t) => t.number === 2)!;
    const where = {
      organizationId_id: { organizationId: desk.owner.organizationId, id: desk.ticketIds[2]! },
    };
    // An explicit updatedAt stops Prisma from bumping it, so the sort-order tests are unaffected.
    const restore = { updatedAt: at(fixture.updated) };
    await db.ticket.update({
      where,
      data: { firstResponseBreachedAt: at(30), resolutionBreachedAt: at(240), ...restore },
    });
    try {
      // A recorded breach is history: whatever the due dates say, both targets read breached.
      const recorded = {
        firstResponseBreachedAt: at(30).toISOString(),
        resolutionBreachedAt: at(240).toISOString(),
        sla: { status: 'resolution_breached', firstResponse: 'breached', resolution: 'breached' },
      };
      const rows = await list(desk.owner.client);
      expect(rows.find((t) => t.number === 2)).toMatchObject(recorded);
      expect(rows.find((t) => t.number === 1)).toMatchObject({
        firstResponseBreachedAt: null,
        resolutionBreachedAt: null,
      });
      expect((await detail(desk.owner.client, 2)).ticket).toMatchObject(recorded);
    } finally {
      await db.ticket.update({
        where,
        data: { firstResponseBreachedAt: null, resolutionBreachedAt: null, ...restore },
      });
    }
  });

  it('lets a multi-organization user see each organization’s ticket after switching', async () => {
    const both = await addMember(db, desk.owner.organizationId, 'AGENT', 'both');
    await db.membership.create({
      data: { organizationId: foreign.owner.organizationId, userId: both.userId, role: 'AGENT' },
    });
    const client = await signIn(app, both.email);
    // Sign-in activates the oldest membership: tenant A.
    expect((await detail(client, 1)).ticket.subject).toBe('Ticket 1');
    await client.get('/api/v1/tickets/50').expect(404);

    await client
      .post('/api/v1/auth/active-organization', { organizationId: foreign.owner.organizationId })
      .expect(200);
    expect((await detail(client, 1)).ticket.subject).toBe(FOREIGN_SUBJECT);
    expect((await detail(client, 50)).ticket.subject).toBe(FOREIGN_SUBJECT);
  });
});

describe('GET /api/v1/teams and /api/v1/tags', () => {
  it('lists the active organization’s teams and tags by name', async () => {
    const teams = await desk.agent1.client.get('/api/v1/teams').expect(200);
    expect(teamListResponseSchema.parse(teams.body).data).toEqual([
      { id: desk.teams.Billing, name: 'Billing', members: [] },
      { id: desk.teams.Technical, name: 'Technical', members: [] },
    ]);
    const tags = await desk.agent1.client.get('/api/v1/tags').expect(200);
    expect(tagListResponseSchema.parse(tags.body).data).toEqual([
      // Since Phase 4C each tag also carries how many tickets use it (see TICKETS above).
      { id: desk.tags.bug, name: 'bug', color: '#dc2626', ticketCount: 2 },
      { id: desk.tags.refund, name: 'refund', color: '#d97706', ticketCount: 2 },
      { id: desk.tags.vip, name: 'vip', color: null, ticketCount: 3 },
    ]);
  });
});
