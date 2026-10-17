import type { Database, TransactionClient } from '../client.ts';
import type { TicketPriority } from '../generated/prisma/enums.ts';
import {
  DEFAULT_SLA_TARGETS,
  SEED_ORGANIZATIONS,
  SEED_USERS,
  type SeedOrganization,
} from './data.ts';

const MINUTE = 60_000;

export type SeedSummary = {
  organizations: number;
  users: number;
  memberships: number;
  tickets: number;
};

/**
 * Idempotent development seed. It deletes only the organizations and users it owns
 * (matched by slug / email), then recreates them. Unrelated data is left untouched,
 * so running it repeatedly always converges on the same fixture set.
 */
export async function seedDatabase(
  db: Database,
  options: { passwordHash: string; now?: Date },
): Promise<SeedSummary> {
  const now = options.now ?? new Date();

  return db.$transaction(
    async (tx) => {
      // Organization deletes cascade through every tenant-scoped table.
      await tx.organization.deleteMany({
        where: { slug: { in: SEED_ORGANIZATIONS.map((o) => o.slug) } },
      });
      await tx.user.deleteMany({ where: { email: { in: SEED_USERS.map((u) => u.email) } } });

      const userIds = new Map<string, string>();
      for (const user of SEED_USERS) {
        const created = await tx.user.create({
          data: {
            name: user.name,
            email: user.email,
            passwordHash: options.passwordHash,
            emailVerifiedAt: now,
          },
        });
        userIds.set(user.key, created.id);
      }

      let memberships = 0;
      let tickets = 0;
      for (const org of SEED_ORGANIZATIONS) {
        const result = await seedOrganization(tx, org, userIds, now);
        memberships += result.memberships;
        tickets += result.tickets;
      }

      return {
        organizations: SEED_ORGANIZATIONS.length,
        users: SEED_USERS.length,
        memberships,
        tickets,
      };
    },
    { timeout: 30_000 },
  );
}

function requireId(map: Map<string, string>, key: string, kind: string): string {
  const id = map.get(key);
  if (id === undefined) throw new Error(`Seed data references unknown ${kind} "${key}"`);
  return id;
}

async function seedOrganization(
  tx: TransactionClient,
  org: SeedOrganization,
  userIds: Map<string, string>,
  now: Date,
): Promise<{ memberships: number; tickets: number }> {
  const organization = await tx.organization.create({
    data: { slug: org.slug, name: org.name, ticketSequence: org.tickets.length },
  });
  const organizationId = organization.id;

  await tx.membership.createMany({
    data: org.members.map((m) => ({
      organizationId,
      userId: requireId(userIds, m.userKey, 'user'),
      role: m.role,
    })),
  });

  const teamIds = new Map<string, string>();
  for (const team of org.teams) {
    const created = await tx.team.create({ data: { organizationId, name: team.name } });
    teamIds.set(team.name, created.id);
    await tx.teamMember.createMany({
      data: team.memberKeys.map((key) => ({
        organizationId,
        teamId: created.id,
        userId: requireId(userIds, key, 'user'),
      })),
    });
  }

  const tagIds = new Map<string, string>();
  for (const tag of org.tags) {
    const created = await tx.tag.create({ data: { organizationId, ...tag } });
    tagIds.set(tag.name, created.id);
  }

  const customerIds = new Map<string, string>();
  for (const customer of org.customers) {
    const created = await tx.customer.create({ data: { organizationId, ...customer } });
    customerIds.set(customer.email, created.id);
  }

  const policy = await tx.slaPolicy.create({
    data: { organizationId, name: 'Standard', isDefault: true },
  });
  await tx.slaTarget.createMany({
    data: (Object.keys(DEFAULT_SLA_TARGETS) as TicketPriority[]).map((priority) => ({
      organizationId,
      slaPolicyId: policy.id,
      priority,
      firstResponseMinutes: DEFAULT_SLA_TARGETS[priority].firstResponse,
      resolutionMinutes: DEFAULT_SLA_TARGETS[priority].resolution,
    })),
  });

  for (const [index, t] of org.tickets.entries()) {
    const openedAt = new Date(now.getTime() - t.openedMinutesAgo * MINUTE);
    const target = DEFAULT_SLA_TARGETS[t.priority];
    const firstRespondedAt =
      t.firstReplyAfterMinutes === undefined
        ? null
        : new Date(openedAt.getTime() + t.firstReplyAfterMinutes * MINUTE);
    const solvedAt = t.status === 'SOLVED' ? new Date(now.getTime() - 60 * MINUTE) : null;
    const customerId = requireId(customerIds, t.customerEmail, 'customer');
    const assigneeUserId = t.assigneeKey ? requireId(userIds, t.assigneeKey, 'user') : null;

    const ticket = await tx.ticket.create({
      data: {
        organizationId,
        number: index + 1,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        channel: t.channel,
        customerId,
        assigneeUserId,
        teamId: t.team ? requireId(teamIds, t.team, 'team') : null,
        slaPolicyId: policy.id,
        firstResponseDueAt: new Date(openedAt.getTime() + target.firstResponse * MINUTE),
        resolutionDueAt: new Date(openedAt.getTime() + target.resolution * MINUTE),
        firstRespondedAt,
        solvedAt,
        createdAt: openedAt,
      },
    });

    await tx.message.create({
      data: {
        organizationId,
        ticketId: ticket.id,
        authorType: 'CUSTOMER',
        authorCustomerId: customerId,
        body: t.customerMessage,
        createdAt: openedAt,
      },
    });
    if (t.agentReply && firstRespondedAt && assigneeUserId) {
      await tx.message.create({
        data: {
          organizationId,
          ticketId: ticket.id,
          authorType: 'AGENT',
          authorUserId: assigneeUserId,
          body: t.agentReply,
          createdAt: firstRespondedAt,
        },
      });
    }
    if (t.internalNote && assigneeUserId) {
      await tx.message.create({
        data: {
          organizationId,
          ticketId: ticket.id,
          authorType: 'AGENT',
          authorUserId: assigneeUserId,
          visibility: 'INTERNAL',
          body: t.internalNote,
          createdAt: new Date((firstRespondedAt ?? openedAt).getTime() + MINUTE),
        },
      });
    }

    if (t.tags?.length) {
      await tx.ticketTag.createMany({
        data: t.tags.map((name) => ({
          organizationId,
          ticketId: ticket.id,
          tagId: requireId(tagIds, name, 'tag'),
        })),
      });
    }

    await tx.ticketEvent.create({
      data: { organizationId, ticketId: ticket.id, type: 'CREATED', createdAt: openedAt },
    });
  }

  return { memberships: org.members.length, tickets: org.tickets.length };
}
