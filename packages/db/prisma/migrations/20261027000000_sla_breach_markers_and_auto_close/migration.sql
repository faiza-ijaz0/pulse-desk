-- SLA breach markers, the auto-close setting and system-generated ticket events.
-- See docs/architecture/data-model.md ("SLA clocks", "Constraints outside schema.prisma").
--
-- Additive only: new columns, constraints and indexes; no existing row is rewritten except
-- by a column default, and nothing is backfilled. In particular no historical breach is
-- inferred: breach markers and events start with the SLA sweep (Phase 5C).
--
-- Rolling back by hand, if ever needed: drop the indexes and constraints below, then the
-- new columns and the "TicketEventActorType" type.

-- CreateEnum
CREATE TYPE "TicketEventActorType" AS ENUM ('USER', 'SYSTEM');

-- AlterTable
-- Hand-edited: organizations that already exist keep today's behaviour (no automatic
-- closing) until an admin enables it; organizations created from now on start enabled. The
-- column default ends up `true`, matching schema.prisma.
ALTER TABLE "Organization" ADD COLUMN     "autoCloseAfterMinutes" INTEGER NOT NULL DEFAULT 5760,
ADD COLUMN     "autoCloseEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ALTER COLUMN "autoCloseEnabled" SET DEFAULT true;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "firstResponseBreachedAt" TIMESTAMP(3),
ADD COLUMN     "resolutionBreachedAt" TIMESTAMP(3);

-- AlterTable
-- Every event written so far came from a user (a null actorUserId means the account was
-- deleted since), so `USER` is the correct value for existing rows.
ALTER TABLE "TicketEvent" ADD COLUMN     "actorType" "TicketEventActorType" NOT NULL DEFAULT 'USER';

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and indexes that Prisma's schema language cannot express.
-- ─────────────────────────────────────────────────────────────────────────────

-- Auto-close delay: at least a minute, at most a year.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_autoCloseAfterMinutes_check"
  CHECK ("autoCloseAfterMinutes" BETWEEN 1 AND 525600);

-- A system event has no user, so it can never be mistaken for one by a deleted user.
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_system_actor_check"
  CHECK ("actorType" = 'USER' OR "actorUserId" IS NULL);

-- At most one breach event per ticket and SLA target, so a repeated or concurrent sweep can
-- never record the same breach twice. No code wrote these events before this migration; if
-- duplicates exist anyway, stop and name them rather than delete history.
DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(format('organization %s, ticket %s, %s', "organizationId", "ticketId", "type"), E'\n')
    INTO conflicts
    FROM (
      SELECT "organizationId", "ticketId", "type"
        FROM "TicketEvent"
       WHERE "type" IN ('SLA_FIRST_RESPONSE_BREACHED', 'SLA_RESOLUTION_BREACHED')
       GROUP BY "organizationId", "ticketId", "type"
      HAVING count(*) > 1
    ) duplicates;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Tickets already have more than one SLA breach event of a kind; resolve them first:%', E'\n' || conflicts;
  END IF;
END
$$;

CREATE UNIQUE INDEX "TicketEvent_one_sla_breach_per_ticket_key" ON "TicketEvent"("ticketId", "type")
  WHERE "type" IN ('SLA_FIRST_RESPONSE_BREACHED', 'SLA_RESOLUTION_BREACHED');

-- Sweep candidates. Each index holds only tickets that may still need work, so it stays small
-- as history grows: met targets and recorded breaches drop out. Queries must repeat the
-- predicate for PostgreSQL to use the index.

-- First response: no breach recorded yet, and no reply or a late one.
CREATE INDEX "Ticket_first_response_breach_sweep_idx" ON "Ticket"("firstResponseDueAt")
  WHERE "firstResponseDueAt" IS NOT NULL
    AND "firstResponseBreachedAt" IS NULL
    AND ("firstRespondedAt" IS NULL OR "firstRespondedAt" > "firstResponseDueAt");

-- Resolution: no breach recorded yet, and unsolved (active, or reopened) or solved late.
CREATE INDEX "Ticket_resolution_breach_sweep_idx" ON "Ticket"("resolutionDueAt")
  WHERE "resolutionDueAt" IS NOT NULL
    AND "resolutionBreachedAt" IS NULL
    AND ("solvedAt" IS NULL OR "solvedAt" > "resolutionDueAt");

-- Auto-close: solved tickets, oldest solve first.
CREATE INDEX "Ticket_auto_close_sweep_idx" ON "Ticket"("solvedAt")
  WHERE "status" = 'SOLVED';
