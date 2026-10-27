import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkspaceEnv } from '../src/env.ts';
import { prismaErrorCode } from '../src/errors.ts';
import { TenantScopeViolationError } from '../src/tenant-guard.ts';
import type { Database } from '../src/client.ts';
import { createOrgWithCustomer, createTestClient } from './helpers.ts';

loadWorkspaceEnv();

let db: Database;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { slug: { startsWith: 'test-' } } });
  await db.$disconnect();
});

describe('tenant isolation constraints (real PostgreSQL)', () => {
  it('rejects a ticket that references another organization’s customer', async () => {
    const a = await createOrgWithCustomer(db, 'iso-a');
    const b = await createOrgWithCustomer(db, 'iso-b');

    await expect(
      db.ticket.create({
        data: {
          organizationId: a.organization.id,
          number: 1,
          subject: 'Cross-tenant reference',
          customerId: b.customer.id,
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('rejects assigning a ticket to a user who is not a member of the ticket’s organization', async () => {
    const a = await createOrgWithCustomer(db, 'assign-a');
    const b = await createOrgWithCustomer(db, 'assign-b');
    const outsider = await db.user.create({
      data: {
        email: `outsider-${b.organization.slug}@example.com`,
        name: 'Outsider',
        passwordHash: 'x',
      },
    });
    await db.membership.create({
      data: { organizationId: b.organization.id, userId: outsider.id, role: 'AGENT' },
    });

    await expect(
      db.ticket.create({
        data: {
          organizationId: a.organization.id,
          number: 1,
          subject: 'Assign across tenants',
          customerId: a.customer.id,
          assigneeUserId: outsider.id,
        },
      }),
    ).rejects.toThrow(/foreign key/i);

    await db.user.delete({ where: { id: outsider.id } });
  });

  it('blocks the tenant guard from running unscoped queries against the real client', async () => {
    await expect(db.ticket.findMany()).rejects.toThrow(TenantScopeViolationError);
  });
});

describe('referential actions', () => {
  it('deletes an organization and all of its tenant data in one statement', async () => {
    const { organization, customer } = await createOrgWithCustomer(db, 'cascade');
    const ticket = await db.ticket.create({
      data: {
        organizationId: organization.id,
        number: 1,
        subject: 'Cascade me',
        customerId: customer.id,
      },
    });
    await db.message.create({
      data: {
        organizationId: organization.id,
        ticketId: ticket.id,
        authorType: 'CUSTOMER',
        authorCustomerId: customer.id,
        body: 'Hello',
      },
    });

    await db.organization.delete({ where: { id: organization.id } });

    expect(await db.ticket.count({ where: { organizationId: organization.id } })).toBe(0);
    expect(await db.customer.count({ where: { organizationId: organization.id } })).toBe(0);
    expect(await db.message.count({ where: { organizationId: organization.id } })).toBe(0);
  });

  it('refuses to delete a customer that still has tickets', async () => {
    const { organization, customer } = await createOrgWithCustomer(db, 'restrict');
    await db.ticket.create({
      data: {
        organizationId: organization.id,
        number: 1,
        subject: 'Keep me',
        customerId: customer.id,
      },
    });

    await expect(
      db.customer.delete({
        where: { organizationId_id: { organizationId: organization.id, id: customer.id } },
      }),
    ).rejects.toThrow(/foreign key|constraint/i);
  });

  it('refuses to delete a customer who authored messages, although that check is deferred', async () => {
    // The author is not the ticket's customer, so only the (deferred) Message → Customer
    // foreign key can block the delete.
    const { organization, customer } = await createOrgWithCustomer(db, 'deferred');
    const author = await db.customer.create({
      data: { organizationId: organization.id, email: 'cc@example.com', name: 'Cc' },
    });
    const ticket = await db.ticket.create({
      data: { organizationId: organization.id, number: 1, subject: 'Hi', customerId: customer.id },
    });
    await db.message.create({
      data: {
        organizationId: organization.id,
        ticketId: ticket.id,
        authorType: 'CUSTOMER',
        authorCustomerId: author.id,
        body: 'Adding a colleague',
      },
    });

    await expect(
      db.customer.delete({
        where: { organizationId_id: { organizationId: organization.id, id: author.id } },
      }),
    ).rejects.toThrow(/foreign key|constraint/i);
    expect(
      await db.customer.count({ where: { organizationId: organization.id, id: author.id } }),
    ).toBe(1);
  });
});

describe('hand-written constraints from the migration', () => {
  describe.each(['Team', 'Tag'] as const)('%s names, unique regardless of case', (table) => {
    const create = (organizationId: string, name: string) =>
      table === 'Team'
        ? db.team.create({ data: { organizationId, name } })
        : db.tag.create({ data: { organizationId, name } });

    it('rejects a name differing only by case, even written directly to the database', async () => {
      const { organization } = await createOrgWithCustomer(db, `ci-${table.toLowerCase()}`);
      await create(organization.id, 'Billing');
      for (const name of ['billing', 'BILLING', 'bIlLiNg']) {
        const error: unknown = await create(organization.id, name).catch((e: unknown) => e);
        expect(prismaErrorCode(error), name).toBe('P2002');
        expect(String(error), name).toContain(`${table}_organizationId_lower_name_key`);
      }
      expect(
        await db.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "${table}" WHERE "organizationId" = $1::uuid`,
          organization.id,
        ),
      ).toEqual([{ n: 1 }]);
    });

    it('rejects a rename onto another name differing only by case', async () => {
      const { organization } = await createOrgWithCustomer(db, `ci-rename-${table.toLowerCase()}`);
      await create(organization.id, 'Escalations');
      const other = await create(organization.id, 'Other');
      const rename =
        table === 'Team'
          ? db.team.update({
              where: { organizationId_id: { organizationId: organization.id, id: other.id } },
              data: { name: 'ESCALATIONS' },
            })
          : db.tag.update({
              where: { organizationId_id: { organizationId: organization.id, id: other.id } },
              data: { name: 'ESCALATIONS' },
            });
      expect(prismaErrorCode(await rename.catch((e: unknown) => e))).toBe('P2002');
    });

    it('still allows the same name in different organizations, and recasing a name itself', async () => {
      const a = await createOrgWithCustomer(db, `ci-a-${table.toLowerCase()}`);
      const b = await createOrgWithCustomer(db, `ci-b-${table.toLowerCase()}`);
      const mine = await create(a.organization.id, 'Shared');
      await expect(create(b.organization.id, 'SHARED')).resolves.toBeDefined();
      const recase =
        table === 'Team'
          ? db.team.update({
              where: { organizationId_id: { organizationId: a.organization.id, id: mine.id } },
              data: { name: 'SHARED' },
            })
          : db.tag.update({
              where: { organizationId_id: { organizationId: a.organization.id, id: mine.id } },
              data: { name: 'SHARED' },
            });
      await expect(recase).resolves.toMatchObject({ name: 'SHARED' });
    });

    it('makes the migration stop, naming the records, if duplicates already exist', async () => {
      const { organization } = await createOrgWithCustomer(db, `ci-guard-${table.toLowerCase()}`);
      const migration = readFileSync(
        new URL(
          '../prisma/migrations/20261026000000_case_insensitive_team_tag_names/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const guard = migration.slice(migration.indexOf('DO $$'), migration.indexOf('$$;') + 3);
      class Rollback extends Error {}

      // Everything happens in one transaction that is always rolled back: the index is
      // dropped only inside it, so no other session ever sees it missing.
      const run = db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DROP INDEX "${table}_organizationId_lower_name_key"`);
        const first =
          table === 'Team'
            ? await tx.team.create({ data: { organizationId: organization.id, name: 'Dup' } })
            : await tx.tag.create({ data: { organizationId: organization.id, name: 'Dup' } });
        const second =
          table === 'Team'
            ? await tx.team.create({ data: { organizationId: organization.id, name: 'DUP' } })
            : await tx.tag.create({ data: { organizationId: organization.id, name: 'DUP' } });
        const error: unknown = await tx.$executeRawUnsafe(guard).catch((e: unknown) => e);
        const message = String(error);
        expect(message).toContain(`${table} names that differ only by case already exist`);
        expect(message).toContain(organization.id);
        expect(message).toContain(first.id);
        expect(message).toContain(second.id);
        throw new Rollback();
      });
      await expect(run).rejects.toBeInstanceOf(Rollback);

      const index = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = ${`${table}_organizationId_lower_name_key`}`;
      expect(index).toEqual([{ n: 1 }]);
      expect(
        await db.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "${table}" WHERE "organizationId" = $1::uuid`,
          organization.id,
        ),
      ).toEqual([{ n: 0 }]);
    });
  });

  it('allows at most one default SLA policy per organization', async () => {
    const { organization } = await createOrgWithCustomer(db, 'sla');
    await db.slaPolicy.create({
      data: { organizationId: organization.id, name: 'Standard', isDefault: true },
    });
    await db.slaPolicy.create({
      data: { organizationId: organization.id, name: 'VIP', isDefault: false },
    });

    await expect(
      db.slaPolicy.create({
        data: { organizationId: organization.id, name: 'Other', isDefault: true },
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('rejects SLA targets whose resolution time is shorter than first response', async () => {
    const { organization } = await createOrgWithCustomer(db, 'sla-target');
    const policy = await db.slaPolicy.create({
      data: { organizationId: organization.id, name: 'P' },
    });

    await expect(
      db.slaTarget.create({
        data: {
          organizationId: organization.id,
          slaPolicyId: policy.id,
          priority: 'HIGH',
          firstResponseMinutes: 120,
          resolutionMinutes: 60,
        },
      }),
    ).rejects.toThrow(/SlaTarget_minutes_check|check constraint/i);
  });

  it('rejects a customer-authored message without a customer', async () => {
    const { organization, customer } = await createOrgWithCustomer(db, 'msg');
    const ticket = await db.ticket.create({
      data: { organizationId: organization.id, number: 1, subject: 'Msg', customerId: customer.id },
    });

    await expect(
      db.message.create({
        data: {
          organizationId: organization.id,
          ticketId: ticket.id,
          authorType: 'CUSTOMER',
          body: 'Hi',
        },
      }),
    ).rejects.toThrow(/Message_author_check|check constraint/i);
  });
});
