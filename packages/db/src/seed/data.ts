import type {
  Role,
  TicketChannel,
  TicketPriority,
  TicketStatus,
} from '../generated/prisma/enums.ts';

/**
 * Development seed fixtures. All people, companies and addresses are fictional.
 * User emails use the reserved `.test` TLD and customer emails use `example.com`,
 * so nothing here can reach a real mailbox.
 *
 * Every seeded user shares one development-only password (see SEED_PASSWORD in run.ts).
 */

export type SeedUser = { key: string; name: string; email: string };

export type SeedTicket = {
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  customerEmail: string;
  assigneeKey?: string;
  team?: string;
  tags?: string[];
  /** How long ago the ticket was opened, in minutes. */
  openedMinutesAgo: number;
  /** Minutes after opening that the first agent reply was sent (omit if none yet). */
  firstReplyAfterMinutes?: number;
  customerMessage: string;
  agentReply?: string;
  internalNote?: string;
};

export type SeedOrganization = {
  slug: string;
  name: string;
  members: { userKey: string; role: Role }[];
  teams: { name: string; memberKeys: string[] }[];
  tags: { name: string; color: string }[];
  customers: { email: string; name: string }[];
  tickets: SeedTicket[];
};

export const SEED_USERS: SeedUser[] = [
  { key: 'maya', name: 'Maya Chen', email: 'maya@brightwave.test' },
  { key: 'jonah', name: 'Jonah Reyes', email: 'jonah@brightwave.test' },
  { key: 'priya', name: 'Priya Nair', email: 'priya@brightwave.test' },
  { key: 'sam', name: 'Sam Okafor', email: 'sam@brightwave.test' },
  { key: 'elena', name: 'Elena Petrova', email: 'elena@kestrel.test' },
  { key: 'marcus', name: 'Marcus Bell', email: 'marcus@kestrel.test' },
  // Belongs to both organizations — exercises multi-org membership and isolation.
  { key: 'riley', name: 'Riley Morgan', email: 'riley@pulsedesk.test' },
];

export const SEED_ORGANIZATIONS: SeedOrganization[] = [
  {
    slug: 'brightwave',
    name: 'Brightwave Energy',
    members: [
      { userKey: 'maya', role: 'OWNER' },
      { userKey: 'jonah', role: 'ADMIN' },
      { userKey: 'priya', role: 'AGENT' },
      { userKey: 'sam', role: 'AGENT' },
      { userKey: 'riley', role: 'AGENT' },
    ],
    teams: [
      { name: 'Billing', memberKeys: ['priya', 'riley'] },
      { name: 'Technical Support', memberKeys: ['sam', 'jonah'] },
    ],
    tags: [
      { name: 'billing', color: 'violet' },
      { name: 'outage', color: 'red' },
      { name: 'smart-meter', color: 'blue' },
    ],
    customers: [
      { email: 'olivia.hart@example.com', name: 'Olivia Hart' },
      { email: 'dev.patel@example.com', name: 'Dev Patel' },
      { email: 'lena.fischer@example.com', name: 'Lena Fischer' },
    ],
    tickets: [
      {
        subject: 'Charged twice for September invoice',
        status: 'OPEN',
        priority: 'HIGH',
        channel: 'EMAIL',
        customerEmail: 'olivia.hart@example.com',
        assigneeKey: 'priya',
        team: 'Billing',
        tags: ['billing'],
        openedMinutesAgo: 95,
        firstReplyAfterMinutes: 22,
        customerMessage: 'My card shows two charges for the September invoice. Can you refund one?',
        agentReply: 'Thanks Olivia — I can see the duplicate charge and have started a refund.',
        internalNote: 'Duplicate capture from the payment retry on Sep 30. Refund requested.',
      },
      {
        subject: 'Smart meter offline since this morning',
        status: 'OPEN',
        priority: 'URGENT',
        channel: 'WEB',
        customerEmail: 'dev.patel@example.com',
        team: 'Technical Support',
        tags: ['smart-meter', 'outage'],
        openedMinutesAgo: 18,
        customerMessage: 'The meter display is blank and the app says "no recent readings".',
      },
      {
        subject: 'How do I switch to the off-peak tariff?',
        status: 'PENDING',
        priority: 'NORMAL',
        channel: 'WEB',
        customerEmail: 'lena.fischer@example.com',
        assigneeKey: 'riley',
        team: 'Billing',
        tags: ['billing'],
        openedMinutesAgo: 26 * 60,
        firstReplyAfterMinutes: 75,
        customerMessage: 'I work nights and would like to move to the off-peak tariff.',
        agentReply:
          'Happy to help! Could you confirm the account holder name so I can make the change?',
      },
      {
        subject: 'Meter reading looks too high',
        status: 'SOLVED',
        priority: 'LOW',
        channel: 'EMAIL',
        customerEmail: 'olivia.hart@example.com',
        assigneeKey: 'sam',
        team: 'Technical Support',
        tags: ['smart-meter'],
        openedMinutesAgo: 3 * 24 * 60,
        firstReplyAfterMinutes: 180,
        customerMessage: 'This month’s reading is double last month’s. Is the meter faulty?',
        agentReply:
          'The meter is healthy — the jump matches the cold snap. I’ve attached a usage breakdown.',
      },
    ],
  },
  {
    slug: 'kestrel',
    name: 'Kestrel Outfitters',
    members: [
      { userKey: 'elena', role: 'OWNER' },
      { userKey: 'marcus', role: 'AGENT' },
      { userKey: 'riley', role: 'ADMIN' },
    ],
    teams: [{ name: 'Orders', memberKeys: ['marcus', 'riley'] }],
    tags: [
      { name: 'returns', color: 'amber' },
      { name: 'shipping', color: 'blue' },
    ],
    customers: [
      { email: 'tomas.garcia@example.com', name: 'Tomás García' },
      { email: 'hana.sato@example.com', name: 'Hana Sato' },
    ],
    tickets: [
      {
        subject: 'Tent arrived with a torn rain fly',
        status: 'OPEN',
        priority: 'HIGH',
        channel: 'EMAIL',
        customerEmail: 'tomas.garcia@example.com',
        assigneeKey: 'marcus',
        team: 'Orders',
        tags: ['returns'],
        openedMinutesAgo: 140,
        firstReplyAfterMinutes: 35,
        customerMessage: 'The rain fly has a 10cm tear along the seam. I leave on a trip Friday.',
        agentReply:
          'Sorry about that, Tomás. A replacement fly is shipping today with express delivery.',
      },
      {
        subject: 'Where is my order #KO-20418?',
        status: 'ON_HOLD',
        priority: 'NORMAL',
        channel: 'WEB',
        customerEmail: 'hana.sato@example.com',
        assigneeKey: 'riley',
        team: 'Orders',
        tags: ['shipping'],
        openedMinutesAgo: 9 * 60,
        firstReplyAfterMinutes: 50,
        customerMessage: 'Tracking hasn’t updated in four days.',
        agentReply:
          'I’ve opened a trace with the carrier and will update you as soon as they reply.',
      },
    ],
  },
];
