import {
  BarChart3,
  Gauge,
  Inbox,
  LayoutDashboard,
  Palette,
  Settings,
  Timer,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * `preview`  – page exists and renders clearly-labelled sample data.
 * `planned`  – page explains the feature and the phase that delivers it; no fake UI.
 * `available`– fully functional page.
 */
export type NavStatus = 'available' | 'preview' | 'planned';

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  status: NavStatus;
  /** Shown on planned pages: what the feature will do. */
  summary: string;
  phase?: string;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      {
        label: 'Dashboard',
        to: '/dashboard',
        icon: LayoutDashboard,
        status: 'preview',
        summary: 'Queue health, SLA risk and team workload at a glance.',
      },
      {
        label: 'Tickets',
        to: '/tickets',
        icon: Inbox,
        status: 'available',
        summary: 'The ticket inbox: filter by status, priority, assignee, team and tag.',
      },
      {
        label: 'Customers',
        to: '/customers',
        icon: Users,
        status: 'available',
        summary:
          'Every customer’s contact details and ticket history, searchable by name or email.',
      },
    ],
  },
  {
    label: 'Team',
    items: [
      {
        label: 'Agents & teams',
        to: '/team',
        icon: UsersRound,
        status: 'available',
        summary: 'Organization members and their roles, and the teams tickets are assigned to.',
      },
      {
        label: 'Analytics',
        to: '/analytics',
        icon: BarChart3,
        status: 'planned',
        phase: 'Phase 6',
        summary:
          'Response and resolution times, SLA compliance and agent throughput over any period.',
      },
    ],
  },
  {
    label: 'Configure',
    items: [
      {
        label: 'SLA policies',
        to: '/sla',
        icon: Timer,
        status: 'available',
        summary:
          'First-response and resolution targets per priority, with automatic breach detection.',
      },
      {
        label: 'Settings',
        to: '/settings',
        icon: Settings,
        status: 'available',
        summary: 'Organization profile and the tags used on tickets.',
      },
      {
        label: 'Design system',
        to: '/design-system',
        icon: Palette,
        status: 'available',
        summary: 'Tokens, components and interaction states used across PulseDesk.',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}

export const BRAND_ICON: LucideIcon = Gauge;
