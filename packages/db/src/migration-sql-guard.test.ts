import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertSafeInTransaction, transactionSafetyProblems } from './migration-sql-guard.ts';

const problems = (sql: string) => transactionSafetyProblems(sql);

describe('transactionSafetyProblems — the committed migrations', () => {
  const directory = new URL('../prisma/migrations/', import.meta.url);
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('finds them', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(4);
  });

  it.each(migrations)('accepts %s', (name) => {
    const sql = readFileSync(new URL(`${name}/migration.sql`, directory), 'utf8');
    expect(problems(sql)).toEqual([]);
  });
});

describe('transactionSafetyProblems — transaction control', () => {
  it.each([
    ['BEGIN;', /transaction control \(BEGIN\)/],
    ['begin transaction;', /transaction control \(BEGIN\)/],
    ['START TRANSACTION;', /transaction control \(START\)/],
    ['COMMIT;', /transaction control \(COMMIT\)/],
    ['commit', /transaction control \(COMMIT\)/],
    ['END;', /transaction control \(END\)/],
    ['ROLLBACK;', /transaction control \(ROLLBACK\)/],
    ['ROLLBACK TO SAVEPOINT a;', /transaction control \(ROLLBACK\)/],
    ['ABORT;', /transaction control \(ABORT\)/],
    ['SAVEPOINT a;', /transaction control \(SAVEPOINT\)/],
    ['RELEASE SAVEPOINT a;', /transaction control \(RELEASE\)/],
    ["PREPARE TRANSACTION 'x';", /transaction control \(PREPARE\)/],
    ["COMMIT PREPARED 'x';", /transaction control \(COMMIT\)/],
    ['CALL do_work();', /transaction control \(CALL\)/],
  ])('refuses %s', (sql, message) => {
    expect(problems(sql).join('\n')).toMatch(message);
  });

  it('names the offending statement', () => {
    expect(problems('CREATE TABLE a (id int);\nCOMMIT;\nCREATE TABLE b (id int);')).toEqual([
      'Statement 2 is transaction control (COMMIT)',
    ]);
  });
});

describe('transactionSafetyProblems — statements unsafe in a transaction block', () => {
  it.each([
    'CREATE INDEX CONCURRENTLY "i" ON "t" ("c");',
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" ("c");',
    'DROP INDEX CONCURRENTLY "i";',
    'REINDEX INDEX CONCURRENTLY "i";',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY "v";',
    'ALTER TABLE "p" DETACH PARTITION "c" CONCURRENTLY;',
  ])('refuses %s', (sql) => {
    expect(problems(sql).join('\n')).toMatch(/uses CONCURRENTLY/);
  });

  it.each([
    ['VACUUM "t";', /can't run inside a transaction block \(VACUUM\)/],
    ['CLUSTER;', /can't run inside a transaction block \(CLUSTER\)/],
    ['REINDEX TABLE "t";', /can't run inside a transaction block \(REINDEX\)/],
    ['DISCARD ALL;', /can't run inside a transaction block \(DISCARD\)/],
    ['CREATE DATABASE x;', /cluster-wide object \(CREATE DATABASE\)/],
    ['DROP DATABASE x;', /cluster-wide object \(DROP DATABASE\)/],
    ["CREATE TABLESPACE t LOCATION '/x';", /cluster-wide object \(CREATE TABLESPACE\)/],
    ["ALTER SYSTEM SET work_mem = '1MB';", /cluster-wide object \(ALTER SYSTEM\)/],
    ['ALTER TYPE "Role" ADD VALUE \'GUEST\';', /adds an enum value/],
    ["ALTER TYPE \"Role\" ADD VALUE IF NOT EXISTS 'GUEST' AFTER 'AGENT';", /adds an enum value/],
  ])('refuses %s', (sql, message) => {
    expect(problems(sql).join('\n')).toMatch(message);
  });

  it('still allows renaming an enum value or creating a type', () => {
    expect(problems("ALTER TYPE \"Role\" RENAME VALUE 'A' TO 'B';")).toEqual([]);
    expect(problems("CREATE TYPE \"T\" AS ENUM ('A', 'B');")).toEqual([]);
  });
});

describe('transactionSafetyProblems — escaping the throwaway schema or transaction', () => {
  it.each([
    ['SET search_path TO public;', /changes session settings \(SET\)/],
    ['SET LOCAL search_path TO public;', /changes session settings \(SET\)/],
    ['RESET search_path;', /changes session settings \(RESET\)/],
    ["SELECT set_config('search_path', 'public', true);", /calls set_config/],
    ['INSERT INTO public."Ticket" DEFAULT VALUES;', /public schema/],
    ['ALTER TABLE "public"."Ticket" ADD COLUMN "x" INT;', /public schema/],
    ['SELECT * FROM PUBLIC . "Ticket";', /public schema/],
    ["SELECT dblink_exec('dbname=x', 'COMMIT');", /uses dblink/],
    ['EXECUTE prepared_statement;', /runs a prepared statement/],
  ])('refuses %s', (sql, message) => {
    expect(problems(sql).join('\n')).toMatch(message);
  });
});

describe('transactionSafetyProblems — dollar-quoted bodies', () => {
  it('accepts a DO block whose BEGIN/END are PL/pgSQL blocks', () => {
    const sql = `DO $$
      DECLARE n int;
      BEGIN
        SELECT count(*) INTO n FROM "Team";
        IF n > 0 THEN RAISE EXCEPTION 'found %; stop', n; END IF;
        UPDATE "Team" SET "name" = "name" WHERE false;
      END
    $$;`;
    expect(problems(sql)).toEqual([]);
  });

  it.each([
    ['DO $$ BEGIN COMMIT; END $$;', /COMMIT in a dollar-quoted body/],
    ['DO $body$ BEGIN ROLLBACK; END $body$;', /ROLLBACK in a dollar-quoted body/],
    ["DO $$ BEGIN EXECUTE 'COMMIT'; END $$;", /EXECUTE in a dollar-quoted body/],
    ["DO $$ BEGIN PERFORM set_config('search_path', 'public', true); END $$;", /set_config/],
    ['DO $$ BEGIN INSERT INTO public."Ticket" DEFAULT VALUES; END $$;', /public schema/],
    ["DO $$ BEGIN PERFORM dblink_exec('x', 'y'); END $$;", /dblink/],
    [
      'CREATE FUNCTION f() RETURNS void AS $f$ BEGIN DO $i$ BEGIN COMMIT; END $i$; END $f$ LANGUAGE plpgsql;',
      /COMMIT in a dollar-quoted body/,
    ],
  ])('refuses %s', (sql, message) => {
    expect(problems(sql).join('\n')).toMatch(message);
  });

  it('fails closed on a dollar-quoted body that is not SQL', () => {
    expect(problems("SELECT $$it's plain text$$;").join('\n')).toMatch(
      /dollar-quoted body that can't be scanned/,
    );
  });

  it('does not mistake positional parameters for dollar quotes', () => {
    expect(problems('SELECT $1, $2;')).toEqual([]);
  });
});

describe('transactionSafetyProblems — no false positives from comments, strings or names', () => {
  it.each([
    ['a line comment', '-- COMMIT; BEGIN; ROLLBACK;\nCREATE TABLE a (id int);'],
    ['a block comment', '/* COMMIT; DROP INDEX CONCURRENTLY x; */ CREATE TABLE a (id int);'],
    ['a nested block comment', '/* outer /* COMMIT; */ still comment; */ CREATE TABLE a (id int);'],
    ['a string', "INSERT INTO a (t) VALUES ('COMMIT; BEGIN; SET search_path TO public');"],
    ['a doubled quote in a string', "INSERT INTO a (t) VALUES ('it''s; COMMIT');"],
    ['an E-string with escapes', "INSERT INTO a (t) VALUES (E'it\\'s; COMMIT\\n');"],
    ['a quoted identifier', 'CREATE TABLE "COMMIT" ("BEGIN" int, "concurrently" int);'],
    ['a quoted identifier with a doubled quote', 'CREATE TABLE "a""; COMMIT" (id int);'],
    ['creating the public schema', 'CREATE SCHEMA IF NOT EXISTS "public";'],
    ['granting to PUBLIC', 'GRANT SELECT ON "a" TO PUBLIC;'],
    ['SET inside a statement', 'ALTER TABLE "a" ALTER COLUMN "b" SET DEFAULT true;'],
    ['similar words', 'CREATE TABLE "a" ("committed" int, endpoint int, beginning int);'],
    ['ON CONFLICT DO NOTHING', 'INSERT INTO a (id) VALUES (1) ON CONFLICT DO NOTHING;'],
  ])('accepts %s', (_name, sql) => {
    expect(problems(sql)).toEqual([]);
  });
});

describe('transactionSafetyProblems — fails closed on SQL it cannot scan', () => {
  it.each([
    ['an unterminated string', "INSERT INTO a VALUES ('oops);", /unterminated ' quote/],
    ['an unterminated identifier', 'CREATE TABLE "a (id int);', /unterminated " quote/],
    ['an unterminated comment', '/* COMMIT; CREATE TABLE a (id int);', /unterminated \/\* comment/],
    ['an unterminated dollar quote', 'DO $$ BEGIN NULL; END;', /unterminated \$\$ quote/],
    ['an unterminated E-string', "SELECT E'it\\';", /unterminated ' quote/],
  ])('refuses %s', (_name, sql, message) => {
    expect(problems(sql).join('\n')).toMatch(message);
  });

  it('refuses a statement that does not start with a keyword', () => {
    expect(problems('(SELECT 1);').join('\n')).toMatch(/doesn't start with a keyword/);
  });
});

describe('assertSafeInTransaction', () => {
  it('returns the SQL when it is safe', () => {
    expect(assertSafeInTransaction('m', 'CREATE TABLE a (id int);')).toBe(
      'CREATE TABLE a (id int);',
    );
  });

  it('throws naming the migration and every problem', () => {
    expect(() => assertSafeInTransaction('20990101000000_bad', 'BEGIN; VACUUM; COMMIT;')).toThrow(
      /Migration 20990101000000_bad can't safely run[\s\S]*BEGIN[\s\S]*VACUUM[\s\S]*COMMIT/,
    );
  });
});
