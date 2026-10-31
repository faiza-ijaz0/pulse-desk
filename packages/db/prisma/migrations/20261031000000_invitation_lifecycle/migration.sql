-- Invitation lifecycle: revocation, who accepted, and the rules that keep invitations safe.
-- See docs/architecture/auth-and-sessions.md ("Invitations") and data-model.md ("Constraints
-- outside schema.prisma").
--
-- Additive only: two nullable columns, a foreign key, CHECK constraints and a partial unique
-- index. No code wrote invitations before this migration; if rows exist that break the new
-- rules anyway, it stops and names them rather than rewrite or delete them.
--
-- Rolling back by hand, if ever needed: first delete the invitations that have ended
-- (DELETE FROM "Invitation" WHERE "revokedAt" IS NOT NULL OR "acceptedAt" IS NOT NULL; their
-- history stays in AuditLog). Dropping "revokedAt" otherwise turns every revoked invitation
-- back into an open one, its link valid again for a later API, and re-applying this
-- migration would stop on the resulting duplicate open invitations. Then drop the index and
-- constraints below, then the foreign key and the two columns.

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "acceptedByUserId" UUID,
ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and indexes that Prisma's schema language cannot express.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(format('invitation %s in organization %s', "id", "organizationId"), E'\n')
    INTO conflicts
    FROM "Invitation"
   WHERE "email" <> lower(btrim("email"))
      OR "role" = 'OWNER'
      OR ("organizationId", "email") IN (
           SELECT "organizationId", "email" FROM "Invitation"
            WHERE "acceptedAt" IS NULL
            GROUP BY "organizationId", "email"
           HAVING count(*) > 1
         );
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Invitations break the new rules (normalized email, no OWNER role, one open per email); resolve them first:%', E'\n' || conflicts;
  END IF;
END
$$;

-- Emails are compared as stored, so they must be stored normalized (as User.email is).
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_email_normalized_check"
  CHECK ("email" = lower(btrim("email")) AND "email" <> '');

-- Ownership is never granted by invitation; an owner promotes a member instead.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_role_check"
  CHECK ("role" <> 'OWNER');

-- An invitation ends once: accepted or revoked, never both. An acceptor implies acceptance
-- (the acceptor may later be deleted, leaving acceptedAt with a null acceptedByUserId).
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_single_outcome_check"
  CHECK (("acceptedAt" IS NULL OR "revokedAt" IS NULL)
     AND ("acceptedByUserId" IS NULL OR "acceptedAt" IS NOT NULL));

-- At most one open invitation (neither accepted nor revoked) per organization and email.
-- Re-inviting revokes the previous one in the same transaction. Expired invitations still
-- count as open here; they are revoked by the next invitation to the same email.
CREATE UNIQUE INDEX "Invitation_one_open_per_email_key"
  ON "Invitation"("organizationId", "email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
