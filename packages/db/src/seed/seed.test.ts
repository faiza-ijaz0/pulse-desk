import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client.ts';
import { SEED_ORGANIZATIONS } from './data.ts';
import { seedDatabase } from './seed.ts';

// No database: a stand-in for Prisma records every `tx.<model>.<operation>(args)` call the
// seed makes, and answers creates with a fresh ID.
type Call = { model: string; operation: string; args: { data?: Record<string, unknown> } };

function recordingDatabase(): { db: Database; calls: Call[] } {
  const calls: Call[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, operation: string) => (args: Call['args']) => {
          calls.push({ model: name, operation, args });
          return Promise.resolve(operation.endsWith('Many') ? { count: 0 } : { id: randomUUID() });
        },
      },
    );
  const tx = new Proxy({}, { get: (_target, name: string) => model(name) });
  const db = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  return { db: db as unknown as Database, calls };
}

describe('development seed: ticket events', () => {
  it('records each seeded ticket’s CREATED event as PulseDesk’s (SYSTEM, without a user)', async () => {
    const { db, calls } = recordingDatabase();
    await seedDatabase(db, {
      passwordHash: 'not-a-real-hash',
      now: new Date('2026-10-20T08:00:00Z'),
    });

    const events = calls.filter((c) => c.model === 'ticketEvent').map((c) => c.args.data);
    const tickets = SEED_ORGANIZATIONS.reduce((n, org) => n + org.tickets.length, 0);
    expect(events).toHaveLength(tickets);
    for (const event of events) {
      expect(event).toMatchObject({ type: 'CREATED', actorType: 'SYSTEM' });
      // TicketEvent_system_actor_check: a SYSTEM event never names a user.
      expect(event?.actorUserId ?? null).toBeNull();
    }
  });
});
