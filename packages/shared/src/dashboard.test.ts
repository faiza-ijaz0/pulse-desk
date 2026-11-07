import { describe, expect, it } from 'vitest';
import { DASHBOARD_ATTENTION_LIMIT, dashboardSummaryResponseSchema } from './dashboard.ts';

const EMPTY = {
  scope: 'organization',
  generatedAt: '2026-11-04T12:00:00.000Z',
  tickets: {
    byStatus: { OPEN: 0, PENDING: 0, ON_HOLD: 0, SOLVED: 0, CLOSED: 0 },
    active: 0,
    awaitingFirstResponse: 0,
    unassigned: 0,
  },
  sla: {
    active: {
      none: 0,
      met: 0,
      on_track: 0,
      at_risk: 0,
      first_response_breached: 0,
      resolution_breached: 0,
    },
    attention: [],
  },
  responseTimes: {
    windowDays: 30,
    windowStart: '2026-10-05T12:00:00.000Z',
    firstResponse: { count: 0, averageSeconds: null },
    resolution: { count: 0, averageSeconds: null },
  },
  agents: [],
};

const attention = (number: number) => ({
  number,
  subject: `Ticket ${number}`,
  priority: 'HIGH',
  status: 'at_risk',
  target: 'firstResponse',
  dueAt: '2026-11-04T12:30:00.000Z',
});

describe('dashboardSummaryResponseSchema', () => {
  it('accepts an empty organization: zero counts and no averages', () => {
    expect(dashboardSummaryResponseSchema.parse(EMPTY)).toEqual(EMPTY);
  });

  it('reports "no data" as null, never as a zero average', () => {
    const zeroAverage = {
      ...EMPTY,
      responseTimes: { ...EMPTY.responseTimes, firstResponse: { count: 0, averageSeconds: 0 } },
    };
    expect(dashboardSummaryResponseSchema.safeParse(zeroAverage).success).toBe(false);

    const missingAverage = {
      ...EMPTY,
      responseTimes: { ...EMPTY.responseTimes, resolution: { count: 3, averageSeconds: null } },
    };
    expect(dashboardSummaryResponseSchema.safeParse(missingAverage).success).toBe(false);
  });

  it('rejects negative counts and durations', () => {
    const negativeCount = { ...EMPTY, tickets: { ...EMPTY.tickets, active: -1 } };
    expect(dashboardSummaryResponseSchema.safeParse(negativeCount).success).toBe(false);

    const negativeDuration = {
      ...EMPTY,
      responseTimes: { ...EMPTY.responseTimes, resolution: { count: 1, averageSeconds: -5 } },
    };
    expect(dashboardSummaryResponseSchema.safeParse(negativeDuration).success).toBe(false);
  });

  it('allows no unassigned count only as null (the own scope)', () => {
    const own = { ...EMPTY, scope: 'own', tickets: { ...EMPTY.tickets, unassigned: null } };
    expect(dashboardSummaryResponseSchema.parse(own).tickets.unassigned).toBeNull();
    expect(dashboardSummaryResponseSchema.safeParse({ ...EMPTY, scope: 'team' }).success).toBe(
      false,
    );
  });

  it('lists only urgent SLA states, at most the attention limit', () => {
    const full = Array.from({ length: DASHBOARD_ATTENTION_LIMIT }, (_, i) => attention(i + 1));
    expect(
      dashboardSummaryResponseSchema.safeParse({ ...EMPTY, sla: { ...EMPTY.sla, attention: full } })
        .success,
    ).toBe(true);
    expect(
      dashboardSummaryResponseSchema.safeParse({
        ...EMPTY,
        sla: { ...EMPTY.sla, attention: [...full, attention(99)] },
      }).success,
    ).toBe(false);
    expect(
      dashboardSummaryResponseSchema.safeParse({
        ...EMPTY,
        sla: { ...EMPTY.sla, attention: [{ ...attention(1), status: 'on_track' }] },
      }).success,
    ).toBe(false);
  });
});
