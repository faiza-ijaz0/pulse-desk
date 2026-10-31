import { prismaErrorCode, type Database, type TicketPriority } from '@pulsedesk/db';
import { DEFAULT_SLA_POLICY_NAME, TICKET_PRIORITIES, type SlaTargetInput } from '@pulsedesk/shared';
import { ConflictError } from '../../http/errors.ts';
import { withTransactionRetry } from '../../lib/transactions.ts';

const policySelect = {
  id: true,
  name: true,
  updatedAt: true,
  targets: { select: { priority: true, firstResponseMinutes: true, resolutionMinutes: true } },
} as const;

export type AuditEntry = {
  actorUserId: string;
  ipAddress: string | undefined;
  requestId: string;
};

type StoredTarget = { firstResponseMinutes: number; resolutionMinutes: number };
type TargetChange = Partial<Record<keyof StoredTarget, { from: number | null; to: number }>>;

export type SlaPolicyRow = {
  id: string;
  name: string;
  updatedAt: Date;
  targets: ({ priority: TicketPriority } & StoredTarget)[];
};

/** What changed per priority (`{ field: { from, to } }`); `from` is null for a missing target. */
function diffTargets(
  before: SlaPolicyRow['targets'],
  next: Record<TicketPriority, SlaTargetInput>,
): Partial<Record<TicketPriority, TargetChange>> {
  const changes: Partial<Record<TicketPriority, TargetChange>> = {};
  for (const priority of TICKET_PRIORITIES) {
    const current = before.find((target) => target.priority === priority);
    const change: TargetChange = {};
    for (const field of ['firstResponseMinutes', 'resolutionMinutes'] as const) {
      const from = current?.[field] ?? null;
      if (from !== next[priority][field]) change[field] = { from, to: next[priority][field] };
    }
    if (Object.keys(change).length > 0) changes[priority] = change;
  }
  return changes;
}

export function createSlaPoliciesRepository(db: Database) {
  return {
    /** The organization's default policy: the one new tickets take their due dates from. */
    findDefault(organizationId: string): Promise<SlaPolicyRow | null> {
      return db.slaPolicy.findFirst({
        where: { organizationId, isDefault: true },
        select: policySelect,
      });
    },

    /**
     * Sets the default policy's targets for every priority in one transaction with one audit
     * entry, creating the policy (`sla_policy.created`) if the organization has none. Only
     * targets that differ are written and audited (`sla_policy.updated`), so a no-op save
     * writes nothing. Existing tickets keep their due dates.
     *
     * Saves in one organization are serialized by a transaction-scoped advisory lock, so each
     * audit entry's "from" is what the previous save left and two first saves can't both
     * create a policy. Ticket writes never take this lock: they read committed targets.
     */
    async saveDefault(
      organizationId: string,
      targets: Record<TicketPriority, SlaTargetInput>,
      audit: AuditEntry,
    ): Promise<SlaPolicyRow> {
      try {
        return await withTransactionRetry(() =>
          db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sla-policy:${organizationId}`}, 0))`;
            const auditData = {
              organizationId,
              actorUserId: audit.actorUserId,
              targetType: 'SlaPolicy',
              ipAddress: audit.ipAddress ?? null,
              requestId: audit.requestId,
            };

            const before = await tx.slaPolicy.findFirst({
              where: { organizationId, isDefault: true },
              select: policySelect,
            });
            if (!before) {
              const policy = await tx.slaPolicy.create({
                data: { organizationId, name: DEFAULT_SLA_POLICY_NAME, isDefault: true },
                select: { id: true },
              });
              await tx.slaTarget.createMany({
                data: TICKET_PRIORITIES.map((priority) => ({
                  organizationId,
                  slaPolicyId: policy.id,
                  priority,
                  ...targets[priority],
                })),
              });
              await tx.auditLog.create({
                data: {
                  ...auditData,
                  action: 'sla_policy.created',
                  targetId: policy.id,
                  metadata: { name: DEFAULT_SLA_POLICY_NAME, targets },
                },
              });
              return tx.slaPolicy.findFirstOrThrow({
                where: { organizationId, id: policy.id },
                select: policySelect,
              });
            }

            const changes = diffTargets(before.targets, targets);
            const changed = Object.keys(changes) as TicketPriority[];
            if (changed.length === 0) return before;

            for (const priority of changed) {
              await tx.slaTarget.upsert({
                where: {
                  slaPolicyId_priority: { slaPolicyId: before.id, priority },
                  organizationId,
                },
                create: { organizationId, slaPolicyId: before.id, priority, ...targets[priority] },
                update: targets[priority],
              });
            }
            // Target rows have no timestamp; the policy's says when its targets last changed.
            const policy = await tx.slaPolicy.update({
              where: { organizationId_id: { organizationId, id: before.id }, organizationId },
              data: { updatedAt: new Date() },
              select: policySelect,
            });
            await tx.auditLog.create({
              data: {
                ...auditData,
                action: 'sla_policy.updated',
                targetId: before.id,
                metadata: { targets: changes },
              },
            });
            return policy;
          }),
        );
      } catch (error) {
        // Only older data can hit this: a non-default policy already holds the default name.
        if (prismaErrorCode(error) === 'P2002') {
          throw new ConflictError(
            `A policy named “${DEFAULT_SLA_POLICY_NAME}” already exists but isn’t the default.`,
          );
        }
        throw error;
      }
    },
  };
}

export type SlaPoliciesRepository = ReturnType<typeof createSlaPoliciesRepository>;
