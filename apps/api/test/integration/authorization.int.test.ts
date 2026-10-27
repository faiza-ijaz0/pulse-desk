import type { Database, Role } from '@pulsedesk/db';
import { problemDetailsSchema } from '@pulsedesk/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiRouter } from '../../src/api-router.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { WEB_ORIGIN, captureLogs, registeredRoutes, testEnv, type Method } from '../helpers.ts';
import {
  addMember,
  buildIntegrationApp,
  cleanupTestData,
  createTestDb,
  registerOwner,
  signIn,
  testDatabaseUrl,
  type Browser,
  type RegisteredOwner,
} from './helpers.ts';

// A systematic check of every state-changing endpoint: who may call it, and that IDs from
// another organization can't be used to write there. Adding a write route without adding
// it here fails the coverage test below.

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];

type Tenant = { owner: RegisteredOwner; clients: Record<Role, Browser> };
let a: Tenant;
let b: Tenant;
let number = 0;

/** Fresh resources in an organization, so each request acts on its own rows. */
async function resources(t: Tenant) {
  const organizationId = t.owner.organizationId;
  const team = await db.team.create({
    data: { organizationId, name: `Team ${crypto.randomUUID()}` },
  });
  const tag = await db.tag.create({ data: { organizationId, name: `tag-${crypto.randomUUID()}` } });
  const customer = await db.customer.create({
    data: { organizationId, email: `${crypto.randomUUID()}@example.com` },
  });
  const member = await addMember(db, organizationId, 'AGENT', 'authz-target');
  number += 1;
  const ticketNumber = 100_000 + number;
  await db.ticket.create({
    data: { organizationId, number: ticketNumber, subject: 'Authz', customerId: customer.id },
  });
  return {
    teamId: team.id,
    tagId: tag.id,
    customerId: customer.id,
    userId: member.userId,
    ticketNumber,
  };
}
type Resources = Awaited<ReturnType<typeof resources>>;

type WriteRoute = {
  method: Method;
  /** The route pattern as registered (under /api/v1). */
  pattern: string;
  path: (r: Resources) => string;
  body?: (r: Resources) => object;
  /** Roles the server must accept; every other role gets 403. */
  allowed: Role[];
  /** Whether the path names a resource that could belong to another organization. */
  scoped: boolean;
};

const ALL: Role[] = ['OWNER', 'ADMIN', 'AGENT'];
const ADMINS: Role[] = ['OWNER', 'ADMIN'];

const WRITE_ROUTES: WriteRoute[] = [
  {
    method: 'patch',
    pattern: '/organization',
    path: () => '/organization',
    body: () => ({ name: 'Renamed Org' }),
    allowed: ADMINS,
    scoped: false,
  },
  {
    method: 'patch',
    pattern: '/members/:userId',
    path: (r) => `/members/${r.userId}`,
    body: () => ({ role: 'AGENT' }),
    allowed: ADMINS,
    scoped: true,
  },
  {
    method: 'delete',
    pattern: '/members/:userId',
    path: (r) => `/members/${r.userId}`,
    allowed: ADMINS,
    scoped: true,
  },
  {
    method: 'post',
    pattern: '/tickets',
    path: () => '/tickets',
    body: () => ({ subject: 'Authz', customer: { email: 'authz@example.com' }, message: 'Hi' }),
    allowed: ALL,
    scoped: false,
  },
  {
    method: 'patch',
    pattern: '/tickets/:number',
    path: (r) => `/tickets/${r.ticketNumber}`,
    body: () => ({ priority: 'HIGH' }),
    allowed: ALL,
    scoped: true,
  },
  {
    method: 'post',
    pattern: '/tickets/:number/messages',
    path: (r) => `/tickets/${r.ticketNumber}/messages`,
    body: () => ({ body: 'Hello', visibility: 'INTERNAL' }),
    allowed: ALL,
    scoped: true,
  },
  {
    method: 'patch',
    pattern: '/customers/:customerId',
    path: (r) => `/customers/${r.customerId}`,
    body: () => ({ name: 'Renamed' }),
    allowed: ALL,
    scoped: true,
  },
  {
    method: 'post',
    pattern: '/teams',
    path: () => '/teams',
    body: () => ({ name: `T ${crypto.randomUUID()}` }),
    allowed: ADMINS,
    scoped: false,
  },
  {
    method: 'patch',
    pattern: '/teams/:teamId',
    path: (r) => `/teams/${r.teamId}`,
    body: () => ({ name: `R ${crypto.randomUUID()}` }),
    allowed: ADMINS,
    scoped: true,
  },
  {
    method: 'delete',
    pattern: '/teams/:teamId',
    path: (r) => `/teams/${r.teamId}`,
    allowed: ADMINS,
    scoped: true,
  },
  {
    method: 'put',
    pattern: '/teams/:teamId/members/:userId',
    path: (r) => `/teams/${r.teamId}/members/${r.userId}`,
    allowed: ADMINS,
    scoped: true,
  },
  {
    method: 'delete',
    pattern: '/teams/:teamId/members/:userId',
    path: (r) => `/teams/${r.teamId}/members/${r.userId}`,
    allowed: ADMINS,
    scoped: true,
  },
  {
    method: 'post',
    pattern: '/tags',
    path: () => '/tags',
    body: () => ({ name: `t-${crypto.randomUUID()}` }),
    allowed: ADMINS,
    scoped: false,
  },
  {
    method: 'patch',
    pattern: '/tags/:tagId',
    path: (r) => `/tags/${r.tagId}`,
    body: () => ({ name: `r-${crypto.randomUUID()}` }),
    allowed: ADMINS,
    scoped: true,
  },
  {
    method: 'delete',
    pattern: '/tags/:tagId',
    path: (r) => `/tags/${r.tagId}`,
    allowed: ADMINS,
    scoped: true,
  },
];

/** Session and sign-in endpoints: public by design, or acting only on the caller's session. */
const AUTH_ROUTES = [
  'post /auth/register',
  'post /auth/login',
  'post /auth/logout',
  'post /auth/active-organization',
];

function send(client: Browser, route: WriteRoute, r: Resources) {
  const path = `/api/v1${route.path(r)}`;
  const req = client.agent[route.method](path).set('Origin', WEB_ORIGIN);
  return route.body ? req.send(route.body(r)) : req;
}

async function tenant(label: string): Promise<Tenant> {
  const owner = await registerOwner(app, label);
  const admin = await addMember(db, owner.organizationId, 'ADMIN', `${label}-admin`);
  const agent = await addMember(db, owner.organizationId, 'AGENT', `${label}-agent`);
  return {
    owner,
    clients: {
      OWNER: owner.client,
      ADMIN: await signIn(app, admin.email),
      AGENT: await signIn(app, agent.email),
    },
  };
}

beforeAll(async () => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
  a = await tenant('authz-a');
  b = await tenant('authz-b');
}, 120_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

const label = (route: WriteRoute) => `${route.method.toUpperCase()} ${route.pattern}`;

describe('write endpoint coverage', () => {
  it('lists every state-changing route the API registers', () => {
    const env = testEnv({ DATABASE_URL: testDatabaseUrl() });
    const logger = createLogger({
      level: 'silent',
      version: 'test',
      destination: captureLogs().stream,
    });
    const router = createApiRouter({ env, db, logger, clock: { now: () => new Date() } });
    const writes = registeredRoutes(router)
      .filter((r) => r.method !== 'get')
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !AUTH_ROUTES.includes(r))
      .sort();
    expect(writes).toEqual(WRITE_ROUTES.map((r) => `${r.method} ${r.pattern}`).sort());
  });
});

describe.each(WRITE_ROUTES.map((route) => [label(route), route] as const))('%s', (_name, route) => {
  it('requires a session', async () => {
    const r = await resources(a);
    const anonymous = request(app);
    const req = anonymous[route.method](`/api/v1${route.path(r)}`).set('Origin', WEB_ORIGIN);
    const res = await (route.body ? req.send(route.body(r)) : req);
    expect(res.status).toBe(401);
  });

  it('rejects a request without the web app’s Origin', async () => {
    const r = await resources(a);
    const req = a.clients.OWNER.agent[route.method](`/api/v1${route.path(r)}`);
    const res = await (route.body ? req.send(route.body(r)) : req);
    expect(res.status).toBe(403);
    expect(problemDetailsSchema.parse(res.body).code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it.each(ALL)('as %s: allowed only for the documented roles', async (role) => {
    const r = await resources(a);
    const res = await send(a.clients[role], route, r);
    if (route.allowed.includes(role)) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    } else {
      expect(res.status).toBe(403);
      // A refusal reads the same whether or not the resource exists: nothing to probe.
      const missing: Resources = {
        teamId: crypto.randomUUID(),
        tagId: crypto.randomUUID(),
        customerId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        ticketNumber: 999_999,
      };
      const probe = await send(a.clients[role], route, missing);
      const strip = (body: unknown) => ({
        ...problemDetailsSchema.parse(body),
        requestId: '',
        instance: '',
      });
      expect(strip(probe.body)).toEqual(strip(res.body));
    }
  });

  if (route.scoped) {
    it('cannot reach another organization’s resource (404, nothing written there)', async () => {
      const theirs = await resources(b);
      const before = await snapshot(b.owner.organizationId);
      const res = await send(a.clients.OWNER, route, theirs);
      expect(res.status).toBe(404);
      expect(problemDetailsSchema.parse(res.body).code).toBe('NOT_FOUND');
      expect(await snapshot(b.owner.organizationId)).toEqual(before);
    });
  }
});

/** Everything a write could have touched in an organization, for before/after comparison. */
async function snapshot(organizationId: string) {
  const [teams, tags, customers, tickets, members, messages, events, teamMembers] =
    await Promise.all([
      db.team.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      db.tag.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      db.customer.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      db.ticket.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      db.membership.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      db.message.count({ where: { organizationId } }),
      db.ticketEvent.count({ where: { organizationId } }),
      db.teamMember.count({ where: { organizationId } }),
    ]);
  return { teams, tags, customers, tickets, members, messages, events, teamMembers };
}

describe('membership is re-checked on every request', () => {
  it('cuts a removed admin off every write endpoint immediately', async () => {
    const leaver = await addMember(db, a.owner.organizationId, 'ADMIN', 'authz-leaver');
    const client = await signIn(app, leaver.email);
    await a.clients.OWNER.delete(`/api/v1/members/${leaver.userId}`).expect(204);
    for (const route of WRITE_ROUTES) {
      const r = await resources(a);
      const res = await send(client, route, r);
      expect(res.status, label(route)).toBe(403);
      expect(problemDetailsSchema.parse(res.body).code, label(route)).toBe(
        'NO_ACTIVE_ORGANIZATION',
      );
    }
  }, 60_000);
});
