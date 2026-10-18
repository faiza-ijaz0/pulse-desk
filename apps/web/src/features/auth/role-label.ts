import type { Role } from '@pulsedesk/shared';

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  AGENT: 'Agent',
};
