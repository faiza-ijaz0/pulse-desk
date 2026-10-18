import { authSessionSchema, problemDetailsSchema } from '@pulsedesk/shared';
import type { Database } from '@pulsedesk/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../../src/modules/auth/session-token.ts';
import { TEST_ENV_DEFAULTS, WEB_ORIGIN } from '../helpers.ts';
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

function registration(email = uniqueEmail('reg')) {
  return { name: 'Grace Hopper', email, password: PASSWORD, organizationName: 'Compiler Co' };
}

function problemCode(body: unknown) {
  return problemDetailsSchema.parse(body).code;
}

describe('POST /api/v1/auth/register', () => {
  it('creates the user, their organization and an OWNER membership, and signs them in', async () => {
    const client = browser(app);
    const email = uniqueEmail('Mixed.Case');
    const res = await client
      .post('/api/v1/auth/register', { ...registration(), email: `  ${email.toUpperCase()} ` })
      .expect(201);

    const session = authSessionSchema.parse(res.body);
    expect(session.user).toMatchObject({ name: 'Grace Hopper', email: email.toLowerCase() });
    expect(session.activeOrganization).toMatchObject({ name: 'Compiler Co', role: 'OWNER' });
    expect(session.activeOrganization?.slug).toMatch(/^compiler-co-[0-9a-f]{6}$/);
    expect(session.organizations).toEqual([session.activeOrganization]);

    const membership = await db.membership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: session.activeOrganization!.id,
          userId: session.user.id,
        },
      },
    });
    expect(membership?.role).toBe('OWNER');

    const audit = await db.auditLog.findMany({
      where: { organizationId: session.activeOrganization!.id },
    });
    expect(audit.map((a) => a.action)).toEqual(['organization.created']);
    expect(audit[0]?.requestId).toBe(res.headers['x-request-id']);

    // The new session works immediately.
    const me = await client.get('/api/v1/auth/session').expect(200);
    expect(authSessionSchema.parse(me.body).user.id).toBe(session.user.id);
  });

  it('stores an Argon2id hash, never the plaintext password', async () => {
    const body = registration();
    await browser(app).post('/api/v1/auth/register', body).expect(201);

    const user = await db.user.findUniqueOrThrow({ where: { email: body.email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it('sets an HttpOnly, SameSite=Lax, host-only session cookie whose token is stored only as an HMAC', async () => {
    const res = await browser(app).post('/api/v1/auth/register', registration()).expect(201);

    const cookie = sessionCookieFrom(res.headers['set-cookie']);
    expect(cookie).toBeDefined();
    const { header, value } = cookie!;
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\//);
    expect(header).not.toMatch(/; Domain=/i);
    // 14 days, computed a few milliseconds after expiresAt was set.
    const maxAge = Number(/; Max-Age=(\d+)/.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThan(14 * 24 * 3600 - 60);
    expect(maxAge).toBeLessThanOrEqual(14 * 24 * 3600);
    expect(header).not.toMatch(/; Secure/); // SESSION_COOKIE_SECURE=false in tests
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const user = authSessionSchema.parse(res.body).user;
    const sessions = await db.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(hashSessionToken(TEST_ENV_DEFAULTS.SESSION_SECRET, value));
    expect(JSON.stringify(sessions)).not.toContain(value);
    // The token never appears in the response body either.
    expect(JSON.stringify(res.body)).not.toContain(value);
  });

  it('rejects a duplicate email (case-insensitively) without creating anything', async () => {
    const body = registration();
    await browser(app).post('/api/v1/auth/register', body).expect(201);
    const orgsBefore = await db.organization.count();

    const res = await browser(app)
      .post('/api/v1/auth/register', { ...body, email: body.email.toUpperCase() })
      .expect(409);

    expect(problemCode(res.body)).toBe('EMAIL_TAKEN');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await db.user.count({ where: { email: body.email } })).toBe(1);
    expect(await db.organization.count()).toBe(orgsBefore);
  });

  it('lets exactly one of two simultaneous registrations for the same email succeed', async () => {
    const body = registration();
    const results = await Promise.all([
      browser(app).post('/api/v1/auth/register', body),
      browser(app).post('/api/v1/auth/register', { ...body, organizationName: 'Second Co' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(problemCode(conflict.body)).toBe('EMAIL_TAKEN');
    expect(await db.user.count({ where: { email: body.email } })).toBe(1);
  });

  it('returns field-level validation errors', async () => {
    const res = await browser(app)
      .post('/api/v1/auth/register', {
        name: '',
        email: 'nope',
        password: 'short',
        organizationName: '',
      })
      .expect(400);

    const problem = problemDetailsSchema.parse(res.body);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((e) => e.path).sort()).toEqual([
      'body.email',
      'body.name',
      'body.organizationName',
      'body.password',
    ]);
  });

  it('ignores a client-supplied role or organization', async () => {
    const owner = await registerOwner(app, 'victim');
    const body = registration();
    const res = await browser(app)
      .post('/api/v1/auth/register', {
        ...body,
        organizationId: owner.organizationId,
        role: 'ADMIN',
      })
      .expect(201);

    const session = authSessionSchema.parse(res.body);
    expect(session.activeOrganization?.id).not.toBe(owner.organizationId);
    expect(session.organizations).toHaveLength(1);
    expect(await db.membership.count({ where: { organizationId: owner.organizationId } })).toBe(1);
  });

  it('rejects cross-site requests (CSRF Origin check)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', 'https://evil.example')
      .send(registration())
      .expect(403);
    expect(problemCode(res.body)).toBe('CSRF_ORIGIN_MISMATCH');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('signs in with the right password and issues a fresh token each time', async () => {
    const owner = await registerOwner(app, 'login');
    const first = await browser(app)
      .post('/api/v1/auth/login', { email: owner.email.toUpperCase(), password: PASSWORD })
      .expect(200);
    const second = await browser(app)
      .post('/api/v1/auth/login', { email: owner.email, password: PASSWORD })
      .expect(200);

    const session = authSessionSchema.parse(first.body);
    expect(session.user.id).toBe(owner.userId);
    expect(session.activeOrganization).toMatchObject({ id: owner.organizationId, role: 'OWNER' });
    expect(sessionCookieFrom(first.headers['set-cookie'])?.value).not.toBe(
      sessionCookieFrom(second.headers['set-cookie'])?.value,
    );
  });

  it('gives the same generic answer for a wrong password and an unknown email', async () => {
    const owner = await registerOwner(app, 'generic');
    const wrongPassword = await browser(app)
      .post('/api/v1/auth/login', { email: owner.email, password: 'not-the-password' })
      .expect(401);
    const unknownEmail = await browser(app)
      .post('/api/v1/auth/login', { email: uniqueEmail('ghost'), password: PASSWORD })
      .expect(401);

    const strip = (body: unknown) => {
      const { requestId: _r, instance: _i, ...rest } = problemDetailsSchema.parse(body);
      return rest;
    };
    expect(strip(wrongPassword.body)).toEqual(strip(unknownEmail.body));
    expect(strip(wrongPassword.body)).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      detail: 'Incorrect email or password.',
    });
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('replaces a session cookie the browser already had (no session fixation)', async () => {
    const owner = await registerOwner(app, 'fixation');
    const before = await db.session.findFirstOrThrow({ where: { userId: owner.userId } });

    await owner.client.post('/api/v1/auth/login', { email: owner.email, password: PASSWORD });

    const old = await db.session.findUniqueOrThrow({ where: { id: before.id } });
    expect(old.revokedAt).not.toBeNull();
    await owner.client.get('/api/v1/auth/session').expect(200);
  });
});

describe('sessions', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/v1/auth/session').expect(401);
    expect(problemCode(res.body)).toBe('UNAUTHENTICATED');
  });

  it('rejects forged and unknown tokens, and clears the cookie', async () => {
    for (const token of ['forged', 'A'.repeat(43)]) {
      const res = await request(app)
        .get('/api/v1/auth/session')
        .set('Cookie', `pd_sid=${token}`)
        .expect(401);
      expect(sessionCookieFrom(res.headers['set-cookie'])?.header).toMatch(
        /Expires=Thu, 01 Jan 1970/,
      );
    }
  });

  it('ends a session at its absolute expiry', async () => {
    const owner = await registerOwner(app, 'expired');
    await db.session.updateMany({
      where: { userId: owner.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await owner.client.get('/api/v1/auth/session').expect(401);
  });

  it('ends a session after the idle timeout', async () => {
    const owner = await registerOwner(app, 'idle');
    await db.session.updateMany({
      where: { userId: owner.userId },
      data: { lastSeenAt: new Date(Date.now() - 13 * 60 * 60 * 1000) }, // idle limit is 12h
    });
    await owner.client.get('/api/v1/auth/session').expect(401);
  });

  it('records activity at most once a minute', async () => {
    const owner = await registerOwner(app, 'touch');
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    await db.session.updateMany({ where: { userId: owner.userId }, data: { lastSeenAt: stale } });

    await owner.client.get('/api/v1/auth/session').expect(200);
    const touched = await db.session.findFirstOrThrow({ where: { userId: owner.userId } });
    expect(touched.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime());

    await owner.client.get('/api/v1/auth/session').expect(200);
    const again = await db.session.findFirstOrThrow({ where: { userId: owner.userId } });
    expect(again.lastSeenAt).toEqual(touched.lastSeenAt);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session server-side, so a copied cookie stops working', async () => {
    const owner = await registerOwner(app, 'logout');
    await owner.client.get('/api/v1/auth/session').expect(200);

    const stored = await db.session.findFirstOrThrow({ where: { userId: owner.userId } });
    const res = await owner.client.post('/api/v1/auth/logout').expect(204);
    expect(sessionCookieFrom(res.headers['set-cookie'])?.header).toMatch(
      /Expires=Thu, 01 Jan 1970/,
    );

    const revoked = await db.session.findUniqueOrThrow({ where: { id: stored.id } });
    expect(revoked.revokedAt).not.toBeNull();
    await owner.client.get('/api/v1/auth/session').expect(401);
  });

  it('rejects a replayed token after logout', async () => {
    const email = uniqueEmail('replay');
    const register = await browser(app)
      .post('/api/v1/auth/register', registration(email))
      .expect(201);
    const token = sessionCookieFrom(register.headers['set-cookie'])!.value;

    await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', `pd_sid=${token}`)
      .expect(204);
    await request(app).get('/api/v1/auth/session').set('Cookie', `pd_sid=${token}`).expect(401);
  });

  it('is idempotent without a session', async () => {
    await browser(app).post('/api/v1/auth/logout').expect(204);
  });

  it('only revokes the current session, not the user’s other devices', async () => {
    const owner = await registerOwner(app, 'devices');
    const laptop = await signIn(app, owner.email);
    await owner.client.post('/api/v1/auth/logout').expect(204);
    await laptop.get('/api/v1/auth/session').expect(200);
  });
});

describe('cookie configuration', () => {
  it('marks the cookie Secure under the production-style __Host- name', async () => {
    const secureApp = buildIntegrationApp(db, {
      SESSION_COOKIE_NAME: '__Host-pd_sid',
      SESSION_COOKIE_SECURE: 'true',
    }).app;
    const res = await browser(secureApp).post('/api/v1/auth/register', registration()).expect(201);

    const cookie = sessionCookieFrom(res.headers['set-cookie'], '__Host-pd_sid');
    expect(cookie?.header).toMatch(/; Secure/);
    expect(cookie?.header).toMatch(/; Path=\//);
    expect(cookie?.header).not.toMatch(/; Domain=/i);
  });
});

describe('logging', () => {
  it('never writes passwords, password hashes or session tokens to the logs', async () => {
    const { app: loggedApp, logs } = buildIntegrationApp(db);
    const email = uniqueEmail('logs');
    const register = await browser(loggedApp)
      .post('/api/v1/auth/register', registration(email))
      .expect(201);
    const token = sessionCookieFrom(register.headers['set-cookie'])!.value;
    await browser(loggedApp)
      .post('/api/v1/auth/login', { email, password: 'wrong-password-attempt' })
      .expect(401);
    await request(loggedApp).get('/api/v1/auth/session').set('Cookie', `pd_sid=${token}`);

    const text = logs.text();
    expect(text).toContain('Account registered');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('wrong-password-attempt');
    expect(text).not.toContain(token);
    expect(text).not.toContain('$argon2id$');
  });
});

describe('auth rate limiting', () => {
  it('limits failed logins per target email, even when spread across client IPs', async () => {
    const { app: limited } = buildIntegrationApp(db, {
      RATE_LIMIT_AUTH_PER_15_MINUTES: '3',
      TRUST_PROXY_HOPS: '1',
    });
    const victim = await addMember(
      db,
      (await registerOwner(app, 'rl-org')).organizationId,
      'AGENT',
    );

    for (let i = 0; i < 3; i++) {
      await browser(limited)
        .post('/api/v1/auth/login', { email: victim.email, password: 'guess' })
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        .expect(401);
    }
    const blocked = await browser(limited)
      .post('/api/v1/auth/login', { email: victim.email, password: PASSWORD })
      .set('X-Forwarded-For', '203.0.113.99');
    expect(blocked.status).toBe(429);
    expect(problemCode(blocked.body)).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('limits failed logins per client IP across different emails', async () => {
    const { app: limited } = buildIntegrationApp(db, { RATE_LIMIT_AUTH_PER_15_MINUTES: '3' });
    for (let i = 0; i < 3; i++) {
      await browser(limited)
        .post('/api/v1/auth/login', { email: uniqueEmail(`spray${i}`), password: 'guess' })
        .expect(401);
    }
    await browser(limited)
      .post('/api/v1/auth/login', { email: uniqueEmail('spray-next'), password: 'guess' })
      .expect(429);
  });

  it('does not count successful sign-ins', async () => {
    const { app: limited } = buildIntegrationApp(db, { RATE_LIMIT_AUTH_PER_15_MINUTES: '2' });
    const owner = await registerOwner(app, 'rl-ok');
    for (let i = 0; i < 4; i++) {
      await browser(limited)
        .post('/api/v1/auth/login', { email: owner.email, password: PASSWORD })
        .expect(200);
    }
  });

  it('limits registrations per IP and ignores spoofed X-Forwarded-For without a trusted proxy', async () => {
    const { app: limited } = buildIntegrationApp(db, { RATE_LIMIT_AUTH_PER_15_MINUTES: '2' });
    for (let i = 0; i < 2; i++) {
      await browser(limited)
        .post('/api/v1/auth/register', registration())
        .set('X-Forwarded-For', `198.51.100.${i + 1}`)
        .expect(201);
    }
    await browser(limited)
      .post('/api/v1/auth/register', registration())
      .set('X-Forwarded-For', '198.51.100.77')
      .expect(429);
  });

  it('keys limits on the forwarded client IP behind a trusted proxy', async () => {
    const { app: proxied } = buildIntegrationApp(db, {
      RATE_LIMIT_AUTH_PER_15_MINUTES: '1',
      TRUST_PROXY_HOPS: '1',
    });
    await browser(proxied)
      .post('/api/v1/auth/register', registration())
      .set('X-Forwarded-For', '192.0.2.10')
      .expect(201);
    await browser(proxied)
      .post('/api/v1/auth/register', registration())
      .set('X-Forwarded-For', '192.0.2.10')
      .expect(429);
    // A different client behind the same proxy has its own budget.
    await browser(proxied)
      .post('/api/v1/auth/register', registration())
      .set('X-Forwarded-For', '192.0.2.20')
      .expect(201);
  });
});
