import { z } from 'zod';

/** Must stay identical to the `Role` enum in packages/db/prisma/schema.prisma (enforced by a test there). */
export const ROLES = ['OWNER', 'ADMIN', 'AGENT'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const PERMISSIONS = [
  'ticket:read',
  'ticket:reply',
  'ticket:assign',
  'ticket:manage-settings',
  'customer:update',
  'team:manage',
  'tag:manage',
  'sla:manage',
  'member:read',
  'member:invite',
  'member:remove',
  'member:change-role',
  'analytics:read-all',
  'analytics:read-own',
  'organization:update',
  'organization:delete',
  'organization:transfer-ownership',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const AGENT_PERMISSIONS = [
  'ticket:read',
  'ticket:reply',
  'ticket:assign',
  'customer:update',
  'member:read',
  'analytics:read-own',
] as const satisfies readonly Permission[];

const ADMIN_PERMISSIONS = [
  ...AGENT_PERMISSIONS,
  'ticket:manage-settings',
  'team:manage',
  'tag:manage',
  'sla:manage',
  'member:invite',
  'member:remove',
  'member:change-role',
  'analytics:read-all',
  'organization:update',
] as const satisfies readonly Permission[];

/**
 * Single source of truth for role → permission mapping. The web app uses it to hide
 * controls; the API uses it to enforce access. The API is always the authority.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(ADMIN_PERMISSIONS),
  AGENT: new Set(AGENT_PERMISSIONS),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

const ROLE_RANK: Readonly<Record<Role, number>> = { AGENT: 0, ADMIN: 1, OWNER: 2 };

/**
 * Whether `actor` may assign `targetRole` to someone (or change/remove a member who holds it).
 * Admins manage agents and other admins, but only owners manage owners.
 */
export function canManageRole(actor: Role, targetRole: Role): boolean {
  if (!hasPermission(actor, 'member:change-role')) return false;
  return actor === 'OWNER' || ROLE_RANK[targetRole] < ROLE_RANK.OWNER;
}
