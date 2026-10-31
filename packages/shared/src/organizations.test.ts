import { describe, expect, it } from 'vitest';
import {
  AUTO_CLOSE_MAX_MINUTES,
  AUTO_CLOSE_MIN_MINUTES,
  organizationSchema,
  updateOrganizationRequestSchema,
} from './organizations.ts';

describe('organization settings contract', () => {
  it('bounds the auto-close delay exactly like Organization_autoCloseAfterMinutes_check', () => {
    expect(AUTO_CLOSE_MIN_MINUTES).toBe(1);
    expect(AUTO_CLOSE_MAX_MINUTES).toBe(525_600);
    const ok = (minutes: unknown) =>
      updateOrganizationRequestSchema.safeParse({ autoCloseAfterMinutes: minutes }).success;
    expect([1, 60, 5760, 525_600].map(ok)).toEqual([true, true, true, true]);
    expect([0, -1, 525_601, 1.5, '60', null].map(ok)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('accepts any subset of settings, and refuses an empty change', () => {
    const parse = (input: unknown) => updateOrganizationRequestSchema.safeParse(input).success;
    expect(parse({ name: 'Acme Support' })).toBe(true);
    expect(parse({ autoCloseEnabled: false })).toBe(true);
    expect(parse({ autoCloseEnabled: true, autoCloseAfterMinutes: 1440 })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ autoCloseEnabled: 'yes' })).toBe(false);
  });

  it('returns the auto-close settings with the organization', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Acme',
      slug: 'acme-1a2b3c',
      createdAt: '2026-10-20T08:00:00.000Z',
    };
    expect(
      organizationSchema.safeParse({ ...base, autoCloseEnabled: true, autoCloseAfterMinutes: 5760 })
        .success,
    ).toBe(true);
    expect(organizationSchema.safeParse(base).success).toBe(false);
  });
});
