import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.ts';
import { loadWorkspaceEnv } from '../src/env.ts';
import { SEED_ORGANIZATIONS, SEED_USERS } from '../src/seed/data.ts';
import { seedDatabase } from '../src/seed/seed.ts';
import { createTestClient } from './helpers.ts';

loadWorkspaceEnv();

let db: Database;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('development seed', () => {
  it('is repeatable: running it twice converges on the same data', async () => {
    const first = await seedDatabase(db, { passwordHash: 'not-a-real-hash' });
    const second = await seedDatabase(db, { passwordHash: 'not-a-real-hash' });

    expect(second).toEqual(first);
    expect(first.organizations).toBe(2);

    const orgs = await db.organization.findMany({
      where: { slug: { in: SEED_ORGANIZATIONS.map((o) => o.slug) } },
    });
    expect(orgs).toHaveLength(2);
    expect(await db.user.count({ where: { email: { in: SEED_USERS.map((u) => u.email) } } })).toBe(
      SEED_USERS.length,
    );
  });

  it('keeps each organization’s tickets inside that organization', async () => {
    await seedDatabase(db, { passwordHash: 'not-a-real-hash' });

    for (const seedOrg of SEED_ORGANIZATIONS) {
      const org = await db.organization.findUniqueOrThrow({ where: { slug: seedOrg.slug } });
      const tickets = await db.ticket.findMany({
        where: { organizationId: org.id },
        include: { customer: true, messages: true },
      });

      expect(tickets).toHaveLength(seedOrg.tickets.length);
      expect(org.ticketSequence).toBe(seedOrg.tickets.length);
      for (const ticket of tickets) {
        expect(ticket.customer.organizationId).toBe(org.id);
        expect(ticket.messages.every((m) => m.organizationId === org.id)).toBe(true);
      }
    }
  });

  it('gives the multi-org user a different role in each organization', async () => {
    await seedDatabase(db, { passwordHash: 'not-a-real-hash' });
    const riley = await db.user.findUniqueOrThrow({
      where: { email: 'riley@pulsedesk.test' },
      include: { memberships: { include: { organization: true } } },
    });

    const roles = Object.fromEntries(riley.memberships.map((m) => [m.organization.slug, m.role]));
    expect(roles).toEqual({ brightwave: 'AGENT', kestrel: 'ADMIN' });
  });
});
