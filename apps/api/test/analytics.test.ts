import { analyticsReportResponseSchema } from '@pulsedesk/shared';
import { describe, expect, it } from 'vitest';
import type {
  AnalyticsFilter,
  AnalyticsRepository,
  AnalyticsSnapshot,
  AnalyticsWindow,
} from '../src/modules/analytics/analytics.repository.ts';
import {
  analyticsScope,
  createAnalyticsService,
  resolveRange,
} from '../src/modules/analytics/analytics.service.ts';

// The service's own decisions, without a database: the scope rule, the range defaults and
// checks, dense buckets, totals, and "no data" as null. test/integration/analytics.int.test.ts
// covers the SQL, time-zone bucketing, SLA outcomes and tenant isolation.

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const AGENT = '00000000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-11-07T12:00:00.000Z');

const EMPTY_SNAPSHOT: AnalyticsSnapshot = {
  created: [],
  statusChanges: [],
  firstResponse: [],
  resolution: [],
  createdByStatus: [],
  slaOutcomes: [],
  activity: [],
  members: [],
};

function serviceWith(snapshot: Partial<AnalyticsSnapshot>) {
  const calls: { filter: AnalyticsFilter; window: AnalyticsWindow }[] = [];
  const repository: AnalyticsRepository = {
    snapshot(filter, window) {
      calls.push({ filter, window });
      return Promise.resolve({ ...EMPTY_SNAPSHOT, ...snapshot });
    },
  };
  const service = createAnalyticsService({ repository, clock: { now: () => NOW } });
  return { service, calls };
}

const tenant = (role: 'OWNER' | 'ADMIN' | 'AGENT', userId = OWNER) => ({
  organizationId: ORG,
  userId,
  role,
  requestId: 'test',
});

describe('analyticsScope', () => {
  it('gives owners and admins the organization, agents their own data', () => {
    expect(analyticsScope('OWNER')).toBe('organization');
    expect(analyticsScope('ADMIN')).toBe('organization');
    expect(analyticsScope('AGENT')).toBe('own');
  });
});

describe('resolveRange', () => {
  it('defaults to the last 30 UTC days, today included', () => {
    expect(resolveRange({}, NOW)).toEqual({
      from: '2026-10-09',
      to: '2026-11-07',
      timeZone: 'UTC',
    });
  });

  it('takes "today" from the requested time zone', () => {
    const lateEvening = new Date('2026-11-07T03:00:00.000Z'); // still the 6th in Chicago
    expect(resolveRange({ tz: 'America/Chicago' }, lateEvening).to).toBe('2026-11-06');
  });

  it('refuses an end after today and ranges the defaults make invalid', () => {
    expect(() => resolveRange({ to: '2026-11-08' }, NOW)).toThrow(
      expect.objectContaining({
        status: 400,
        fieldErrors: [{ path: 'query.to', message: 'Must not be after today (2026-11-07 in UTC)' }],
      }),
    );
    expect(() => resolveRange({ from: '2026-11-08' }, NOW)).toThrow(
      expect.objectContaining({ fieldErrors: [expect.objectContaining({ path: 'query.from' })] }),
    );
    expect(() => resolveRange({ from: '2025-01-01' }, NOW)).toThrow(
      expect.objectContaining({
        fieldErrors: [{ path: 'query.from', message: 'The range can cover at most 366 days' }],
      }),
    );
  });
});

describe('analytics service', () => {
  it('queries the session organization, narrowed to the caller for agents', async () => {
    const { service, calls } = serviceWith({});
    await service.report(tenant('ADMIN'), {});
    await service.report(tenant('AGENT', AGENT), {});

    expect(calls.map((c) => c.filter)).toEqual([
      { organizationId: ORG, userId: null },
      { organizationId: ORG, userId: AGENT },
    ]);
  });

  it('passes every bucket start plus the end, and caps at the clock', async () => {
    const { service, calls } = serviceWith({});
    await service.report(tenant('OWNER'), { from: '2026-11-05', to: '2026-11-07', tz: 'UTC' });

    expect(calls[0]?.window.bounds.map((d) => d.toISOString())).toEqual([
      '2026-11-05T00:00:00.000Z',
      '2026-11-06T00:00:00.000Z',
      '2026-11-07T00:00:00.000Z',
      '2026-11-08T00:00:00.000Z',
    ]);
    expect(calls[0]?.window.now).toBe(NOW);
  });

  it('describes an empty organization with zero buckets and no averages', async () => {
    const { service } = serviceWith({});
    const report = analyticsReportResponseSchema.parse(await service.report(tenant('OWNER'), {}));

    expect(report.buckets).toHaveLength(30);
    expect(report.totals).toEqual({ created: 0, solved: 0, reopened: 0 });
    expect(report.responseTimes.resolution).toEqual({
      count: 0,
      averageSeconds: null,
      medianSeconds: null,
    });
    expect(report.sla.byPriority.map((p) => p.priority)).toEqual([
      'LOW',
      'NORMAL',
      'HIGH',
      'URGENT',
    ]);
  });

  it('fills buckets by number, totals them, and keeps idle members', async () => {
    const { service } = serviceWith({
      created: [
        { bucket: 1, created: 2 },
        { bucket: 3, created: 5 },
      ],
      statusChanges: [{ bucket: 2, solved: 3, reopened: 1 }],
      firstResponse: [
        { bucket: 3, count: 2, averageSeconds: 600, medianSeconds: 600 },
        { bucket: null, count: 2, averageSeconds: 600, medianSeconds: 500 },
      ],
      slaOutcomes: [
        { target: 'firstResponse', priority: 'HIGH', outcome: 'met', bucket: 1, count: 4 },
        { target: 'firstResponse', priority: 'HIGH', outcome: 'breached', bucket: 3, count: 1 },
        { target: 'resolution', priority: 'LOW', outcome: 'breached', bucket: 2, count: 2 },
      ],
      activity: [
        { userId: AGENT, kind: 'solved', count: 3, averageSeconds: null },
        { userId: AGENT, kind: 'firstResponses', count: 2, averageSeconds: 600 },
      ],
      members: [
        { userId: OWNER, role: 'OWNER', user: { name: 'Olivia Owner' } },
        { userId: AGENT, role: 'AGENT', user: { name: 'Aaron Agent' } },
      ],
    });
    const report = analyticsReportResponseSchema.parse(
      await service.report(tenant('OWNER'), { from: '2026-11-05', to: '2026-11-07' }),
    );

    expect(report.buckets.map((b) => [b.start, b.created, b.solved, b.reopened])).toEqual([
      ['2026-11-05', 2, 0, 0],
      ['2026-11-06', 0, 3, 1],
      ['2026-11-07', 5, 0, 0],
    ]);
    expect(report.totals).toEqual({ created: 7, solved: 3, reopened: 1 });
    expect(report.buckets[2]?.firstResponse).toEqual({ count: 2, averageSeconds: 600 });
    expect(report.responseTimes.firstResponse).toEqual({
      count: 2,
      averageSeconds: 600,
      medianSeconds: 500,
    });
    expect(report.sla.firstResponse).toEqual({ met: 4, breached: 1 });
    expect(report.sla.resolution).toEqual({ met: 0, breached: 2 });
    expect(report.buckets.map((b) => [b.firstResponseBreaches, b.resolutionBreaches])).toEqual([
      [0, 0],
      [0, 2],
      [1, 0],
    ]);
    expect(report.agents.map((a) => [a.name, a.solved, a.publicReplies, a.firstResponses])).toEqual(
      [
        ['Aaron Agent', 3, 0, { count: 2, averageSeconds: 600 }],
        ['Olivia Owner', 0, 0, { count: 0, averageSeconds: null }],
      ],
    );
  });

  it('never reports an average without durations behind it', async () => {
    const { service } = serviceWith({
      resolution: [{ bucket: null, count: 0, averageSeconds: 0, medianSeconds: 0 }],
    });
    const report = await service.report(tenant('OWNER'), {});
    expect(report.responseTimes.resolution).toEqual({
      count: 0,
      averageSeconds: null,
      medianSeconds: null,
    });
  });
});
