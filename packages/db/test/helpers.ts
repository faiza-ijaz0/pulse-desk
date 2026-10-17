import { randomUUID } from 'node:crypto';
import { createPrismaClient, type Database } from '../src/client.ts';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return url;
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
