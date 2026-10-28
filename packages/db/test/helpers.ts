import { randomUUID } from 'node:crypto';
import { createPrismaClient, type Database } from '../src/client.ts';
import { assertSafeTestDatabase } from '../src/test-database-target.ts';

/** The test database, after the same safety check the reset applies (these tests write to it). */
export function testDatabaseUrl(): string {
  return assertSafeTestDatabase(process.env).url;
}

export function createTestClient(options: { tenantGuard?: boolean } = {}): Database {
  return createPrismaClient({
    connectionString: testDatabaseUrl(),
    tenantGuard: options.tenantGuard ?? true,
  });
}

/** Creates an organization with one customer, with a unique slug so tests never collide. */
export async function createOrgWithCustomer(db: Database, label: string) {
  const organization = await db.organization.create({
    data: { name: `Test ${label}`, slug: `test-${label}-${randomUUID().slice(0, 8)}` },
  });
  const customer = await db.customer.create({
    data: { organizationId: organization.id, email: `${label}@example.com`, name: label },
  });
  return { organization, customer };
}
