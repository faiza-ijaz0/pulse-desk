/**
 * Makes user text literal inside a Prisma `contains` filter. Prisma sends the value as a
 * bound parameter (no SQL injection), but it does not escape LIKE wildcards, so `%` or `_`
 * would match everything. PostgreSQL's default LIKE escape character is a backslash.
 */
export function literalContains(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
