import { Prisma } from './generated/prisma/client.ts';

/**
 * Prisma error codes that mean "the database can't be used right now" rather than "this
 * query is wrong": bad credentials (P1000), unreachable server (P1001), timeouts (P1002,
 * P1008), missing database (P1003), dropped connection (P1017), pool exhausted (P2024).
 * https://www.prisma.io/docs/orm/reference/error-reference
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1003',
  'P1008',
  'P1017',
  'P2024',
]);

/** The Prisma error code (e.g. `P2002`, `P1000`) of a Prisma error, if it has one. */
export function prismaErrorCode(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  if (error instanceof Prisma.PrismaClientInitializationError) return error.errorCode;
  return undefined;
}

/**
 * The error code when `error` means the database is unreachable or refused the connection,
 * otherwise undefined. Callers answer 503 and log the code; the message is never shown to users.
 */
export function databaseUnavailableCode(error: unknown): string | undefined {
  const code = prismaErrorCode(error);
  return code !== undefined && UNAVAILABLE_CODES.has(code) ? code : undefined;
}
