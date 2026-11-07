import {
  DASHBOARD_WINDOW_DAYS,
  hasPermission,
  type DashboardScope,
  type DashboardSummary,
  type Role,
  type SlaStatus,
} from '@pulsedesk/shared';
import type { TenantContext } from '../../http/auth-context.ts';
import type { Clock } from '../../lib/clock.ts';
import type { DashboardRepository, WorkloadRow } from './dashboard.repository.ts';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Which tickets the caller's dashboard covers (the documented analytics rule): owners and
 * admins (`analytics:read-all`) see the organization, everyone else (`analytics:read-own`,
 * checked by the route) only the tickets assigned to them.
 */
export function dashboardScope(role: Role): DashboardScope {
  return hasPermission(role, 'analytics:read-all') ? 'organization' : 'own';
}

const SLA_KEYS = [
  'none',
  'met',
  'on_track',
  'at_risk',
  'first_response_breached',
  'resolution_breached',
] as const satisfies readonly SlaStatus[];

function sum(rows: readonly WorkloadRow[], key: keyof Omit<WorkloadRow, 'assigneeUserId'>) {
  return rows.reduce((total, row) => total + row[key], 0);
}

/** Live dashboard metrics (docs/architecture/dashboard.md), read from one database snapshot. */
export function createDashboardService(deps: { repository: DashboardRepository; clock: Clock }) {
  return {
    async summary(tenant: TenantContext): Promise<DashboardSummary> {
      const scope = dashboardScope(tenant.role);
      const now = deps.clock.now();
      const windowStart = new Date(now.getTime() - DASHBOARD_WINDOW_DAYS * DAY);
      const snapshot = await deps.repository.snapshot(
        {
          organizationId: tenant.organizationId,
          assigneeUserId: scope === 'own' ? tenant.userId : null,
        },
        now,
        windowStart,
      );

      const byStatus = { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 };
      for (const { status, count } of snapshot.statusCounts) byStatus[status] = count;

      const { workload } = snapshot;
      const sla = Object.fromEntries(SLA_KEYS.map((key) => [key, sum(workload, key)])) as Record<
        SlaStatus,
        number
      >;
      const perAssignee = new Map(workload.map((row) => [row.assigneeUserId, row]));

      const agents = snapshot.members
        .map(({ userId, role, user }) => {
          const row = perAssignee.get(userId);
          return {
            userId,
            name: user.name,
            role,
            active: row?.active ?? 0,
            open: row?.open ?? 0,
            pending: row?.pending ?? 0,
            onHold: row?.onHold ?? 0,
            atRisk: row?.at_risk ?? 0,
            breached: (row?.first_response_breached ?? 0) + (row?.resolution_breached ?? 0),
          };
        })
        .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));

      const { timing } = snapshot;
      return {
        scope,
        generatedAt: now.toISOString(),
        tickets: {
          byStatus,
          active: sum(workload, 'active'),
          awaitingFirstResponse: sum(workload, 'awaitingFirstResponse'),
          unassigned: scope === 'own' ? null : (perAssignee.get(null)?.active ?? 0),
        },
        sla: {
          active: sla,
          attention: snapshot.attention.map((row) => ({
            number: row.number,
            subject: row.subject,
            priority: row.priority,
            status: row.status,
            target: row.target,
            dueAt: row.dueAt?.toISOString() ?? null,
          })),
        },
        responseTimes: {
          windowDays: DASHBOARD_WINDOW_DAYS,
          windowStart: windowStart.toISOString(),
          firstResponse: {
            count: timing.firstResponseCount,
            averageSeconds:
              timing.firstResponseCount > 0 ? timing.firstResponseAverageSeconds : null,
          },
          resolution: {
            count: timing.resolutionCount,
            averageSeconds: timing.resolutionCount > 0 ? timing.resolutionAverageSeconds : null,
          },
        },
        agents,
      };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
