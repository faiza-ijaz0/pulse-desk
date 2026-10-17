import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, canManageRole, hasPermission } from './roles.ts';

describe('hasPermission', () => {
  it('grants owners every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission('OWNER', permission)).toBe(true);
    }
  });

  it('keeps destructive organization actions owner-only', () => {
    for (const role of ['ADMIN', 'AGENT'] as const) {
      expect(hasPermission(role, 'organization:delete')).toBe(false);
      expect(hasPermission(role, 'organization:transfer-ownership')).toBe(false);
    }
  });

  it('lets agents work tickets but not administer the organization', () => {
    expect(hasPermission('AGENT', 'ticket:read')).toBe(true);
    expect(hasPermission('AGENT', 'ticket:reply')).toBe(true);
    expect(hasPermission('AGENT', 'member:invite')).toBe(false);
    expect(hasPermission('AGENT', 'sla:manage')).toBe(false);
    expect(hasPermission('AGENT', 'analytics:read-all')).toBe(false);
  });

  it('gives admins a strict superset of agent permissions', () => {
    for (const permission of PERMISSIONS) {
      if (hasPermission('AGENT', permission)) {
        expect(hasPermission('ADMIN', permission)).toBe(true);
      }
    }
  });
});

describe('canManageRole', () => {
  it('lets only owners manage owners', () => {
    expect(canManageRole('OWNER', 'OWNER')).toBe(true);
    expect(canManageRole('ADMIN', 'OWNER')).toBe(false);
  });

  it('lets admins manage admins and agents', () => {
    expect(canManageRole('ADMIN', 'ADMIN')).toBe(true);
    expect(canManageRole('ADMIN', 'AGENT')).toBe(true);
  });

  it('never lets agents manage roles', () => {
    for (const target of ROLES) {
      expect(canManageRole('AGENT', target)).toBe(false);
    }
  });
});
