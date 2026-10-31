import { describe, expect, it } from 'vitest';
import {
  SLA_TARGET_MAX_MINUTES,
  SLA_TARGET_MIN_MINUTES,
  slaPolicyResponseSchema,
  updateSlaPolicyRequestSchema,
  type UpdateSlaPolicyRequest,
} from './sla-policies.ts';
import { DEFAULT_SLA_TARGETS } from './sla.ts';
import { TICKET_PRIORITIES } from './tickets.ts';

const valid = (): UpdateSlaPolicyRequest => ({
  targets: structuredClone(DEFAULT_SLA_TARGETS),
});

function issues(input: unknown) {
  const result = updateSlaPolicyRequestSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

describe('SLA policy contract', () => {
  it('accepts the default targets, so a new organization can save them unchanged', () => {
    expect(issues(valid())).toEqual([]);
  });

  it('bounds each target from 1 minute to 365 days, in whole minutes', () => {
    expect(SLA_TARGET_MIN_MINUTES).toBe(1);
    expect(SLA_TARGET_MAX_MINUTES).toBe(525_600);
    const ok = (minutes: unknown) => {
      const input = valid();
      Object.assign(input.targets.LOW, {
        firstResponseMinutes: minutes,
        resolutionMinutes: minutes,
      });
      return issues(input).length === 0;
    };
    expect([1, 60, 1440, 525_600].map(ok)).toEqual([true, true, true, true]);
    expect([0, -5, 525_601, 1.5, '60', null, Number.NaN].map(ok)).toEqual(
      Array.from({ length: 7 }, () => false),
    );
  });

  it('requires resolution to be at least first response, reported on resolution', () => {
    const input = valid();
    input.targets.HIGH = { firstResponseMinutes: 120, resolutionMinutes: 119 };
    expect(issues(input)).toEqual([
      {
        path: 'targets.HIGH.resolutionMinutes',
        message: 'Must be at least the first-response target',
      },
    ]);
    input.targets.HIGH = { firstResponseMinutes: 120, resolutionMinutes: 120 };
    expect(issues(input)).toEqual([]);
  });

  it('requires every priority, and refuses unknown priorities and fields', () => {
    const missing = valid() as { targets: Partial<UpdateSlaPolicyRequest['targets']> };
    delete missing.targets.LOW;
    expect(issues(missing).map((issue) => issue.path)).toEqual(['targets.LOW']);

    expect(issues({ targets: { ...valid().targets, CRITICAL: valid().targets.URGENT } })).toEqual([
      expect.objectContaining({ path: 'targets' }),
    ]);
    const extraField = valid() as { targets: Record<string, object> };
    extraField.targets.URGENT = { ...extraField.targets.URGENT, businessHours: true };
    expect(issues(extraField)).toEqual([expect.objectContaining({ path: 'targets.URGENT' })]);
    // The organization comes from the session; an ID in the body is not accepted.
    expect(issues({ ...valid(), organizationId: crypto.randomUUID() })).toEqual([
      expect.objectContaining({ path: '' }),
    ]);
    expect(issues({})).toEqual([expect.objectContaining({ path: 'targets' })]);
    expect(issues({ targets: [] })).toEqual([expect.objectContaining({ path: 'targets' })]);
  });

  it('covers every ticket priority', () => {
    expect(Object.keys(updateSlaPolicyRequestSchema.shape.targets.shape).sort()).toEqual(
      [...TICKET_PRIORITIES].sort(),
    );
  });

  it('describes a missing policy and missing targets as null', () => {
    expect(slaPolicyResponseSchema.parse({ policy: null })).toEqual({ policy: null });
    const policy = {
      id: crypto.randomUUID(),
      name: 'Standard',
      updatedAt: '2026-10-30T12:00:00.000Z',
      targets: { ...DEFAULT_SLA_TARGETS, LOW: null },
    };
    expect(slaPolicyResponseSchema.parse({ policy })).toEqual({ policy });
  });
});
