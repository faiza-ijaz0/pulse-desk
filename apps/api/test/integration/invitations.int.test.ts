import type { Database } from '@pulsedesk/db';
import {
  authSessionSchema,
  createInvitationResponseSchema,
  invitationListResponseSchema,
  invitationPreviewSchema,
  problemDetailsSchema,
} from '@pulsedesk/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashInvitationToken } from '../../src/modules/invitations/invitation-token.ts';
import {
  PASSWORD,
  addMember,
  browser,
  buildIntegrationApp,
  cleanupTestData,
  createTestDb,
  registerOwner,
  sessionCookieFrom,
  signIn,
  uniqueEmail,
  type Browser,
  type RegisteredOwner,
} from './helpers.ts';

// Invitations against real PostgreSQL through the full app: token hashing, the one-open-
// invitation index, expiry, revocation and replay, acceptance by existing and new users with
// row locks against races, role rules, tenant isolation, audit entries, and the existing
// member endpoints for changes to one's own membership.

let db: Database;
let built: ReturnType<typeof buildIntegrationApp>;
let app: ReturnType<typeof buildIntegrationApp>['app'];
let orgA: RegisteredOwner;
let orgB: RegisteredOwner;
let adminA: Browser;
let agentA: Browser;
let agentAUserId: string;

const problem = (body: unknown) => problemDetailsSchema.parse(body);

async function invite(client: Browser, email: string, role: 'ADMIN' | 'AGENT' = 'AGENT') {
  const res = await client.post('/api/v1/invitations', { email, role });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...createInvitationResponseSchema.parse(res.body), res };
}

const preview = (token: string) => browser(app).post('/api/v1/invitations/preview', { token });
const accept = (client: Browser, token: string) =>
  client.post('/api/v1/invitations/accept', { token });
const registerInvited = (token: string, name = 'New Person', password = PASSWORD) =>
  browser(app).post('/api/v1/invitations/register', { token, name, password });

function stored(organizationId: string, id: string) {
  return db.invitation.findFirstOrThrow({ where: { organizationId, id } });
}

function audits(organizationId: string, action?: string) {
  return db.auditLog.findMany({
    where: { organizationId, action: action ?? { startsWith: 'invitation.' } },
    orderBy: { createdAt: 'asc' },
  });
}

async function membershipCount(organizationId: string, email: string) {
  return db.membership.count({ where: { organizationId, user: { email } } });
}

/** A registered, signed-in user: the owner of their own organization. */
const existingUser = (label: string) => registerOwner(app, label);

beforeAll(async () => {
  db = createTestDb();
  built = buildIntegrationApp(db);
  app = built.app;
  orgA = await registerOwner(app, 'invite-a');
  orgB = await registerOwner(app, 'invite-b');
  const admin = await addMember(db, orgA.organizationId, 'ADMIN', 'invite-a-admin');
  const agent = await addMember(db, orgA.organizationId, 'AGENT', 'invite-a-agent');
  adminA = await signIn(app, admin.email);
  agentA = await signIn(app, agent.email);
  agentAUserId = agent.userId;
}, 60_000);

afterAll(async () => {
  await cleanupTestData(db);
  await db.$disconnect();
});

describe('creating invitations', () => {
  it('stores only a keyed hash of the token, returns it once and audits without it', async () => {
    const email = uniqueEmail('hash');
    const { invitation, token, res } = await invite(orgA.client, email, 'ADMIN');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation).toMatchObject({ email, role: 'ADMIN', status: 'pending' });
    expect(invitation.invitedBy).toEqual({ userId: orgA.userId, name: 'Owner invite-a' });
    expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(
      7 * 86_400_000,
    );

    const row = await stored(orgA.organizationId, invitation.id);
    expect(row.tokenHash).toBe(hashInvitationToken(built.env.SESSION_SECRET, token));
    expect(JSON.stringify(row)).not.toContain(token);

    const [entry] = await audits(orgA.organizationId, 'invitation.created').then((all) =>
      all.filter((a) => a.targetId === invitation.id),
    );
    expect(entry).toMatchObject({
      actorUserId: orgA.userId,
      targetType: 'Invitation',
      metadata: { email, role: 'ADMIN', expiresAt: invitation.expiresAt },
    });
    expect(JSON.stringify(entry)).not.toContain(token);
    // The token never reaches the logs either.
    expect(built.logs.text()).not.toContain(token);
  });

  it('lists open invitations of the session’s organization only', async () => {
    const email = uniqueEmail('listed');
    const { invitation } = await invite(adminA, email);
    const list = invitationListResponseSchema.parse(
      (await orgA.client.get('/api/v1/invitations').expect(200)).body,
    );
    expect(list.data.map((i) => i.id)).toContain(invitation.id);
    const foreign = invitationListResponseSchema.parse(
      (await orgB.client.get('/api/v1/invitations').expect(200)).body,
    );
    expect(foreign.data.map((i) => i.email)).not.toContain(email);
  });

  it('lets admins invite admins and agents, never owners; agents can’t manage invitations', async () => {
    await invite(adminA, uniqueEmail('by-admin'), 'ADMIN');
    for (const client of [orgA.client, adminA]) {
      const res = await client.post('/api/v1/invitations', {
        email: uniqueEmail('owner'),
        role: 'OWNER',
      });
      expect(res.status).toBe(400);
      expect(problem(res.body).errors?.map((e) => e.path)).toEqual(['body.role']);
    }
    const before = (await audits(orgA.organizationId)).length;
    const asAgent = [
      await agentA.get('/api/v1/invitations'),
      await agentA.post('/api/v1/invitations', { email: uniqueEmail('x'), role: 'AGENT' }),
      await agentA.delete(`/api/v1/invitations/${crypto.randomUUID()}`),
    ];
    expect(asAgent.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(await audits(orgA.organizationId)).toHaveLength(before);
    const anonymous = await browser(app).get('/api/v1/invitations');
    expect(anonymous.status).toBe(401);
  });

  it.each([
    ['a missing email', { role: 'AGENT' }, 'body.email'],
    ['an invalid email', { email: 'nope', role: 'AGENT' }, 'body.email'],
    ['a missing role', { email: 'a@example.com' }, 'body.role'],
  ])('rejects %s', async (_, body, path) => {
    const res = await orgA.client.post('/api/v1/invitations', body);
    expect(res.status).toBe(400);
    expect(problem(res.body).errors?.map((e) => e.path)).toContain(path);
  });

  it('refuses current members, but treats an account elsewhere like any other email', async () => {
    const member = await db.user.findUniqueOrThrow({ where: { id: agentAUserId } });
    const res = await orgA.client.post('/api/v1/invitations', {
      email: member.email.toUpperCase(),
      role: 'ADMIN',
    });
    expect(res.status).toBe(409);
    expect(problem(res.body).code).toBe('ALREADY_MEMBER');

    // orgB's owner has an account but isn't in orgA: the answer can't tell that apart from
    // an email nobody has used.
    const known = await invite(orgA.client, orgB.email);
    const unknown = await invite(orgA.client, uniqueEmail('nobody'));
    expect(Object.keys(known.res.body as object)).toEqual(Object.keys(unknown.res.body as object));
    expect(known.invitation.status).toBe(unknown.invitation.status);
  });

  it('replaces an open invitation to the same email, which stops working', async () => {
    const email = uniqueEmail('again');
    const first = await invite(orgA.client, email, 'AGENT');
    const second = await invite(adminA, email, 'ADMIN');
    expect((await preview(first.token)).status).toBe(410);
    expect(problem((await preview(first.token)).body).detail).toMatch(/withdrawn/);
    expect((await preview(second.token)).status).toBe(200);

    const open = await db.invitation.findMany({
      where: { organizationId: orgA.organizationId, email, acceptedAt: null, revokedAt: null },
    });
    expect(open.map((i) => i.id)).toEqual([second.invitation.id]);
    const entry = (await audits(orgA.organizationId, 'invitation.created')).find(
      (a) => a.targetId === second.invitation.id,
    );
    expect(entry?.metadata).toMatchObject({ replacedInvitationId: first.invitation.id });
  });

  it('keeps exactly one open invitation when two are sent to one email at once', async () => {
    const email = uniqueEmail('race-create');
    const results = await Promise.all([
      orgA.client.post('/api/v1/invitations', { email, role: 'AGENT' }),
      adminA.post('/api/v1/invitations', { email, role: 'ADMIN' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const open = await db.invitation.count({
      where: { organizationId: orgA.organizationId, email, acceptedAt: null, revokedAt: null },
    });
    expect(open).toBe(1);
  });

  it('enforces the rules in the database too', async () => {
    const base = {
      organizationId: orgA.organizationId,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await expect(
      db.invitation.create({
        data: { ...base, email: 'Upper@Example.com', tokenHash: crypto.randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      db.invitation.create({
        data: {
          ...base,
          email: 'owner@example.com',
          role: 'OWNER',
          tokenHash: crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow();
    await db.invitation.create({
      data: { ...base, email: 'twice@example.com', tokenHash: crypto.randomUUID() },
    });
    await expect(
      db.invitation.create({
        data: { ...base, email: 'twice@example.com', tokenHash: crypto.randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      db.invitation.create({
        data: {
          ...base,
          email: 'both@example.com',
          tokenHash: crypto.randomUUID(),
          acceptedAt: new Date(),
          revokedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('the invitation link', () => {
  it('previews a valid invitation without a session, and nothing for a bad token', async () => {
    const email = uniqueEmail('preview');
    const { token } = await invite(orgA.client, email, 'ADMIN');
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(invitationPreviewSchema.parse(res.body)).toMatchObject({
      organizationName: 'Org invite-a',
      email,
      role: 'ADMIN',
      invitedByName: 'Owner invite-a',
    });

    const unknown = await preview('B'.repeat(43));
    expect(unknown.status).toBe(410);
    expect(problem(unknown.body)).toMatchObject({ code: 'INVITATION_INVALID' });
    expect(JSON.stringify(unknown.body)).not.toContain('Org invite-a');
    const malformed = await preview('short');
    expect(malformed.status).toBe(400);
  });

  it('signs up a new person with the invited email, once', async () => {
    const email = uniqueEmail('new-person');
    const { invitation, token } = await invite(orgA.client, email, 'ADMIN');
    const res = await registerInvited(token, 'Nadia New');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(sessionCookieFrom(res.headers['set-cookie'])).toBeDefined();
    const session = authSessionSchema.parse(res.body);
    expect(session.user).toMatchObject({ email, name: 'Nadia New' });
    expect(session.activeOrganization).toMatchObject({ id: orgA.organizationId, role: 'ADMIN' });
    expect(session.organizations).toHaveLength(1); // no organization of their own

    const row = await stored(orgA.organizationId, invitation.id);
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedByUserId).toBe(session.user.id);
    const accepted = (await audits(orgA.organizationId, 'invitation.accepted')).find(
      (a) => a.targetId === invitation.id,
    );
    expect(accepted).toMatchObject({
      actorUserId: session.user.id,
      metadata: { email, role: 'ADMIN', newAccount: true },
    });

    // Replay: the link is spent, for sign-up and for acceptance alike.
    const again = await registerInvited(token, 'Someone Else', 'another long password');
    expect(again.status).toBe(410);
    expect(problem(again.body).detail).toMatch(/already been used/);
    expect(await db.user.count({ where: { email } })).toBe(1);
    expect(await membershipCount(orgA.organizationId, email)).toBe(1);
  });

  it('refuses a sign-up for an email that already has an account, leaving the invitation open', async () => {
    const existing = await existingUser('has-account');
    const { invitation, token } = await invite(orgA.client, existing.email);
    const res = await registerInvited(token);
    expect(res.status).toBe(409);
    expect(problem(res.body).code).toBe('EMAIL_TAKEN');
    expect((await stored(orgA.organizationId, invitation.id)).acceptedAt).toBeNull();

    const sameAsEmail = await invite(orgA.client, uniqueEmail('pw'));
    const weak = await registerInvited(sameAsEmail.token, 'Pat', sameAsEmail.invitation.email);
    expect(weak.status).toBe(400);
    expect(problem(weak.body).errors?.map((e) => e.path)).toEqual(['body.password']);
  });

  it('lets an existing user with the invited email accept, rotating their session', async () => {
    const user = await existingUser('joiner');
    const { invitation, token } = await invite(orgA.client, user.email, 'AGENT');
    const res = await accept(user.client, token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const session = authSessionSchema.parse(res.body);
    expect(session.activeOrganization).toMatchObject({ id: orgA.organizationId, role: 'AGENT' });
    expect(session.organizations.map((o) => o.id).sort()).toEqual(
      [orgA.organizationId, user.organizationId].sort(),
    );
    // A new token: joining is a privilege change (rotation itself: tenancy.int.test.ts).
    expect(sessionCookieFrom(res.headers['set-cookie'])).toBeDefined();
    expect(await membershipCount(orgA.organizationId, user.email)).toBe(1);
    expect((await stored(orgA.organizationId, invitation.id)).acceptedByUserId).toBe(user.userId);

    // The new cookie works in the new organization; the link is spent.
    await user.client.get('/api/v1/members').expect(200);
    expect((await accept(user.client, token)).status).toBe(410);
  });

  it('requires a session to accept', async () => {
    const { token } = await invite(orgA.client, uniqueEmail('anon'));
    const res = await accept(browser(app), token);
    expect(res.status).toBe(401);
  });

  it('refuses another account, audits the attempt and keeps the invitation for its owner', async () => {
    const invitee = await existingUser('rightful');
    const intruder = await existingUser('intruder');
    const { invitation, token } = await invite(orgA.client, invitee.email);

    const res = await accept(intruder.client, token);
    expect(res.status).toBe(403);
    expect(problem(res.body).code).toBe('INVITATION_EMAIL_MISMATCH');
    expect(await membershipCount(orgA.organizationId, intruder.email)).toBe(0);
    expect((await stored(orgA.organizationId, invitation.id)).acceptedAt).toBeNull();
    const refused = (await audits(orgA.organizationId, 'invitation.accept_refused')).find(
      (a) => a.targetId === invitation.id,
    );
    expect(refused).toMatchObject({
      actorUserId: intruder.userId,
      metadata: { reason: 'email_mismatch' },
    });

    await accept(invitee.client, token).expect(200);
  });

  it('refuses a user who has meanwhile become a member, keeping one membership', async () => {
    const user = await existingUser('meanwhile');
    const { invitation, token } = await invite(orgA.client, user.email);
    await db.membership.create({
      data: { organizationId: orgA.organizationId, userId: user.userId, role: 'AGENT' },
    });
    const res = await accept(user.client, token);
    expect(res.status).toBe(409);
    expect(problem(res.body).code).toBe('ALREADY_MEMBER');
    expect(await membershipCount(orgA.organizationId, user.email)).toBe(1);
    expect((await stored(orgA.organizationId, invitation.id)).acceptedAt).toBeNull();
  });

  it('stops working when it expires, everywhere', async () => {
    const email = uniqueEmail('expired');
    const { invitation, token } = await invite(orgA.client, email);
    await db.invitation.update({
      where: { id: invitation.id, organizationId: orgA.organizationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    for (const res of [await preview(token), await registerInvited(token)]) {
      expect(res.status).toBe(410);
      expect(problem(res.body).detail).toMatch(/expired/);
    }
    const list = invitationListResponseSchema.parse(
      (await orgA.client.get('/api/v1/invitations').expect(200)).body,
    );
    expect(list.data.find((i) => i.id === invitation.id)?.status).toBe('expired');
    expect(await db.user.count({ where: { email } })).toBe(0);
  });
});

describe('the invitation link, continued', () => {
  it('can’t be accepted by an existing user once expired', async () => {
    const user = await existingUser('expired-accept');
    const { invitation, token } = await invite(orgA.client, user.email);
    await db.invitation.update({
      where: { id: invitation.id, organizationId: orgA.organizationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await accept(user.client, token);
    expect(res.status).toBe(410);
    expect(problem(res.body).detail).toMatch(/expired/);
    expect(await membershipCount(orgA.organizationId, user.email)).toBe(0);
    expect((await stored(orgA.organizationId, invitation.id)).acceptedAt).toBeNull();
  });

  it('revokes the session that accepted it and issues a new one', async () => {
    const user = await existingUser('rotation');
    const client = browser(app);
    const login = await client
      .post('/api/v1/auth/login', { email: user.email, password: PASSWORD })
      .expect(200);
    const before = sessionCookieFrom(login.headers['set-cookie']);
    expect(before).toBeDefined();
    const { token } = await invite(orgA.client, user.email);

    const res = await accept(client, token).expect(200);
    const after = sessionCookieFrom(res.headers['set-cookie']);
    expect(after?.value).toBeDefined();
    expect(after?.value).not.toBe(before?.value);
    // The old cookie no longer works; the new one does, in the new organization.
    const old = await request(app)
      .get('/api/v1/auth/session')
      .set('Cookie', `pd_sid=${before?.value ?? ''}`);
    expect(old.status).toBe(401);
    const current = authSessionSchema.parse(
      (await client.get('/api/v1/auth/session').expect(200)).body,
    );
    expect(current.activeOrganization?.id).toBe(orgA.organizationId);
  });

  it('refuses the link’s endpoints without the web app’s Origin, changing nothing', async () => {
    const user = await existingUser('no-origin');
    const { invitation, token } = await invite(orgA.client, user.email);
    const results = [
      await request(app).post('/api/v1/invitations/preview').send({ token }),
      await user.client.agent.post('/api/v1/invitations/accept').send({ token }),
      await request(app)
        .post('/api/v1/invitations/register')
        .send({ token, name: 'No Origin', password: PASSWORD }),
    ];
    for (const res of results) {
      expect(res.status).toBe(403);
      expect(problem(res.body).code).toBe('CSRF_ORIGIN_MISMATCH');
    }
    expect((await stored(orgA.organizationId, invitation.id)).acceptedAt).toBeNull();
    expect(await membershipCount(orgA.organizationId, user.email)).toBe(0);
  });

  it('rate limits failed uses of links per IP, not successful ones', async () => {
    const limited = buildIntegrationApp(db, { RATE_LIMIT_AUTH_PER_15_MINUTES: '3' }).app;
    const { token } = await invite(orgA.client, uniqueEmail('limited'));
    const previewOn = (value: string) =>
      browser(limited).post('/api/v1/invitations/preview', { token: value });
    // Successes don't count…
    for (let i = 0; i < 5; i++) expect((await previewOn(token)).status).toBe(200);
    // …failures do.
    for (let i = 0; i < 3; i++) expect((await previewOn('C'.repeat(43))).status).toBe(410);
    const blocked = await previewOn('C'.repeat(43));
    expect(blocked.status).toBe(429);
    expect(problem(blocked.body).code).toBe('RATE_LIMITED');
  });
});

describe('invitations of a member who loses the right to invite', () => {
  function revokedAudit(invitationId: string) {
    return db.auditLog.findFirst({
      where: {
        organizationId: orgA.organizationId,
        action: 'invitation.revoked',
        targetId: invitationId,
      },
    });
  }

  it('are revoked when the inviter is removed, so they can’t rejoin through them', async () => {
    const admin = await addMember(db, orgA.organizationId, 'ADMIN', 'h1-removed');
    const adminClient = await signIn(app, admin.email);
    // Another account of theirs, invited as admin before they were removed.
    const alt = await existingUser('h1-alt');
    const own = await invite(adminClient, alt.email, 'ADMIN');
    const others = await invite(adminA, uniqueEmail('h1-others'));

    await orgA.client.delete(`/api/v1/members/${admin.userId}`).expect(204);

    const res = await accept(alt.client, own.token);
    expect(res.status).toBe(410);
    expect(problem(res.body).detail).toMatch(/withdrawn/);
    expect(await membershipCount(orgA.organizationId, alt.email)).toBe(0);
    expect((await stored(orgA.organizationId, own.invitation.id)).revokedAt).not.toBeNull();
    expect(await revokedAudit(own.invitation.id)).toMatchObject({
      actorUserId: orgA.userId,
      metadata: { email: alt.email, role: 'ADMIN', reason: 'inviter_removed' },
    });
    // Other admins' invitations are untouched.
    expect((await stored(orgA.organizationId, others.invitation.id)).revokedAt).toBeNull();
    expect((await preview(others.token)).status).toBe(200);
  });

  it('are revoked when an admin is demoted to agent', async () => {
    const admin = await addMember(db, orgA.organizationId, 'ADMIN', 'h1-demoted');
    const adminClient = await signIn(app, admin.email);
    const sent = await invite(adminClient, uniqueEmail('h1-demoted-invitee'), 'ADMIN');

    await orgA.client.patch(`/api/v1/members/${admin.userId}`, { role: 'AGENT' }).expect(200);

    expect((await preview(sent.token)).status).toBe(410);
    expect(await revokedAudit(sent.invitation.id)).toMatchObject({
      metadata: { reason: 'inviter_demoted' },
    });
  });

  it('survive an owner becoming an admin, who can still invite', async () => {
    const owner = await addMember(db, orgA.organizationId, 'OWNER', 'h1-owner');
    const ownerClient = await signIn(app, owner.email);
    const sent = await invite(ownerClient, uniqueEmail('h1-owner-invitee'));

    await orgA.client.patch(`/api/v1/members/${owner.userId}`, { role: 'ADMIN' }).expect(200);

    expect((await preview(sent.token)).status).toBe(200);
    expect(await revokedAudit(sent.invitation.id)).toBeNull();
  });

  it('keeps a membership gained through an invitation accepted before the inviter left', async () => {
    const admin = await addMember(db, orgA.organizationId, 'ADMIN', 'h1-earlier');
    const adminClient = await signIn(app, admin.email);
    const joiner = await existingUser('h1-joiner');
    const { token } = await invite(adminClient, joiner.email);
    await accept(joiner.client, token).expect(200);

    await orgA.client.delete(`/api/v1/members/${admin.userId}`).expect(204);
    expect(await membershipCount(orgA.organizationId, joiner.email)).toBe(1);
  });
});

describe('revoking invitations', () => {
  it('revokes once, with one audit entry, after which the link is dead', async () => {
    const { invitation, token } = await invite(orgA.client, uniqueEmail('revoke'));
    await adminA.delete(`/api/v1/invitations/${invitation.id}`).expect(204);
    await adminA.delete(`/api/v1/invitations/${invitation.id}`).expect(204); // no-op
    const entries = (await audits(orgA.organizationId, 'invitation.revoked')).filter(
      (a) => a.targetId === invitation.id,
    );
    expect(entries).toHaveLength(1);
    expect((await preview(token)).status).toBe(410);
    expect((await registerInvited(token)).status).toBe(410);
    const list = invitationListResponseSchema.parse(
      (await orgA.client.get('/api/v1/invitations').expect(200)).body,
    );
    expect(list.data.map((i) => i.id)).not.toContain(invitation.id);
  });

  it('can’t revoke an accepted invitation or another organization’s', async () => {
    const accepted = await invite(orgA.client, uniqueEmail('accepted'));
    await registerInvited(accepted.token).expect(201);
    const res = await orgA.client.delete(`/api/v1/invitations/${accepted.invitation.id}`);
    expect(res.status).toBe(409);

    const mine = await invite(orgA.client, uniqueEmail('mine'));
    const foreign = await orgB.client.delete(`/api/v1/invitations/${mine.invitation.id}`);
    expect(foreign.status).toBe(404);
    expect((await stored(orgA.organizationId, mine.invitation.id)).revokedAt).toBeNull();
    const missing = await orgB.client.delete(`/api/v1/invitations/${crypto.randomUUID()}`);
    // Another organization's invitation is answered exactly like one that doesn't exist.
    expect(missing.status).toBe(404);
    expect(problem(foreign.body).detail).toBe(problem(missing.body).detail);
    expect((await orgA.client.delete('/api/v1/invitations/not-a-uuid')).status).toBe(400);
  });

  it('lets an acceptance and a revocation race without both winning', async () => {
    const user = await existingUser('race-revoke');
    const { invitation, token } = await invite(orgA.client, user.email);
    const [accepted, revoked] = await Promise.all([
      accept(user.client, token),
      orgA.client.delete(`/api/v1/invitations/${invitation.id}`),
    ]);
    const row = await stored(orgA.organizationId, invitation.id);
    const members = await membershipCount(orgA.organizationId, user.email);
    if (accepted.status === 200) {
      expect(revoked.status).toBe(409);
      expect(row).toMatchObject({ revokedAt: null });
      expect(members).toBe(1);
    } else {
      expect(accepted.status).toBe(410);
      expect(revoked.status).toBe(204);
      expect(row.acceptedAt).toBeNull();
      expect(members).toBe(0);
    }
  });
});

describe('concurrent acceptance', () => {
  it('accepts once when one user accepts from two sessions at the same time', async () => {
    const user = await existingUser('race-accept');
    const second = await signIn(app, user.email);
    const { token } = await invite(orgA.client, user.email);
    const results = await Promise.all([accept(user.client, token), accept(second, token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(await membershipCount(orgA.organizationId, user.email)).toBe(1);
    expect(
      (await audits(orgA.organizationId, 'invitation.accepted')).filter(
        (a) => a.actorUserId === user.userId,
      ),
    ).toHaveLength(1);
  });

  it('creates one account when the same link is used to sign up twice at once', async () => {
    const email = uniqueEmail('race-register');
    const { token } = await invite(orgA.client, email);
    const results = await Promise.all([
      registerInvited(token, 'First'),
      registerInvited(token, 'Second'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    expect(await db.user.count({ where: { email } })).toBe(1);
    expect(await membershipCount(orgA.organizationId, email)).toBe(1);
  });
});

describe('re-inviting while the previous invitation is being accepted', () => {
  it('answers ALREADY_MEMBER instead of failing, and never ends an invitation twice', async () => {
    const user = await existingUser('reinvite-race');
    const { invitation } = await invite(orgA.client, user.email);

    // Play the acceptance by hand: hold the invitation's row lock, as acceptance does…
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const acceptance = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${orgA.organizationId}::uuid FOR KEY SHARE`;
        await tx.$queryRaw`SELECT 1 FROM "Invitation" WHERE "id" = ${invitation.id}::uuid FOR UPDATE`;
        locked();
        await gate;
        await tx.membership.create({
          data: { organizationId: orgA.organizationId, userId: user.userId, role: 'AGENT' },
        });
        await tx.invitation.update({
          where: { id: invitation.id, organizationId: orgA.organizationId },
          data: { acceptedAt: new Date(), acceptedByUserId: user.userId },
        });
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    await holding;

    // …start the re-invite and wait until it is blocked on that row…
    const reinvite = orgA.client
      .post('/api/v1/invitations', { email: user.email, role: 'ADMIN' })
      .then((res) => res);
    for (let waited = 0; ; waited += 50) {
      const [row] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE 'UPDATE%Invitation%'`;
      if ((row?.n ?? 0) > 0) break;
      if (waited > 10_000) throw new Error('The re-invite never waited for the acceptance');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // …then let the acceptance commit.
    release();
    await acceptance;
    const res = await reinvite;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(problem(res.body).code).toBe('ALREADY_MEMBER');

    const rows = await db.invitation.findMany({
      where: { organizationId: orgA.organizationId, email: user.email },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revokedAt: null, acceptedByUserId: user.userId });
    expect(await membershipCount(orgA.organizationId, user.email)).toBe(1);
  });
});

describe('changes to one’s own membership', () => {
  it('lets an admin step down or leave, but never promote themselves', async () => {
    const admin = await addMember(db, orgA.organizationId, 'ADMIN', 'self-admin');
    const client = await signIn(app, admin.email);
    const promote = await client.patch(`/api/v1/members/${admin.userId}`, { role: 'OWNER' });
    expect(promote.status).toBe(403);

    // A role change to the same role is a no-op: nothing is audited.
    const audited = () =>
      db.auditLog.count({ where: { organizationId: orgA.organizationId, targetId: admin.userId } });
    const before = await audited();
    await client.patch(`/api/v1/members/${admin.userId}`, { role: 'ADMIN' }).expect(200);
    expect(await audited()).toBe(before);

    await client.patch(`/api/v1/members/${admin.userId}`, { role: 'AGENT' }).expect(200);
    // The new role applies to the very next request.
    expect((await client.get('/api/v1/invitations')).status).toBe(403);
    expect(await audited()).toBe(before + 1);
  });

  it('keeps the last owner, even against themselves', async () => {
    const solo = await registerOwner(app, 'solo-owner');
    const demote = await solo.client.patch(`/api/v1/members/${solo.userId}`, { role: 'ADMIN' });
    expect(problem(demote.body).code).toBe('LAST_OWNER');
    const leave = await solo.client.delete(`/api/v1/members/${solo.userId}`);
    expect(problem(leave.body).code).toBe('LAST_OWNER');
  });

  it('cuts a removed member off from that organization only, keeping their other sessions', async () => {
    const user = await existingUser('removed');
    const { token } = await invite(orgA.client, user.email);
    await accept(user.client, token).expect(200);
    await user.client.get('/api/v1/members').expect(200);

    await orgA.client.delete(`/api/v1/members/${user.userId}`).expect(204);
    const after = await user.client.get('/api/v1/members');
    expect(after.status).toBe(403);
    expect(problem(after.body).code).toBe('NO_ACTIVE_ORGANIZATION');
    // Still signed in, and still a member of their own organization.
    const session = authSessionSchema.parse(
      (await user.client.get('/api/v1/auth/session').expect(200)).body,
    );
    expect(session.organizations.map((o) => o.id)).toEqual([user.organizationId]);
    await user.client
      .post('/api/v1/auth/active-organization', { organizationId: user.organizationId })
      .expect(200);
    await user.client.get('/api/v1/members').expect(200);
  });
});
