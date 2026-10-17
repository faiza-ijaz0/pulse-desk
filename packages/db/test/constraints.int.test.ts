import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkspaceEnv } from '../src/env.ts';
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
