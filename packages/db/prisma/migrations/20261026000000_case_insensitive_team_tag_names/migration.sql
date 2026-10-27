-- Hand-written: Prisma's schema language cannot express expression indexes.
-- See docs/architecture/data-model.md ("Constraints outside schema.prisma").
--
-- Team and tag names are unique within an organization regardless of case ("VIP" and
-- "vip" are the same tag). The API already enforces this (serialized per organization);
-- these indexes make PostgreSQL enforce it too, including for writes that bypass the API.
-- The existing case-sensitive (organizationId, name) indexes stay: Prisma models them.
--
-- Existing data is never modified. If names that differ only by case already exist, the
-- migration stops with the conflicting organization and record IDs; resolve those by hand
-- (rename or merge), then run it again.

DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(format('Team: organization %s, ids %s', "organizationId", ids), E'\n')
    INTO conflicts
    FROM (
      SELECT "organizationId", string_agg("id"::text, ', ' ORDER BY "id") AS ids
        FROM "Team"
       GROUP BY "organizationId", lower("name")
      HAVING count(*) > 1
    ) duplicates;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Team names that differ only by case already exist; rename or merge them first:%', E'\n' || conflicts;
  END IF;

  SELECT string_agg(format('Tag: organization %s, ids %s', "organizationId", ids), E'\n')
    INTO conflicts
    FROM (
      SELECT "organizationId", string_agg("id"::text, ', ' ORDER BY "id") AS ids
        FROM "Tag"
       GROUP BY "organizationId", lower("name")
      HAVING count(*) > 1
    ) duplicates;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Tag names that differ only by case already exist; rename or merge them first:%', E'\n' || conflicts;
  END IF;
END
$$;

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_lower_name_key" ON "Team"("organizationId", lower("name"));

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_lower_name_key" ON "Tag"("organizationId", lower("name"));
