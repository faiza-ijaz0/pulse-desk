/**
 * Checks that migration SQL can run inside a test's outer transaction without escaping its
 * rollback (packages/db/test/migration-upgrade.int.test.ts runs migrations in a transaction it
 * always rolls back). DB-free, so it is unit-tested on its own.
 *
 * It is a conservative scanner, not a SQL parser. A small lexer skips comments and reads
 * quoted strings, quoted identifiers and dollar-quoted bodies as whole tokens, so keywords
 * inside them never count; statements are split at top-level semicolons. It then refuses:
 * - transaction control: BEGIN, START, COMMIT, END, ROLLBACK, ABORT, SAVEPOINT, RELEASE,
 *   PREPARE (TRANSACTION), and CALL (procedures may commit);
 * - statements PostgreSQL won't run, or that misbehave, in a transaction block: anything
 *   CONCURRENTLY, VACUUM, CLUSTER, REINDEX, DISCARD, CREATE/DROP/ALTER DATABASE, TABLESPACE,
 *   SYSTEM or SUBSCRIPTION, and ALTER TYPE … ADD VALUE (unusable until commit);
 * - anything that could act outside the throwaway schema or the transaction: SET / RESET and
 *   set_config (e.g. search_path), names qualified with the public schema, dblink, and
 *   EXECUTE (dynamic SQL can't be checked);
 * - in dollar-quoted bodies (DO blocks, functions), which are scanned the same way:
 *   COMMIT, ROLLBACK, SAVEPOINT, RELEASE, EXECUTE, set_config and dblink.
 *
 * It fails closed: SQL it can't scan (an unterminated quote, comment or dollar quote, a
 * statement that doesn't start with a keyword, a dollar-quoted body that isn't SQL) is
 * reported as a problem, never skipped. Limitations: it assumes standard_conforming_strings
 * (on by default), so backslashes only escape inside E'…' strings; it can't see what a called
 * function does; and it may refuse harmless SQL (e.g. a dollar-quoted string literal that
 * isn't code). A refusal means "check by hand", not "proven unsafe".
 */

type Token =
  | { kind: 'word'; value: string } // bare keyword or identifier, upper-cased
  | { kind: 'quoted'; value: string } // "identifier", as written
  | { kind: 'string' } // '…', E'…' — contents never inspected
  | { kind: 'dollar'; body: string } // $tag$…$tag$
  | { kind: 'punct'; value: string };

class UnscannableSqlError extends Error {}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function lex(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const at = (offset = 0) => sql.charAt(i + offset);

  while (i < sql.length) {
    const c = at();
    const tag = c === '$' ? DOLLAR_TAG.exec(sql.slice(i))?.[0] : undefined;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && at(1) === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === '/' && at(1) === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      do {
        if (i >= sql.length) throw new UnscannableSqlError('an unterminated /* comment */');
        if (at() === '/' && at(1) === '*') {
          depth++;
          i += 2;
        } else if (at() === '*' && at(1) === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      } while (depth > 0);
    } else if (c === "'") {
      i = skipQuoted(sql, i, "'", false);
      tokens.push({ kind: 'string' });
    } else if (c === '"') {
      const end = skipQuoted(sql, i, '"', false);
      tokens.push({ kind: 'quoted', value: sql.slice(i + 1, end - 1).replaceAll('""', '"') });
      i = end;
    } else if (tag !== undefined) {
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) throw new UnscannableSqlError(`an unterminated ${tag} quote`);
      tokens.push({ kind: 'dollar', body: sql.slice(i + tag.length, close) });
      i = close + tag.length;
    } else if (WORD_START.test(c)) {
      const start = i;
      while (i < sql.length && WORD_PART.test(at())) i++;
      const word = sql.slice(start, i);
      if ((word === 'E' || word === 'e') && at() === "'") {
        // E'…' strings use backslash escapes.
        i = skipQuoted(sql, i, "'", true);
        tokens.push({ kind: 'string' });
      } else {
        tokens.push({ kind: 'word', value: word.toUpperCase() });
      }
    } else {
      tokens.push({ kind: 'punct', value: c });
      i++;
    }
  }
  return tokens;
}

/** Returns the index just past the closing quote that matches the one at `start`. */
function skipQuoted(sql: string, start: number, quote: string, backslashes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (backslashes && c === '\\') {
      i += 2;
    } else if (c === quote) {
      if (sql.charAt(i + 1) === quote)
        i += 2; // doubled quote: an escaped one
      else return i + 1;
    } else {
      i++;
    }
  }
  throw new UnscannableSqlError(`an unterminated ${quote} quote`);
}

const TRANSACTION_CONTROL = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
  'PREPARE',
  'CALL',
]);
const NOT_IN_TRANSACTION = new Set(['VACUUM', 'CLUSTER', 'REINDEX', 'DISCARD']);
const SESSION = new Set(['SET', 'RESET']);
const CLUSTER_OBJECTS = new Set(['DATABASE', 'TABLESPACE', 'SYSTEM', 'SUBSCRIPTION']);
const BODY_FORBIDDEN = new Set(['COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'EXECUTE']);

const isWord = (token: Token | undefined, value: string) =>
  token?.kind === 'word' && token.value === value;

/** Problems anywhere in a token list: words and qualified names that matter in any position. */
function anywhereProblems(tokens: Token[], where: string): string[] {
  const problems: string[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === 'word') {
      if (token.value.startsWith('DBLINK')) problems.push(`${where} uses dblink`);
      if (token.value === 'SET_CONFIG') problems.push(`${where} calls set_config`);
    }
    const publicSchema =
      (token.kind === 'word' && token.value === 'PUBLIC') ||
      (token.kind === 'quoted' && token.value === 'public');
    const next = tokens[index + 1];
    if (publicSchema && next?.kind === 'punct' && next.value === '.') {
      problems.push(`${where} names an object in the public schema`);
    }
  });
  return problems;
}

/** Problems in a dollar-quoted body (a DO block or function), scanned like any SQL. */
function bodyProblems(body: string, where: string): string[] {
  let tokens: Token[];
  try {
    tokens = lex(body);
  } catch (error) {
    const reason = error instanceof UnscannableSqlError ? error.message : String(error);
    return [`${where} has a dollar-quoted body that can't be scanned (${reason})`];
  }
  const problems = anywhereProblems(tokens, where);
  for (const token of tokens) {
    if (token.kind === 'word' && BODY_FORBIDDEN.has(token.value)) {
      problems.push(`${where} has ${token.value} in a dollar-quoted body`);
    }
    if (token.kind === 'dollar') problems.push(...bodyProblems(token.body, where));
  }
  return problems;
}

function statementProblems(tokens: Token[], where: string): string[] {
  const [first, second] = tokens;
  if (first?.kind !== 'word') return [`${where} doesn't start with a keyword`];
  const problems: string[] = [];
  const keyword = first.value;

  if (TRANSACTION_CONTROL.has(keyword))
    problems.push(`${where} is transaction control (${keyword})`);
  if (NOT_IN_TRANSACTION.has(keyword)) {
    problems.push(`${where} can't run inside a transaction block (${keyword})`);
  }
  if (SESSION.has(keyword)) problems.push(`${where} changes session settings (${keyword})`);
  if (keyword === 'EXECUTE') problems.push(`${where} runs a prepared statement (EXECUTE)`);
  if (
    ['CREATE', 'DROP', 'ALTER'].includes(keyword) &&
    second?.kind === 'word' &&
    CLUSTER_OBJECTS.has(second.value)
  ) {
    problems.push(`${where} changes a cluster-wide object (${keyword} ${second.value})`);
  }
  if (keyword === 'ALTER' && isWord(second, 'TYPE')) {
    const addValue = tokens.some((t, i) => isWord(t, 'ADD') && isWord(tokens[i + 1], 'VALUE'));
    if (addValue) problems.push(`${where} adds an enum value (ALTER TYPE … ADD VALUE)`);
  }
  if (tokens.some((t) => isWord(t, 'CONCURRENTLY'))) {
    problems.push(`${where} uses CONCURRENTLY`);
  }
  problems.push(...anywhereProblems(tokens, where));
  for (const token of tokens) {
    if (token.kind === 'dollar') problems.push(...bodyProblems(token.body, where));
  }
  return problems;
}

/** Every reason `sql` might not be confined by an outer transaction; empty when none found. */
export function transactionSafetyProblems(sql: string): string[] {
  let tokens: Token[];
  try {
    tokens = lex(sql);
  } catch (error) {
    if (!(error instanceof UnscannableSqlError)) throw error;
    return [`The SQL can't be scanned reliably: ${error.message}`];
  }
  const problems: string[] = [];
  let statement: Token[] = [];
  let number = 0;
  const flush = () => {
    if (statement.length > 0) {
      number++;
      problems.push(...statementProblems(statement, `Statement ${number}`));
    }
    statement = [];
  };
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ';') flush();
    else statement.push(token);
  }
  flush();
  return problems;
}

/** Throws, naming every problem, unless `sql` is safe to run inside an outer transaction. */
export function assertSafeInTransaction(name: string, sql: string): string {
  const problems = transactionSafetyProblems(sql);
  if (problems.length > 0) {
    throw new Error(
      `Migration ${name} can't safely run inside the test's transaction:\n- ${problems.join('\n- ')}`,
    );
  }
  return sql;
}
