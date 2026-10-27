import type { Database, TicketStatus } from '@pulsedesk/db';
import {
  authSessionSchema,
  customerListResponseSchema,
  customerSchema,
  problemDetailsSchema,
  searchResponseSchema,
  tagListResponseSchema,
  tagSchema,
  teamListResponseSchema,
  teamSchema,
  ticketListResponseSchema,
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
let app: ReturnType<typeof buildIntegrationApp>['app'];

type Tenant = {
  owner: RegisteredOwner;
  admin: { userId: string; client: Browser };
  agent: { userId: string; client: Browser };
  customers: Record<string, string>;
};

let a: Tenant;
let b: Tenant;
let nextNumber: Record<string, number> = {};

const INTERNAL_NOTE = 'SECRET-NOTE: customer threatened a chargeback';
const missingId = () => crypto.randomUUID();

async function tenant(label: string, customers: [string, string | null][]): Promise<Tenant> {
  const owner = await registerOwner(app, label);
  const admin = await addMember(db, owner.organizationId, 'ADMIN', `${label}-admin`);
  const agent = await addMember(db, owner.organizationId, 'AGENT', `${label}-agent`);
  const ids: Record<string, string> = {};
  for (const [email, name] of customers) {
    const customer = await db.customer.create({
      data: { organizationId: owner.organizationId, email, name },
    });
    ids[email] = customer.id;
  }
  return {
    owner,
    admin: { userId: admin.userId, client: await signIn(app, admin.email) },
    agent: { userId: agent.userId, client: await signIn(app, agent.email) },
    customers: ids,
  };
}

/** A ticket created directly, with the organization's sequence kept in step. */
async function ticket(
  t: Tenant,
  customerEmail: string,
  subject: string,
  status: TicketStatus = 'OPEN',
  updatedMinutesAgo = 0,
) {
  const organizationId = t.owner.organizationId;
  const number = (nextNumber[organizationId] ?? 0) + 1;
  nextNumber[organizationId] = number;
  await db.organization.update({ where: { id: organizationId }, data: { ticketSequence: number } });
  const updatedAt = new Date(Date.now() - updatedMinutesAgo * 60_000);
  return db.ticket.create({
    data: {
      organizationId,
      number,
      subject,
      status,
      customerId: t.customers[customerEmail]!,
      createdAt: updatedAt,
      updatedAt,
    },
  });
}

beforeAll(async () => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
  nextNumber = {};
  a = await tenant('dir-a', [
    ['ada@example.com', 'Ada Lovelace'],
    ['grace@example.com', 'Grace Hopper'],
    ['alan@example.com', null],
    ['katherine@example.com', 'Katherine Johnson'],
    ['percent%club@example.com', 'Literal Percent'],
  ]);
  b = await tenant('dir-b', [
    ['ada@example.com', 'Ada Elsewhere'],
    ['zed@example.com', 'Zed Foreign'],
  ]);

  const adaTicket = await ticket(a, 'ada@example.com', 'Invoice charged twice');
  await ticket(a, 'ada@example.com', 'Password reset', 'SOLVED');
  await ticket(a, 'grace@example.com', 'Invoice missing VAT number', 'PENDING');
  await db.message.create({
    data: {
      organizationId: a.owner.organizationId,
      ticketId: adaTicket.id,
      authorType: 'AGENT',
      authorUserId: a.agent.userId,
      visibility: 'INTERNAL',
      body: INTERNAL_NOTE,
    },
  });
  await ticket(b, 'ada@example.com', 'Invoice from another tenant');
}, 120_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

const problemOf = (body: unknown) => problemDetailsSchema.parse(body);
const codeOf = (body: unknown) => problemOf(body).code;
const strip = (body: unknown) => ({ ...problemOf(body), requestId: '', instance: '' });

async function customers(client: Browser, query = '') {
  const res = await client.get(`/api/v1/customers${query}`).expect(200);
  return customerListResponseSchema.parse(res.body);
}

describe('customers', () => {
  it('lists the active organization’s customers by email, with ticket counts', async () => {
    const { data, nextCursor } = await customers(a.agent.client);
    expect(data.map((c) => c.email)).toEqual([
      'ada@example.com',
      'alan@example.com',
      'grace@example.com',
      'katherine@example.com',
      'percent%club@example.com',
    ]);
    expect(nextCursor).toBeNull();
    expect(data[0]).toMatchObject({ name: 'Ada Lovelace', ticketCount: 2, activeTicketCount: 1 });
    expect(data[1]).toMatchObject({ name: null, ticketCount: 0, activeTicketCount: 0 });
    // Same email in tenant B is a different customer, invisible here.
    expect(data[0]?.id).toBe(a.customers['ada@example.com']);
    expect(JSON.stringify(data)).not.toContain('Ada Elsewhere');
  });

  it('pages through every customer exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor ? `&cursor=${cursor}` : '';
      const page = await customers(a.agent.client, `?limit=2${suffix}`);
      expect(page.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.data.map((c) => c.email));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it.each([
    ['ADA', ['ada@example.com']],
    ['hopper', ['grace@example.com']],
    [
      'example.com',
      [
        'ada@example.com',
        'alan@example.com',
        'grace@example.com',
        'katherine@example.com',
        'percent%club@example.com',
      ],
    ],
    ['%', ['percent%club@example.com']],
    ['_', []],
    ['zed', []],
  ])('searches name and email for %j, literally and case-insensitively', async (q, expected) => {
    const { data } = await customers(a.agent.client, `?q=${encodeURIComponent(q)}`);
    expect(data.map((c) => c.email)).toEqual(expected);
  });

  it.each([
    ['?q=', 'query.q'],
    [`?q=${'x'.repeat(101)}`, 'query.q'],
    ['?limit=500', 'query.limit'],
    ['?cursor=%%%', 'query.cursor'],
    ['?q=a&q=b', 'query.q'],
  ])('rejects %s', async (query, path) => {
    const res = await a.agent.client.get(`/api/v1/customers${query}`);
    expect(res.status).toBe(400);
    expect(problemOf(res.body).errors?.map((e) => e.path)).toContain(path);
  });

  it('rejects unknown parameters', async () => {
    const res = await a.agent.client.get(
      `/api/v1/customers?organizationId=${b.owner.organizationId}`,
    );
    expect(res.status).toBe(400);
  });

  it('shows a customer, and answers a foreign or missing one with the same 404', async () => {
    const res = await a.agent.client.get(`/api/v1/customers/${a.customers['ada@example.com']}`);
    expect(customerSchema.parse(res.body)).toMatchObject({
      email: 'ada@example.com',
      ticketCount: 2,
    });
    const foreign = await a.agent.client.get(`/api/v1/customers/${b.customers['zed@example.com']}`);
    const missing = await a.agent.client.get(`/api/v1/customers/${missingId()}`);
    expect(foreign.status).toBe(404);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect((await a.agent.client.get('/api/v1/customers/not-an-id')).status).toBe(400);
  });

  it('lists a customer’s ticket history through the ticket list, without message content', async () => {
    const res = await a.agent.client
      .get(`/api/v1/tickets?customer=${a.customers['ada@example.com']}`)
      .expect(200);
    const { data } = ticketListResponseSchema.parse(res.body);
    expect(data.map((t) => t.subject).sort()).toEqual(['Invoice charged twice', 'Password reset']);
    expect(JSON.stringify(res.body)).not.toContain(INTERNAL_NOTE);

    // Another organization's customer ID matches nothing here.
    const foreign = await a.agent.client.get(
      `/api/v1/tickets?customer=${b.customers['ada@example.com']}`,
    );
    expect(ticketListResponseSchema.parse(foreign.body).data).toEqual([]);
  });

  it('never exposes internal notes through customer endpoints', async () => {
    for (const path of [
      '/api/v1/customers',
      `/api/v1/customers/${a.customers['ada@example.com']}`,
      '/api/v1/search?q=Invoice',
    ]) {
      const res = await a.agent.client.get(path).expect(200);
      expect(JSON.stringify(res.body), path).not.toContain('SECRET-NOTE');
    }
  });

  describe('updating', () => {
    it('lets agents correct a customer’s name and email, normalized and audited', async () => {
      const id = a.customers['katherine@example.com']!;
      const res = await a.agent.client.patch(`/api/v1/customers/${id}`, {
        name: '  Katherine G. Johnson ',
        email: ' K.Johnson@Example.com ',
      });
      expect(res.status).toBe(200);
      expect(customerSchema.parse(res.body)).toMatchObject({
        id,
        name: 'Katherine G. Johnson',
        email: 'k.johnson@example.com',
      });
      const audit = await db.auditLog.findFirst({
        where: { organizationId: a.owner.organizationId, action: 'customer.updated', targetId: id },
      });
      expect(audit?.actorUserId).toBe(a.agent.userId);

      const cleared = await a.agent.client.patch(`/api/v1/customers/${id}`, { name: null });
      expect(customerSchema.parse(cleared.body).name).toBeNull();
    });

    it('refuses an email another customer in the organization already has', async () => {
      const res = await a.agent.client.patch(
        `/api/v1/customers/${a.customers['alan@example.com']}`,
        {
          email: 'ADA@example.com',
        },
      );
      expect(res.status).toBe(409);
      expect(codeOf(res.body)).toBe('CONFLICT');
    });

    it('allows an email that only exists in another organization', async () => {
      const id = a.customers['alan@example.com']!;
      await a.agent.client
        .patch(`/api/v1/customers/${id}`, { email: 'zed@example.com' })
        .expect(200);
      await a.agent.client
        .patch(`/api/v1/customers/${id}`, { email: 'alan@example.com' })
        .expect(200);
    });

    it('cannot touch another organization’s customer', async () => {
      const foreignId = b.customers['zed@example.com']!;
      const res = await a.owner.client.patch(`/api/v1/customers/${foreignId}`, {
        name: 'Hijacked',
      });
      expect(res.status).toBe(404);
      const stored = await db.customer.findFirstOrThrow({
        where: { id: foreignId, organizationId: b.owner.organizationId },
      });
      expect(stored.name).toBe('Zed Foreign');
    });

    it.each([{}, { email: 'not-an-email' }, { name: '' }, { organizationId: missingId() }])(
      'rejects %j',
      async (body) => {
        const res = await a.agent.client.patch(
          `/api/v1/customers/${a.customers['ada@example.com']}`,
          body,
        );
        expect(res.status).toBe(400);
      },
    );
  });
});

describe('teams', () => {
  async function teams(client: Browser) {
    const res = await client.get('/api/v1/teams').expect(200);
    return teamListResponseSchema.parse(res.body).data;
  }

  it('lets admins create, rename and staff teams; everyone can list them with members', async () => {
    const created = await a.admin.client.post('/api/v1/teams', { name: '  Billing ' });
    expect(created.status).toBe(201);
    const team = teamSchema.parse(created.body);
    expect(team).toMatchObject({ name: 'Billing', members: [] });

    await a.admin.client.put(`/api/v1/teams/${team.id}/members/${a.agent.userId}`).expect(200);
    // Adding twice is harmless.
    const again = await a.admin.client.put(`/api/v1/teams/${team.id}/members/${a.agent.userId}`);
    expect(teamSchema.parse(again.body).members).toEqual([
      { userId: a.agent.userId, name: 'Member dir-a-agent' },
    ]);

    const renamed = await a.admin.client.patch(`/api/v1/teams/${team.id}`, { name: 'Billing EU' });
    expect(teamSchema.parse(renamed.body).name).toBe('Billing EU');

    const listed = await teams(a.agent.client);
    expect(listed.find((t) => t.id === team.id)?.members).toHaveLength(1);
    expect(await teams(b.agent.client)).toEqual([]);

    await a.admin.client.delete(`/api/v1/teams/${team.id}/members/${a.agent.userId}`).expect(204);
    expect((await teams(a.agent.client)).find((t) => t.id === team.id)?.members).toEqual([]);
  });

  it('refuses team management to agents', async () => {
    const team = teamSchema.parse(
      (await a.owner.client.post('/api/v1/teams', { name: 'Ops' })).body,
    );
    for (const res of [
      await a.agent.client.post('/api/v1/teams', { name: 'Agents only' }),
      await a.agent.client.patch(`/api/v1/teams/${team.id}`, { name: 'Renamed' }),
      await a.agent.client.put(`/api/v1/teams/${team.id}/members/${a.agent.userId}`),
      await a.agent.client.delete(`/api/v1/teams/${team.id}`),
    ]) {
      expect(res.status).toBe(403);
      expect(codeOf(res.body)).toBe('FORBIDDEN');
    }
  });

  it('keeps team names unique regardless of case', async () => {
    await a.admin.client.post('/api/v1/teams', { name: 'Escalations' }).expect(201);
    const duplicate = await a.admin.client.post('/api/v1/teams', { name: 'ESCALATIONS' });
    expect(duplicate.status).toBe(409);
    expect(codeOf(duplicate.body)).toBe('CONFLICT');
    // Another organization may use the same name.
    await b.owner.client.post('/api/v1/teams', { name: 'Escalations' }).expect(201);
  });

  it('only adds members of the active organization, without revealing others', async () => {
    const team = teamSchema.parse(
      (await a.admin.client.post('/api/v1/teams', { name: 'Tier 2' })).body,
    );
    const foreign = await a.admin.client.put(`/api/v1/teams/${team.id}/members/${b.agent.userId}`);
    const missing = await a.admin.client.put(`/api/v1/teams/${team.id}/members/${missingId()}`);
    expect(foreign.status).toBe(404);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
  });

  it('cannot modify another organization’s team through its ID', async () => {
    const theirs = teamSchema.parse(
      (await b.owner.client.post('/api/v1/teams', { name: 'Theirs' })).body,
    );
    for (const res of [
      await a.owner.client.patch(`/api/v1/teams/${theirs.id}`, { name: 'Taken over' }),
      await a.owner.client.put(`/api/v1/teams/${theirs.id}/members/${a.agent.userId}`),
      await a.owner.client.delete(`/api/v1/teams/${theirs.id}`),
    ]) {
      expect(res.status).toBe(404);
    }
    const stored = await db.team.findFirstOrThrow({
      where: { id: theirs.id, organizationId: b.owner.organizationId },
      include: { members: true },
    });
    expect(stored).toMatchObject({ name: 'Theirs', members: [] });
  });

  it('unassigns a deleted team’s tickets and records it on each ticket’s timeline', async () => {
    const team = teamSchema.parse(
      (await a.admin.client.post('/api/v1/teams', { name: 'Doomed' })).body,
    );
    const doomedTicket = await ticket(a, 'grace@example.com', 'Team will vanish');
    await db.ticket.update({
      where: { organizationId_id: { organizationId: a.owner.organizationId, id: doomedTicket.id } },
      data: { teamId: team.id },
    });

    await a.admin.client.delete(`/api/v1/teams/${team.id}`).expect(204);

    const stored = await db.ticket.findFirstOrThrow({
      where: { id: doomedTicket.id, organizationId: a.owner.organizationId },
      include: { events: true },
    });
    expect(stored.teamId).toBeNull();
    expect(stored.events.map((e) => [e.type, e.data, e.actorUserId])).toEqual([
      ['TEAM_CHANGED', { fromTeamId: team.id, toTeamId: null }, a.admin.userId],
    ]);
    expect(
      await db.auditLog.count({
        where: {
          organizationId: a.owner.organizationId,
          action: 'team.deleted',
          targetId: team.id,
        },
      }),
    ).toBe(1);
    await a.admin.client.delete(`/api/v1/teams/${team.id}`).expect(404);
  });

  it('drops a removed member from every team and revokes their management access at once', async () => {
    const leaver = await addMember(db, a.owner.organizationId, 'ADMIN', 'dir-leaving-admin');
    const client = await signIn(app, leaver.email);
    const team = teamSchema.parse(
      (await client.post('/api/v1/teams', { name: 'Leaver team' })).body,
    );
    await client.put(`/api/v1/teams/${team.id}/members/${leaver.userId}`).expect(200);

    await a.owner.client.delete(`/api/v1/members/${leaver.userId}`).expect(204);

    const res = await client.patch(`/api/v1/teams/${team.id}`, { name: 'Still mine?' });
    expect(res.status).toBe(403);
    expect(codeOf(res.body)).toBe('NO_ACTIVE_ORGANIZATION');
    expect((await teams(a.owner.client)).find((t) => t.id === team.id)?.members).toEqual([]);
  });

  it('applies a demotion to team management immediately', async () => {
    const demoted = await addMember(db, a.owner.organizationId, 'ADMIN', 'dir-demoted');
    const client = await signIn(app, demoted.email);
    await client.post('/api/v1/teams', { name: 'Before demotion' }).expect(201);
    await a.owner.client.patch(`/api/v1/members/${demoted.userId}`, { role: 'AGENT' }).expect(200);
    await client.post('/api/v1/teams', { name: 'After demotion' }).expect(403);
  });

  it.each([{ name: '' }, { name: 'x'.repeat(61) }, { name: 'Ok', members: [] }])(
    'validates %j',
    async (body) => {
      expect((await a.admin.client.post('/api/v1/teams', body)).status).toBe(400);
    },
  );
});

describe('tags', () => {
  async function tags(client: Browser) {
    const res = await client.get('/api/v1/tags').expect(200);
    return tagListResponseSchema.parse(res.body).data;
  }

  it('creates and renames tags for admins, with ticket counts in the list', async () => {
    const created = await a.admin.client.post('/api/v1/tags', { name: ' refund ', color: 'red' });
    expect(created.status).toBe(201);
    const tag = tagSchema.parse(created.body);
    expect(tag).toMatchObject({ name: 'refund', color: 'red', ticketCount: 0 });

    const t = await ticket(a, 'ada@example.com', 'Tagged for counting');
    await db.ticketTag.create({
      data: { organizationId: a.owner.organizationId, ticketId: t.id, tagId: tag.id },
    });

    const renamed = await a.admin.client.patch(`/api/v1/tags/${tag.id}`, {
      name: 'refunds',
      color: null,
    });
    expect(tagSchema.parse(renamed.body)).toMatchObject({
      name: 'refunds',
      color: null,
      ticketCount: 1,
    });
    expect((await tags(a.agent.client)).find((x) => x.id === tag.id)?.ticketCount).toBe(1);
    expect(await tags(b.agent.client)).toEqual([]);

    // Ticket filters and updates keep working with the renamed tag.
    const filtered = await a.agent.client.get(`/api/v1/tickets?tag=${tag.id}`).expect(200);
    expect(ticketListResponseSchema.parse(filtered.body).data.map((x) => x.id)).toEqual([t.id]);
    await a.agent.client.patch(`/api/v1/tickets/${t.number}`, { tagIds: [] }).expect(200);
  });

  it('refuses tag management to agents', async () => {
    const tag = tagSchema.parse(
      (await a.owner.client.post('/api/v1/tags', { name: 'urgent-ish' })).body,
    );
    for (const res of [
      await a.agent.client.post('/api/v1/tags', { name: 'agent-tag' }),
      await a.agent.client.patch(`/api/v1/tags/${tag.id}`, { name: 'renamed' }),
      await a.agent.client.delete(`/api/v1/tags/${tag.id}`),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it('rejects duplicates regardless of case, but allows recasing a tag itself', async () => {
    const vip = tagSchema.parse((await a.admin.client.post('/api/v1/tags', { name: 'vip' })).body);
    const other = tagSchema.parse(
      (await a.admin.client.post('/api/v1/tags', { name: 'gold' })).body,
    );
    for (const res of [
      await a.admin.client.post('/api/v1/tags', { name: 'vip' }),
      await a.admin.client.post('/api/v1/tags', { name: 'VIP' }),
      await a.admin.client.patch(`/api/v1/tags/${other.id}`, { name: 'Vip' }),
    ]) {
      expect(res.status).toBe(409);
      expect(codeOf(res.body)).toBe('CONFLICT');
    }
    const recased = await a.admin.client.patch(`/api/v1/tags/${vip.id}`, { name: 'VIP' });
    expect(tagSchema.parse(recased.body).name).toBe('VIP');
    await b.owner.client.post('/api/v1/tags', { name: 'vip' }).expect(201);
  });

  it('removes a deleted tag from its tickets and records that on each timeline', async () => {
    const tag = tagSchema.parse(
      (await a.admin.client.post('/api/v1/tags', { name: 'legacy' })).body,
    );
    const keep = tagSchema.parse(
      (await a.admin.client.post('/api/v1/tags', { name: 'keeper' })).body,
    );
    const t1 = await ticket(a, 'ada@example.com', 'Legacy one');
    const t2 = await ticket(a, 'grace@example.com', 'Legacy two');
    await db.ticketTag.createMany({
      data: [
        { organizationId: a.owner.organizationId, ticketId: t1.id, tagId: tag.id },
        { organizationId: a.owner.organizationId, ticketId: t1.id, tagId: keep.id },
        { organizationId: a.owner.organizationId, ticketId: t2.id, tagId: tag.id },
      ],
    });

    await a.admin.client.delete(`/api/v1/tags/${tag.id}`).expect(204);

    for (const t of [t1, t2]) {
      const stored = await db.ticket.findFirstOrThrow({
        where: { id: t.id, organizationId: a.owner.organizationId },
        include: { tags: true, events: true },
      });
      expect(stored.tags.map((x) => x.tagId)).toEqual(t === t1 ? [keep.id] : []);
      expect(stored.events.map((e) => [e.type, e.data])).toEqual([
        ['TAGS_CHANGED', { addedTagIds: [], removedTagIds: [tag.id] }],
      ]);
    }
    const audit = await db.auditLog.findFirstOrThrow({
      where: { organizationId: a.owner.organizationId, action: 'tag.deleted', targetId: tag.id },
    });
    expect(audit.metadata).toMatchObject({ name: 'legacy', ticketCount: 2 });
    expect((await tags(a.agent.client)).some((x) => x.id === tag.id)).toBe(false);

    // The deleted tag simply matches nothing in filters, and can't be assigned.
    const filtered = await a.agent.client.get(`/api/v1/tickets?tag=${tag.id}`).expect(200);
    expect(ticketListResponseSchema.parse(filtered.body).data).toEqual([]);
    await a.agent.client.patch(`/api/v1/tickets/${t2.number}`, { tagIds: [tag.id] }).expect(400);
  });

  it('cannot touch another organization’s tag', async () => {
    const theirs = tagSchema.parse(
      (await b.owner.client.post('/api/v1/tags', { name: 'theirs' })).body,
    );
    expect((await a.owner.client.patch(`/api/v1/tags/${theirs.id}`, { name: 'mine' })).status).toBe(
      404,
    );
    expect((await a.owner.client.delete(`/api/v1/tags/${theirs.id}`)).status).toBe(404);
    expect((await tags(b.owner.client)).find((x) => x.id === theirs.id)?.name).toBe('theirs');
  });

  it.each([
    { name: '' },
    { name: 'a,b' },
    { name: 'x'.repeat(41) },
    { name: 'ok', color: '#fff' },
    { name: 'ok', id: missingId() },
  ])('validates %j', async (body) => {
    expect((await a.admin.client.post('/api/v1/tags', body)).status).toBe(400);
  });
});

describe('GET /api/v1/search', () => {
  async function search(client: Browser, q: string) {
    const res = await client.get(`/api/v1/search?q=${encodeURIComponent(q)}`).expect(200);
    return searchResponseSchema.parse(res.body);
  }

  it('finds tickets by subject and customers by name or email, in the active organization only', async () => {
    const result = await search(a.agent.client, 'invoice');
    expect(result.tickets.map((t) => t.subject).sort()).toEqual([
      'Invoice charged twice',
      'Invoice missing VAT number',
    ]);
    expect(JSON.stringify(result)).not.toContain('another tenant');

    expect((await search(a.agent.client, 'lovelace')).customers.map((c) => c.email)).toEqual([
      'ada@example.com',
    ]);
    expect((await search(a.agent.client, 'zed')).customers).toEqual([]);
    expect((await search(b.agent.client, 'ada')).customers.map((c) => c.name)).toEqual([
      'Ada Elsewhere',
    ]);
  });

  it('finds a ticket by number, with or without #, ranked first', async () => {
    for (const q of ['2', '#2']) {
      const { tickets } = await search(a.agent.client, q);
      expect(tickets[0]?.number, q).toBe(2);
    }
  });

  it('orders ticket matches by most recent update, deterministically', async () => {
    await ticket(a, 'ada@example.com', 'Ordering probe older', 'OPEN', 30);
    await ticket(a, 'ada@example.com', 'Ordering probe newer', 'OPEN', 5);
    const { tickets } = await search(a.agent.client, 'ordering probe');
    expect(tickets.map((t) => t.subject)).toEqual(['Ordering probe newer', 'Ordering probe older']);
  });

  it('caps each result type', async () => {
    for (let i = 0; i < 10; i++) await ticket(a, 'ada@example.com', `Bulk match ${i}`);
    expect((await search(a.agent.client, 'bulk match')).tickets).toHaveLength(8);
  });

  it('treats wildcard characters literally', async () => {
    expect((await search(a.agent.client, '%')).customers.map((c) => c.email)).toEqual([
      'percent%club@example.com',
    ]);
    expect(await search(a.agent.client, '_')).toEqual({ tickets: [], customers: [] });
  });

  it('does not search message content, so internal notes stay private', async () => {
    expect(await search(a.agent.client, 'chargeback')).toEqual({ tickets: [], customers: [] });
  });

  it.each(['', '%20%20', 'x'.repeat(101)])('rejects q=%j', async (q) => {
    const res = await a.agent.client.get(`/api/v1/search?q=${q}`);
    expect(res.status).toBe(400);
    expect(problemOf(res.body).errors?.map((e) => e.path)).toContain('query.q');
  });

  it('rejects a missing query, repeated values and unknown parameters', async () => {
    for (const query of [
      '',
      '?q=a&q=b',
      '?q=a&limit=50',
      `?q=a&organizationId=${b.owner.organizationId}`,
    ]) {
      expect((await a.agent.client.get(`/api/v1/search${query}`)).status, query).toBe(400);
    }
  });
});

describe('organization settings', () => {
  it('renames the organization for admins and shows it in the session', async () => {
    const res = await a.admin.client.patch('/api/v1/organization', { name: '  Directory A Ltd ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Directory A Ltd' });
    const session = authSessionSchema.parse(
      (await a.agent.client.get('/api/v1/auth/session').expect(200)).body,
    );
    expect(session.activeOrganization?.name).toBe('Directory A Ltd');
  });

  it('refuses renames to agents and validates names', async () => {
    expect((await a.agent.client.patch('/api/v1/organization', { name: 'Agent Org' })).status).toBe(
      403,
    );
    expect((await a.admin.client.patch('/api/v1/organization', { name: 'A' })).status).toBe(400);
    expect((await a.admin.client.patch('/api/v1/organization', {})).status).toBe(400);
  });
});

describe('authentication', () => {
  it.each([
    ['GET', '/api/v1/customers'],
    ['GET', `/api/v1/customers/${crypto.randomUUID()}`],
    ['PATCH', `/api/v1/customers/${crypto.randomUUID()}`],
    ['POST', '/api/v1/teams'],
    ['POST', '/api/v1/tags'],
    ['GET', '/api/v1/search?q=a'],
  ])('%s %s returns 401 without a session', async (method, path) => {
    const client = request(app);
    const req =
      method === 'GET'
        ? client.get(path)
        : method === 'POST'
          ? client.post(path)
          : client.patch(path);
    const res = await req
      .set('Origin', WEB_ORIGIN)
      .send(method === 'GET' ? undefined : { name: 'x' });
    expect(res.status).toBe(401);
  });
});
