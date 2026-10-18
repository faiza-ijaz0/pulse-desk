import type { Database } from '@pulsedesk/db';
import {
  authSessionSchema,
  memberListResponseSchema,
  organizationSchema,
  problemDetailsSchema,
} from '@pulsedesk/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  buildIntegrationApp,
  cleanupTestData,
  createTestDb,
  registerOwner,
  signIn,
  type RegisteredOwner,
} from './helpers.ts';

let db: Database;
let app: ReturnType<typeof buildIntegrationApp>['app'];

beforeAll(() => {
  db = createTestDb();
  app = buildIntegrationApp(db).app;
});

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

function problemCode(body: unknown) {
  return problemDetailsSchema.parse(body).code;
}

async function memberIds(client: RegisteredOwner['client']) {
  const res = await client.get('/api/v1/members').expect(200);
  return memberListResponseSchema.parse(res.body).data.map((m) => m.userId);
}

/** Two independent organizations, each with an owner and one agent. */
async function twoTenants() {
  const a = await registerOwner(app, 'tenant-a');
  const b = await registerOwner(app, 'tenant-b');
  const agentA = await addMember(db, a.organizationId, 'AGENT');
  const agentB = await addMember(db, b.organizationId, 'AGENT');
  return { a, b, agentA, agentB };
}

describe('unauthenticated access', () => {
  it.each([
    ['GET', '/api/v1/organization'],
    ['PATCH', '/api/v1/organization'],
    ['GET', '/api/v1/members'],
    ['PATCH', '/api/v1/members/3f0e6a52-1d7c-4f0e-9a39-5a0a5f7c2b11'],
    ['DELETE', '/api/v1/members/3f0e6a52-1d7c-4f0e-9a39-5a0a5f7c2b11'],
    ['POST', '/api/v1/auth/active-organization'],
  ])('%s %s returns 401', async (method, path) => {
    const verb = method.toLowerCase() as 'get' | 'patch' | 'post' | 'delete';
    const client = request(app);
    const res = await client[verb](path)
      .set('Origin', 'http://localhost:5173')
      .send(method === 'GET' ? undefined : { name: 'x', role: 'ADMIN' });
    expect(res.status).toBe(401);
    expect(problemCode(res.body)).toBe('UNAUTHENTICATED');
  });
});

describe('tenant context comes from the session', () => {
  it('scopes organization and member reads to the active organization', async () => {
    const { a, b, agentA, agentB } = await twoTenants();

    const org = organizationSchema.parse(
      (await a.client.get('/api/v1/organization').expect(200)).body,
    );
    expect(org.id).toBe(a.organizationId);

    const ids = await memberIds(a.client);
    expect(ids.sort()).toEqual([a.userId, agentA.userId].sort());
    expect(ids).not.toContain(b.userId);
    expect(ids).not.toContain(agentB.userId);
  });

  it('ignores an organization ID smuggled into a request body', async () => {
    const { a, b } = await twoTenants();
    const bBefore = await db.organization.findUniqueOrThrow({ where: { id: b.organizationId } });

    const res = await a.client
      .patch('/api/v1/organization', { name: 'Renamed A', organizationId: b.organizationId })
      .expect(200);

    expect(organizationSchema.parse(res.body)).toMatchObject({
      id: a.organizationId,
      name: 'Renamed A',
    });
    const bAfter = await db.organization.findUniqueOrThrow({ where: { id: b.organizationId } });
    expect(bAfter.name).toBe(bBefore.name);
  });

  it('ignores organization hints in query strings and headers', async () => {
    const { a, b } = await twoTenants();
    const res = await a.client
      .get(`/api/v1/members?organizationId=${b.organizationId}`)
      .set('X-Organization-Id', b.organizationId)
      .expect(200);
    const ids = memberListResponseSchema.parse(res.body).data.map((m) => m.userId);
    expect(ids).not.toContain(b.userId);
  });
});

describe('cross-tenant direct-ID (IDOR) attempts', () => {
  it('returns 404 when changing the role of another organization’s member', async () => {
    const { a, b, agentB } = await twoTenants();

    const res = await a.client
      .patch(`/api/v1/members/${agentB.userId}`, { role: 'ADMIN' })
      .expect(404);
    expect(problemCode(res.body)).toBe('NOT_FOUND');

    const untouched = await db.membership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: b.organizationId, userId: agentB.userId } },
    });
    expect(untouched.role).toBe('AGENT');
  });

  it('returns 404 when removing another organization’s member or owner', async () => {
    const { a, b, agentB } = await twoTenants();

    for (const userId of [agentB.userId, b.userId]) {
      const res = await a.client.delete(`/api/v1/members/${userId}`).expect(404);
      expect(problemCode(res.body)).toBe('NOT_FOUND');
    }
    expect(await db.membership.count({ where: { organizationId: b.organizationId } })).toBe(2);
  });

  it('answers a foreign member ID exactly like a non-existent one', async () => {
    const { a, agentB } = await twoTenants();
    const foreign = await a.client.delete(`/api/v1/members/${agentB.userId}`);
    const missing = await a.client.delete('/api/v1/members/3f0e6a52-1d7c-4f0e-9a39-5a0a5f7c2b11');
    const strip = (body: unknown) => {
      const { requestId: _r, instance: _i, ...rest } = problemDetailsSchema.parse(body);
      return rest;
    };
    expect(foreign.status).toBe(missing.status);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
  });

  it('rejects malformed IDs before they reach the database', async () => {
    const { a } = await twoTenants();
    const res = await a.client.delete(`/api/v1/members/1%20OR%201=1`).expect(400);
    expect(problemCode(res.body)).toBe('VALIDATION_FAILED');
  });

  it('refuses to switch into an organization the user does not belong to', async () => {
    const { a, b } = await twoTenants();

    const res = await a.client
      .post('/api/v1/auth/active-organization', { organizationId: b.organizationId })
      .expect(404);
    expect(problemCode(res.body)).toBe('NOT_FOUND');

    const session = authSessionSchema.parse(
      (await a.client.get('/api/v1/auth/session').expect(200)).body,
    );
    expect(session.activeOrganization?.id).toBe(a.organizationId);
  });
});

describe('switching organizations', () => {
  it('applies the role from the newly active membership and rotates the session token', async () => {
    const { a, b } = await twoTenants();
    // Admin in A, agent in B.
    const multi = await addMember(db, a.organizationId, 'ADMIN', 'multi');
    await db.membership.create({
      data: { organizationId: b.organizationId, userId: multi.userId, role: 'AGENT' },
    });
    const client = await signIn(app, multi.email);
    await client.patch('/api/v1/organization', { name: 'Admin can rename A' }).expect(200);
    const oldSession = await db.session.findFirstOrThrow({
      where: { userId: multi.userId, revokedAt: null },
    });

    const res = await client
      .post('/api/v1/auth/active-organization', { organizationId: b.organizationId })
      .expect(200);
    const session = authSessionSchema.parse(res.body);
    expect(session.activeOrganization).toMatchObject({ id: b.organizationId, role: 'AGENT' });
    expect(session.organizations.map((o) => o.id).sort()).toEqual(
      [a.organizationId, b.organizationId].sort(),
    );

    // The old token is dead; the new one keeps the original absolute expiry.
    const old = await db.session.findUniqueOrThrow({ where: { id: oldSession.id } });
    expect(old.revokedAt).not.toBeNull();
    const fresh = await db.session.findFirstOrThrow({
      where: { userId: multi.userId, revokedAt: null },
    });
    expect(fresh.activeOrganizationId).toBe(b.organizationId);
    expect(fresh.expiresAt).toEqual(oldSession.expiresAt);

    // Now an agent in B: B's data is visible, admin actions are not allowed.
    expect(await memberIds(client)).toContain(b.userId);
    await client.patch('/api/v1/organization', { name: 'Agent cannot rename B' }).expect(403);
  });
});

describe('role enforcement', () => {
  it('lets agents read members but not administer the organization', async () => {
    const owner = await registerOwner(app, 'rbac-agent');
    const agent = await addMember(db, owner.organizationId, 'AGENT');
    const otherAgent = await addMember(db, owner.organizationId, 'AGENT', 'other');
    const client = await signIn(app, agent.email);

    await client.get('/api/v1/members').expect(200);
    await client.get('/api/v1/organization').expect(200);

    for (const res of [
      await client.patch('/api/v1/organization', { name: 'Hijacked' }),
      await client.patch(`/api/v1/members/${otherAgent.userId}`, { role: 'ADMIN' }),
      await client.patch(`/api/v1/members/${agent.userId}`, { role: 'OWNER' }),
      await client.delete(`/api/v1/members/${otherAgent.userId}`),
    ]) {
      expect(res.status).toBe(403);
      expect(problemCode(res.body)).toBe('FORBIDDEN');
    }
    const roles = await db.membership.findMany({
      where: { organizationId: owner.organizationId },
      select: { role: true },
    });
    expect(roles.filter((r) => r.role === 'OWNER')).toHaveLength(1);
    expect(roles.filter((r) => r.role === 'ADMIN')).toHaveLength(0);
  });

  it('lets admins manage agents and admins but never owners or ownership', async () => {
    const owner = await registerOwner(app, 'rbac-admin');
    const admin = await addMember(db, owner.organizationId, 'ADMIN');
    const agent = await addMember(db, owner.organizationId, 'AGENT');
    const client = await signIn(app, admin.email);

    await client.patch('/api/v1/organization', { name: 'Admin rename' }).expect(200);
    const promoted = await client
      .patch(`/api/v1/members/${agent.userId}`, { role: 'ADMIN' })
      .expect(200);
    expect(promoted.body).toMatchObject({ userId: agent.userId, role: 'ADMIN' });

    await client.patch(`/api/v1/members/${agent.userId}`, { role: 'OWNER' }).expect(403);
    await client.patch(`/api/v1/members/${owner.userId}`, { role: 'AGENT' }).expect(403);
    await client.delete(`/api/v1/members/${owner.userId}`).expect(403);
    await client.delete(`/api/v1/members/${agent.userId}`).expect(204);
  });

  it('applies a role change to existing sessions immediately', async () => {
    const owner = await registerOwner(app, 'rbac-live');
    const agent = await addMember(db, owner.organizationId, 'AGENT');
    const client = await signIn(app, agent.email);

    await client.patch('/api/v1/organization', { name: 'Not yet' }).expect(403);
    await owner.client.patch(`/api/v1/members/${agent.userId}`, { role: 'ADMIN' }).expect(200);
    await client.patch('/api/v1/organization', { name: 'Now allowed' }).expect(200);
  });

  it('keeps at least one owner', async () => {
    const owner = await registerOwner(app, 'last-owner');

    const demote = await owner.client
      .patch(`/api/v1/members/${owner.userId}`, { role: 'ADMIN' })
      .expect(409);
    expect(problemCode(demote.body)).toBe('LAST_OWNER');
    const leave = await owner.client.delete(`/api/v1/members/${owner.userId}`).expect(409);
    expect(problemCode(leave.body)).toBe('LAST_OWNER');

    // With a second owner, demotion works and is audited.
    const second = await addMember(db, owner.organizationId, 'OWNER', 'second');
    await owner.client.patch(`/api/v1/members/${second.userId}`, { role: 'ADMIN' }).expect(200);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { organizationId: owner.organizationId, action: 'membership.role_changed' },
    });
    expect(audit).toMatchObject({
      actorUserId: owner.userId,
      targetId: second.userId,
      metadata: { from: 'OWNER', to: 'ADMIN' },
    });
  });

  it('never leaves an organization ownerless when two owners demote each other at once', async () => {
    const owner = await registerOwner(app, 'race');
    const second = await addMember(db, owner.organizationId, 'OWNER', 'race2');
    const secondClient = await signIn(app, second.email);

    const results = await Promise.all([
      owner.client.patch(`/api/v1/members/${second.userId}`, { role: 'ADMIN' }),
      secondClient.patch(`/api/v1/members/${owner.userId}`, { role: 'ADMIN' }),
    ]);

    expect(
      await db.membership.count({ where: { organizationId: owner.organizationId, role: 'OWNER' } }),
    ).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403].sort());
  });
});

describe('member removal', () => {
  it('unassigns the member’s tickets, revokes their access and audits the removal', async () => {
    const owner = await registerOwner(app, 'removal');
    const agent = await addMember(db, owner.organizationId, 'AGENT');
    const customer = await db.customer.create({
      data: { organizationId: owner.organizationId, email: 'customer@example.com' },
    });
    const ticket = await db.ticket.create({
      data: {
        organizationId: owner.organizationId,
        number: 1,
        subject: 'Assigned ticket',
        customerId: customer.id,
        assigneeUserId: agent.userId,
      },
    });
    const agentClient = await signIn(app, agent.email);
    await agentClient.get('/api/v1/members').expect(200);

    await owner.client.delete(`/api/v1/members/${agent.userId}`).expect(204);

    const after = await db.ticket.findFirstOrThrow({
      where: { id: ticket.id, organizationId: owner.organizationId },
    });
    expect(after.assigneeUserId).toBeNull();
    expect(
      await db.auditLog.count({
        where: { organizationId: owner.organizationId, action: 'membership.removed' },
      }),
    ).toBe(1);

    // The removed agent's session survives (it is a valid login) but has no tenant access.
    const denied = await agentClient.get('/api/v1/members').expect(403);
    expect(problemCode(denied.body)).toBe('NO_ACTIVE_ORGANIZATION');
    const session = authSessionSchema.parse(
      (await agentClient.get('/api/v1/auth/session').expect(200)).body,
    );
    expect(session.activeOrganization).toBeNull();
    expect(session.organizations).toEqual([]);
  });
});
