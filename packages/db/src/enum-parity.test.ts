import { ROLES, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES } from '@pulsedesk/shared';
import { describe, expect, it } from 'vitest';
import { Role, TicketChannel, TicketPriority, TicketStatus } from './generated/prisma/enums.ts';

// @pulsedesk/shared must not depend on Prisma, so it declares these enums itself.
// This test fails if the Prisma schema and the shared contracts drift apart.
describe('shared enums match the Prisma schema', () => {
  it.each([
    ['Role', Object.values(Role), ROLES],
    ['TicketStatus', Object.values(TicketStatus), TICKET_STATUSES],
    ['TicketPriority', Object.values(TicketPriority), TICKET_PRIORITIES],
    ['TicketChannel', Object.values(TicketChannel), TICKET_CHANNELS],
  ])('%s', (_name, prismaValues, sharedValues) => {
    expect([...sharedValues]).toEqual(prismaValues);
  });
});
