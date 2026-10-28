import { randomUUID } from 'node:crypto';
import { createPrismaClient, loadWorkspaceEnv, type Database, type Role } from '@pulsedesk/db';
import { assertSafeTestDatabase } from '@pulsedesk/db/testing';
import request from 'supertest';
import { createApiRouter } from '../../src/api-router.ts';
import { createApp } from '../../src/app.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { hashPassword } from '../../src/modules/auth/password.ts';
import { WEB_ORIGIN, captureLogs, testEnv } from '../helpers.ts';

loadWorkspaceEnv();

/** Every user created by these suites has an address on this domain; cleanup keys off it. */
export const TEST_EMAIL_DOMAIN = 'int.pulsedesk.test';
export const PASSWORD = 'integration-test-password';

/** The test database, after the same safety check the reset applies (these tests write to it). */
export function testDatabaseUrl(): string {
  return assertSafeTestDatabase(process.env).url;
}

/** A real client against the test database, with the tenant guard on (as in development). */
export function createTestDb(): Database {
  return createPrismaClient({ connectionString: testDatabaseUrl(), tenantGuard: true });
}

/**
 * The production composition (createApp + createApiRouter) against real PostgreSQL. The auth
 * rate limit is raised unless a test sets it, because every supertest request comes from
 * one IP; the dedicated rate-limit tests lower it again.
 */
export function buildIntegrationApp(db: Database, env: Record<string, string> = {}) {
  const parsed = testEnv({
    DATABASE_URL: testDatabaseUrl(),
    RATE_LIMIT_AUTH_PER_15_MINUTES: '1000',
    ...env,
  });
  const logs = captureLogs();
  const logger = createLogger({ level: 'info', version: 'test', destination: logs.stream });
  const clock = { now: () => new Date() };
  const app = createApp({
    env: parsed,
    logger,
    clock,
    apiRouter: createApiRouter({ env: parsed, db, logger, clock }),
  });
  return { app, logs, env: parsed };
}

export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`;
}

type App = ReturnType<typeof buildIntegrationApp>['app'];

/** A cookie-keeping client that sends the trusted Origin on every request, like the web app. */
export function browser(app: App) {
  const agent = request.agent(app);
  return {
    agent,
    get: (path: string) => agent.get(path).set('Origin', WEB_ORIGIN),
    post: (path: string, body?: object) => {
      const req = agent.post(path).set('Origin', WEB_ORIGIN);
      return body === undefined ? req : req.send(body);
    },
    patch: (path: string, body: object) => agent.patch(path).set('Origin', WEB_ORIGIN).send(body),
    put: (path: string) => agent.put(path).set('Origin', WEB_ORIGIN),
    delete: (path: string) => agent.delete(path).set('Origin', WEB_ORIGIN),
  };
}

export type Browser = ReturnType<typeof browser>;

export type RegisteredOwner = {
  client: Browser;
  email: string;
  userId: string;
  organizationId: string;
};

/** Registers through the real endpoint and returns a signed-in client. */
export async function registerOwner(app: App, label: string): Promise<RegisteredOwner> {
  const client = browser(app);
  const email = uniqueEmail(label);
  const res = await client
    .post('/api/v1/auth/register', {
      name: `Owner ${label}`,
      email,
      password: PASSWORD,
      organizationName: `Org ${label}`,
    })
    .expect(201);
  const body = res.body as { user: { id: string }; activeOrganization: { id: string } };
  return { client, email, userId: body.user.id, organizationId: body.activeOrganization.id };
}

let passwordHash: Promise<string> | undefined;

/** Creates a user directly in the database and adds them to an organization. */
export async function addMember(
  db: Database,
  organizationId: string,
  role: Role,
  label: string = role,
) {
  passwordHash ??= hashPassword(PASSWORD);
  const email = uniqueEmail(label.toLowerCase());
  const user = await db.user.create({
    data: { email, name: `Member ${label}`, passwordHash: await passwordHash },
  });
  await db.membership.create({ data: { organizationId, userId: user.id, role } });
  return { userId: user.id, email };
}

/** Signs in through the real endpoint and returns the client holding the session cookie. */
export async function signIn(app: App, email: string): Promise<Browser> {
  const client = browser(app);
  await client.post('/api/v1/auth/login', { email, password: PASSWORD }).expect(200);
  return client;
}

/** The raw value of the session cookie in a Set-Cookie response header. */
export function sessionCookieFrom(setCookie: string[] | string | undefined, name = 'pd_sid') {
  const header = [setCookie ?? []].flat().find((c) => c.startsWith(`${name}=`));
  if (!header) return undefined;
  return { header, value: header.slice(name.length + 1).split(';')[0] ?? '' };
}

/** Deletes every organization and user created by these suites. */
export async function cleanupTestData(db: Database): Promise<void> {
  const domain = { endsWith: `@${TEST_EMAIL_DOMAIN}` };
  await db.organization.deleteMany({
    where: { memberships: { some: { user: { email: domain } } } },
  });
  await db.user.deleteMany({ where: { email: domain } });
}
