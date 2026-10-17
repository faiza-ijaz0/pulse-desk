import { describe, expect, it } from 'vitest';
import { TenantScopeViolationError, assertTenantScoped } from './tenant-guard.ts';

const orgId = '0b6f3f7c-6a43-4c55-9f3e-1d2c3b4a5e6f';
const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('assertTenantScoped', () => {
  it('ignores global models', () => {
    expect(() => assertTenantScoped('User', 'findUnique', { where: { id } })).not.toThrow();
    expect(() => assertTenantScoped('Organization', 'delete', { where: { id } })).not.toThrow();
  });

  it('rejects lookups of tenant data by id alone', () => {
    expect(() => assertTenantScoped('Ticket', 'findUnique', { where: { id } })).toThrow(
      TenantScopeViolationError,
    );
    expect(() => assertTenantScoped('Ticket', 'findMany', {})).toThrow(/missing organizationId/);
  });

  it('rejects unscoped bulk writes', () => {
    expect(() => assertTenantScoped('Message', 'deleteMany', { where: {} })).toThrow();
    expect(() =>
      assertTenantScoped('Ticket', 'updateMany', { where: { status: 'OPEN' }, data: {} }),
    ).toThrow();
  });

  it('accepts a direct organizationId filter', () => {
    expect(() =>
      assertTenantScoped('Ticket', 'findFirst', { where: { id, organizationId: orgId } }),
    ).not.toThrow();
  });

  it('accepts compound unique keys that include organizationId', () => {
    expect(() =>
      assertTenantScoped('Ticket', 'findUnique', {
        where: { organizationId_number: { organizationId: orgId, number: 42 } },
      }),
    ).not.toThrow();
    expect(() =>
      assertTenantScoped('Membership', 'delete', {
        where: { organizationId_userId: { organizationId: orgId, userId: id } },
      }),
    ).not.toThrow();
  });

  it('accepts organizationId inside a top-level AND', () => {
    expect(() =>
      assertTenantScoped('Customer', 'findMany', { where: { AND: [{ organizationId: orgId }] } }),
    ).not.toThrow();
  });

  it('does not treat an explicit undefined organizationId as scoped', () => {
    expect(() =>
      assertTenantScoped('Ticket', 'findMany', { where: { organizationId: undefined } }),
    ).toThrow();
  });

  it('requires organizationId on every created row', () => {
    expect(() =>
      assertTenantScoped('Tag', 'create', { data: { organizationId: orgId, name: 'vip' } }),
    ).not.toThrow();
    expect(() => assertTenantScoped('Tag', 'create', { data: { name: 'vip' } })).toThrow();
    expect(() =>
      assertTenantScoped('Tag', 'createMany', {
        data: [{ organizationId: orgId, name: 'a' }, { name: 'b' }],
      }),
    ).toThrow();
  });

  it('checks both the where and create branches of an upsert', () => {
    const where = { organizationId_name: { organizationId: orgId, name: 'vip' } };
    expect(() =>
      assertTenantScoped('Tag', 'upsert', {
        where,
        create: { organizationId: orgId, name: 'vip' },
        update: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertTenantScoped('Tag', 'upsert', { where, create: { name: 'vip' }, update: {} }),
    ).toThrow(/`create`/);
  });
});
