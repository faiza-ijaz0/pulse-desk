/**
 * ─── SAMPLE DATA ─────────────────────────────────────────────────────────────
 * Static, hand-written fixtures for the dashboard design preview. Nothing here comes
 * from the API or a database, and the UI labels it as sample data wherever it appears.
 * Replace with real queries when tickets (Phase 4) and analytics (Phase 6) exist.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { TicketPriority, TicketStatus } from '@pulsedesk/shared';

export type StatTile = {
  id: string;
  label: string;
  value: string;
  delta: { text: string; direction: 'up' | 'down'; good: boolean };
  comparison: string;
  /** 7 daily points, oldest first. */
  trend: number[];
};

export const SAMPLE_STATS: StatTile[] = [
  {
    id: 'open',
    label: 'Open tickets',
    value: '128',
    delta: { text: '+9', direction: 'up', good: false },
    comparison: 'vs previous 7 days',
    trend: [104, 110, 108, 117, 121, 119, 128],
  },
  {
    id: 'first-response',
    label: 'Median first response',
    value: '38m',
    delta: { text: '−6m', direction: 'down', good: true },
    comparison: 'vs previous 7 days',
    trend: [51, 47, 49, 44, 42, 40, 38],
  },
  {
    id: 'sla',
    label: 'SLA compliance',
    value: '94.2%',
    delta: { text: '+1.3 pts', direction: 'up', good: true },
    comparison: 'vs previous 7 days',
    trend: [91.8, 92.4, 92.1, 93.0, 93.6, 93.9, 94.2],
  },
  {
    id: 'resolved',
    label: 'Resolved',
    value: '312',
    delta: { text: '+24', direction: 'up', good: true },
    comparison: 'vs previous 7 days',
    trend: [38, 44, 41, 47, 49, 45, 48],
  },
];

export type VolumePoint = { day: string; created: number; solved: number };

export const SAMPLE_VOLUME: VolumePoint[] = [
  { day: 'Thu', created: 52, solved: 38 },
  { day: 'Fri', created: 48, solved: 44 },
  { day: 'Sat', created: 21, solved: 41 },
  { day: 'Sun', created: 18, solved: 47 },
  { day: 'Mon', created: 63, solved: 49 },
  { day: 'Tue', created: 57, solved: 45 },
  { day: 'Wed', created: 54, solved: 48 },
];

export type SampleTicket = {
  number: number;
  subject: string;
  customer: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: string | null;
  updated: string;
};

export const SAMPLE_TICKETS: SampleTicket[] = [
  {
    number: 1042,
    subject: 'Charged twice for September invoice',
    customer: 'Olivia Hart',
    status: 'OPEN',
    priority: 'HIGH',
    assignee: 'Priya Nair',
    updated: '4m ago',
  },
  {
    number: 1041,
    subject: 'Smart meter offline since this morning',
    customer: 'Dev Patel',
    status: 'OPEN',
    priority: 'URGENT',
    assignee: null,
    updated: '12m ago',
  },
  {
    number: 1039,
    subject: 'How do I switch to the off-peak tariff?',
    customer: 'Lena Fischer',
    status: 'PENDING',
    priority: 'NORMAL',
    assignee: 'Riley Morgan',
    updated: '38m ago',
  },
  {
    number: 1036,
    subject: 'Export usage history as CSV',
    customer: 'Marco Bianchi',
    status: 'ON_HOLD',
    priority: 'LOW',
    assignee: 'Sam Okafor',
    updated: '1h ago',
  },
  {
    number: 1033,
    subject: 'Meter reading looks too high',
    customer: 'Olivia Hart',
    status: 'SOLVED',
    priority: 'LOW',
    assignee: 'Sam Okafor',
    updated: '3h ago',
  },
  {
    number: 1031,
    subject: 'Update billing address after move',
    customer: 'Aisha Rahman',
    status: 'SOLVED',
    priority: 'NORMAL',
    assignee: 'Priya Nair',
    updated: '5h ago',
  },
];

export type AtRiskTicket = {
  number: number;
  subject: string;
  target: 'First response' | 'Resolution';
  /** Minutes until breach. */
  dueInMinutes: number;
};

export const SAMPLE_AT_RISK: AtRiskTicket[] = [
  {
    number: 1041,
    subject: 'Smart meter offline since this morning',
    target: 'First response',
    dueInMinutes: 12,
  },
  { number: 1027, subject: 'Direct debit failed twice', target: 'Resolution', dueInMinutes: 47 },
  {
    number: 1042,
    subject: 'Charged twice for September invoice',
    target: 'Resolution',
    dueInMinutes: 95,
  },
];

export type AgentLoad = { name: string; team: string; open: number; capacity: number };

export const SAMPLE_WORKLOAD: AgentLoad[] = [
  { name: 'Priya Nair', team: 'Billing', open: 14, capacity: 15 },
  { name: 'Sam Okafor', team: 'Technical Support', open: 11, capacity: 15 },
  { name: 'Riley Morgan', team: 'Billing', open: 9, capacity: 12 },
  { name: 'Jonah Reyes', team: 'Technical Support', open: 5, capacity: 10 },
];
