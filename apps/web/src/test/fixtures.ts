import type { Customer, Tag, Team, TicketSummary } from '@pulsedesk/shared';
import { SIGNED_IN_SESSION } from './render';

// Contract-shaped fixtures for feature tests. IDs are fixed, valid v4 UUIDs.

export const ME = SIGNED_IN_SESSION.user.id;
export const AGENT_ID = '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f';
export const ADA_ID = '11111111-1111-4111-8111-111111111111';
export const BILLING_ID = '7e6d5c4b-3a29-4f18-8e07-d6c5b4a39281';
export const VIP_ID = '3b2a1908-f7e6-4d5c-8b4a-39281706f5e4';

export const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

export function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

export function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: ADA_ID,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    createdAt: '2026-10-01T09:00:00.000Z',
    ticketCount: 2,
    activeTicketCount: 1,
    ...overrides,
  };
}

export function ticketSummary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: '00000000-0000-4000-8000-000000000012',
    number: 12,
    subject: 'Refund for duplicate charge',
    status: 'OPEN',
    priority: 'NORMAL',
    channel: 'EMAIL',
    customer: { id: ADA_ID, name: 'Ada Lovelace', email: 'ada@example.com' },
    assignee: null,
    team: null,
    tags: [],
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstRespondedAt: null,
    solvedAt: null,
    closedAt: null,
    firstResponseBreachedAt: null,
    resolutionBreachedAt: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
    ...overrides,
  };
}

export function team(overrides: Partial<Team> = {}): Team {
  return { id: BILLING_ID, name: 'Billing', members: [], ...overrides };
}

export function tag(overrides: Partial<Tag> = {}): Tag {
  return { id: VIP_ID, name: 'vip', color: 'amber', ticketCount: 3, ...overrides };
}

export const MEMBERS = {
  data: [
    {
      userId: ME,
      name: 'Maya Chen',
      email: 'maya@brightwave.test',
      role: 'OWNER',
      joinedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      userId: AGENT_ID,
      name: 'Jonah Reyes',
      email: 'jonah@brightwave.test',
      role: 'AGENT',
      joinedAt: '2026-10-02T00:00:00.000Z',
    },
  ],
};

/** The signed-in session with the active organization's role replaced. */
export function sessionAs(role: 'OWNER' | 'ADMIN' | 'AGENT') {
  return {
    ...SIGNED_IN_SESSION,
    activeOrganization: { ...SIGNED_IN_SESSION.activeOrganization, role },
  };
}
