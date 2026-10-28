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

  describe('SLA breach markers, auto-close and system events', () => {
    async function ticketIn(label: string) {
      const { organization, customer } = await createOrgWithCustomer(db, label);
      const ticket = await db.ticket.create({
        data: {
          organizationId: organization.id,
          number: 1,
          subject: 'SLA',
          customerId: customer.id,
        },
      });
      return { organization, ticket };
    }

    it('starts new organizations with auto-close enabled after four days', async () => {
      const { organization } = await createOrgWithCustomer(db, 'auto-close-default');
      expect(organization).toMatchObject({ autoCloseEnabled: true, autoCloseAfterMinutes: 5760 });
    });

    it('keeps the delay while auto-close is disabled, and bounds it', async () => {
      const { organization } = await createOrgWithCustomer(db, 'auto-close-bounds');
      const set = (data: { autoCloseEnabled?: boolean; autoCloseAfterMinutes?: number }) =>
        db.organization.update({ where: { id: organization.id }, data });
      await expect(set({ autoCloseEnabled: false })).resolves.toMatchObject({
        autoCloseEnabled: false,
        autoCloseAfterMinutes: 5760,
      });
      for (const minutes of [0, -1, 525_601]) {
        await expect(set({ autoCloseAfterMinutes: minutes }), String(minutes)).rejects.toThrow(
          /Organization_autoCloseAfterMinutes_check|check constraint/i,
        );
      }
      await expect(set({ autoCloseAfterMinutes: 525_600 })).resolves.toBeDefined();
    });

    it('starts tickets without breach markers and events as USER', async () => {
      const { organization, ticket } = await ticketIn('sla-defaults');
      expect(ticket).toMatchObject({ firstResponseBreachedAt: null, resolutionBreachedAt: null });
      const event = await db.ticketEvent.create({
        data: { organizationId: organization.id, ticketId: ticket.id, type: 'CREATED' },
      });
      expect(event).toMatchObject({ actorType: 'USER', actorUserId: null });
    });

    it('keeps an event USER, with no user, after its user is deleted', async () => {
      const { organization, ticket } = await ticketIn('deleted-actor');
      const user = await db.user.create({
        data: {
          email: `deleted-actor-${organization.slug}@example.com`,
          name: 'Leaver',
          passwordHash: 'x',
        },
      });
      const event = await db.ticketEvent.create({
        data: {
          organizationId: organization.id,
          ticketId: ticket.id,
          actorUserId: user.id,
          type: 'STATUS_CHANGED',
          data: { from: 'OPEN', to: 'PENDING' },
        },
      });
      expect(event).toMatchObject({ actorType: 'USER', actorUserId: user.id });

      await db.user.delete({ where: { id: user.id } });

      const after = await db.ticketEvent.findUniqueOrThrow({
        where: { id: event.id, organizationId: organization.id },
      });
      // SetNull removes the user; the event still says a person did it, never the system.
      expect(after).toMatchObject({ actorType: 'USER', actorUserId: null });
    });

    it('rejects a SYSTEM event that names a user', async () => {
      const { organization, ticket } = await ticketIn('system-actor');
      const user = await db.user.create({
        data: {
          email: `system-actor-${organization.slug}@example.com`,
          name: 'U',
          passwordHash: 'x',
        },
      });
      const event = (actorUserId: string | null) =>
        db.ticketEvent.create({
          data: {
            organizationId: organization.id,
            ticketId: ticket.id,
            actorType: 'SYSTEM',
            actorUserId,
            type: 'STATUS_CHANGED',
            data: { from: 'SOLVED', to: 'CLOSED' },
          },
        });
      await expect(event(user.id)).rejects.toThrow(
        /TicketEvent_system_actor_check|check constraint/i,
      );
      await expect(event(null)).resolves.toMatchObject({ actorType: 'SYSTEM' });
    });

    it('allows one breach event per ticket and target, but repeats of other events', async () => {
      const { organization, ticket } = await ticketIn('one-breach');
      const event = (type: 'SLA_FIRST_RESPONSE_BREACHED' | 'SLA_RESOLUTION_BREACHED' | 'CREATED') =>
        db.ticketEvent.create({
          data: {
            organizationId: organization.id,
            ticketId: ticket.id,
            actorType: 'SYSTEM',
            type,
            data: type === 'CREATED' ? {} : { dueAt: '2026-10-27T08:00:00.000Z' },
          },
        });
      await event('SLA_FIRST_RESPONSE_BREACHED');
      const error: unknown = await event('SLA_FIRST_RESPONSE_BREACHED').catch((e: unknown) => e);
      expect(prismaErrorCode(error)).toBe('P2002');
      expect(String(error)).toContain('TicketEvent_one_sla_breach_per_ticket_key');
      await expect(event('SLA_RESOLUTION_BREACHED')).resolves.toBeDefined();
      await event('CREATED');
      await expect(event('CREATED')).resolves.toBeDefined();
    });

    it('makes the migration stop, naming the tickets, if duplicate breach events exist', async () => {
      const { organization, ticket } = await ticketIn('breach-guard');
      const migration = readFileSync(
        new URL(
          '../prisma/migrations/20261027000000_sla_breach_markers_and_auto_close/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const guard = migration.slice(migration.indexOf('DO $$'), migration.indexOf('$$;') + 3);
      class Rollback extends Error {}

      // As above: the index is dropped only inside a transaction that is always rolled back.
      const run = db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('DROP INDEX "TicketEvent_one_sla_breach_per_ticket_key"');
        for (let i = 0; i < 2; i++) {
          await tx.ticketEvent.create({
            data: {
              organizationId: organization.id,
              ticketId: ticket.id,
              actorType: 'SYSTEM',
              type: 'SLA_RESOLUTION_BREACHED',
              data: { dueAt: '2026-10-27T08:00:00.000Z' },
            },
          });
        }
        const message = String(await tx.$executeRawUnsafe(guard).catch((e: unknown) => e));
        expect(message).toContain('more than one SLA breach event of a kind');
        expect(message).toContain(organization.id);
        expect(message).toContain(ticket.id);
        expect(message).toContain('SLA_RESOLUTION_BREACHED');
        throw new Rollback();
      });
      await expect(run).rejects.toBeInstanceOf(Rollback);

      const index = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_indexes
        WHERE indexname = 'TicketEvent_one_sla_breach_per_ticket_key'`;
      expect(index).toEqual([{ n: 1 }]);
    });

    it('creates the partial sweep indexes', async () => {
      const rows = await db.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'Ticket' AND indexname IN (
          'Ticket_auto_close_sweep_idx',
          'Ticket_first_response_breach_sweep_idx',
          'Ticket_resolution_breach_sweep_idx'
        )
        ORDER BY indexname`;
      expect(rows.map((r) => r.indexname)).toEqual([
        'Ticket_auto_close_sweep_idx',
        'Ticket_first_response_breach_sweep_idx',
        'Ticket_resolution_breach_sweep_idx',
      ]);
    });
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
