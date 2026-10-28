import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkspaceEnv } from '../src/env.ts';
import { assertSafeInTransaction } from '../src/migration-sql-guard.ts';
import { testDatabaseUrl } from './helpers.ts';

loadWorkspaceEnv();

/**
 * Upgrading a database that already has data, which the reset (always an empty database)
 * can't show. The earlier migrations run in a throwaway schema inside one transaction, rows
 * are added as the old schema allowed, then the migration under test runs. The transaction
 * is always rolled back, so nothing is left in the test database — not even the schema.
 * Every migration's SQL is checked first (assertSafeInTransaction): transaction control,
 * CONCURRENTLY and the like would end or break the outer transaction, so the test refuses to
 * run them rather than risk leaving objects behind.
 */
const UPGRADE = '20261027000000_sla_breach_markers_and_auto_close';
const MIGRATIONS = new URL('../prisma/migrations/', import.meta.url);
const migrationSql = (name: string) =>
  assertSafeInTransaction(name, readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8'));
const EARLIER = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name < UPGRADE)
  .map((entry) => entry.name)
  .sort();

const ORG = '11111111-1111-4111-8111-111111111111';
const NEW_ORG = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';
const USER = '66666666-6666-4666-8666-666666666666';
const BY_DELETED_USER = '44444444-4444-4444-8444-444444444441';
const NEVER_HAD_USER = '44444444-4444-4444-8444-444444444442';

let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

/** Runs `fn` against a fresh schema at the state before UPGRADE, then rolls everything back. */
async function inThrowawaySchema(fn: (schema: string) => Promise<void>): Promise<void> {
  // Check every migration before the transaction opens, so a refusal leaves nothing to undo.
  for (const name of [...EARLIER, UPGRADE]) migrationSql(name);
  const schema = `migration_upgrade_${randomUUID().replaceAll('-', '')}`;
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const name of EARLIER) await client.query(migrationSql(name));
    await fn(schema);
  } finally {
    await client.query('ROLLBACK');
  }
}

describe(`upgrading existing data with ${UPGRADE}`, () => {
  it('keeps existing organizations, tickets and events as they were', async () => {
    expect(EARLIER.length).toBeGreaterThanOrEqual(3);

    await inThrowawaySchema(async (schema) => {
      // Data as it existed before the migration: an overdue ticket nobody replied to, an
      // event by a user whose account was then deleted, and one recorded without a user.
      await client.query(
        `INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ($1, 'Existing', 'existing', now())`,
        [ORG],
      );
      await client.query(
        `INSERT INTO "Customer" (id, "organizationId", email, "updatedAt") VALUES ($1, $2, 'c@example.com', now())`,
        [CUSTOMER, ORG],
      );
      await client.query(
        `INSERT INTO "Ticket" (id, "organizationId", number, subject, "customerId",
           "firstResponseDueAt", "resolutionDueAt", "createdAt", "updatedAt")
         VALUES ($1, $2, 1, 'Overdue', $3, now() - interval '2 days', now() - interval '1 day',
           now() - interval '3 days', now())`,
        [TICKET, ORG, CUSTOMER],
      );
      await client.query(
        `INSERT INTO "User" (id, email, name, "passwordHash", "updatedAt") VALUES ($1, 'gone@example.com', 'Gone', 'x', now())`,
        [USER],
      );
      await client.query(
        `INSERT INTO "TicketEvent" (id, "organizationId", "ticketId", "actorUserId", type, data)
         VALUES ($1, $3, $4, $5, 'STATUS_CHANGED', '{"from":"OPEN","to":"PENDING"}'),
                ($2, $3, $4, NULL, 'CREATED', '{}')`,
        [BY_DELETED_USER, NEVER_HAD_USER, ORG, TICKET, USER],
      );
      await client.query(`DELETE FROM "User" WHERE id = $1`, [USER]);

      await client.query(migrationSql(UPGRADE));

      // Existing organizations keep today's behaviour: nothing closes automatically.
      const organizations = await client.query(
        `SELECT "autoCloseEnabled", "autoCloseAfterMinutes" FROM "Organization" WHERE id = $1`,
        [ORG],
      );
      expect(organizations.rows).toEqual([
        { autoCloseEnabled: false, autoCloseAfterMinutes: 5760 },
      ]);

      // No breach is inferred for the overdue ticket.
      const tickets = await client.query(
        `SELECT "firstResponseBreachedAt", "resolutionBreachedAt", "firstResponseDueAt" < now() AS overdue
           FROM "Ticket" WHERE id = $1`,
        [TICKET],
      );
      expect(tickets.rows).toEqual([
        { firstResponseBreachedAt: null, resolutionBreachedAt: null, overdue: true },
      ]);
      const breaches = await client.query(
        `SELECT count(*)::int AS n FROM "TicketEvent" WHERE type::text LIKE 'SLA_%'`,
      );
      expect(breaches.rows).toEqual([{ n: 0 }]);

      // Every existing event was a person's, including the deleted user's.
      const events = await client.query(
        `SELECT id, "actorType"::text AS "actorType", "actorUserId" FROM "TicketEvent" ORDER BY id`,
      );
      expect(events.rows).toEqual([
        { id: BY_DELETED_USER, actorType: 'USER', actorUserId: null },
        { id: NEVER_HAD_USER, actorType: 'USER', actorUserId: null },
      ]);

      // Organizations created after the migration start enabled.
      await client.query(
        `INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ($1, 'New', 'new', now())`,
        [NEW_ORG],
      );
      const created = await client.query(
        `SELECT "autoCloseEnabled", "autoCloseAfterMinutes" FROM "Organization" WHERE id = $1`,
        [NEW_ORG],
      );
      expect(created.rows).toEqual([{ autoCloseEnabled: true, autoCloseAfterMinutes: 5760 }]);

      // The hand-written objects exist in this schema.
      const indexes = await client.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = $1 AND indexname IN (
            'TicketEvent_one_sla_breach_per_ticket_key', 'Ticket_first_response_breach_sweep_idx',
            'Ticket_resolution_breach_sweep_idx', 'Ticket_auto_close_sweep_idx')
          ORDER BY indexname`,
        [schema],
      );
      expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toEqual([
        'TicketEvent_one_sla_breach_per_ticket_key',
        'Ticket_auto_close_sweep_idx',
        'Ticket_first_response_breach_sweep_idx',
        'Ticket_resolution_breach_sweep_idx',
      ]);
    });

    // Rolled back: the throwaway schema is gone.
    const left = await client.query(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'migration\\_upgrade\\_%'`,
    );
    expect(left.rows).toEqual([{ n: 0 }]);
  });
});
