import { prismaErrorCode } from '@pulsedesk/db';

/**
 * Errors a whole transaction may safely be re-run for:
 * - P2034: PostgreSQL aborted it on a serialization failure or deadlock (40001 / 40P01);
 * - P2003: a foreign key was violated because a concurrent transaction deleted the row it
 *   referenced after this one checked it. Re-running re-validates against the new state,
 *   so the caller gets the normal answer (e.g. "no team with this ID") instead of a 500.
 * Lock ordering (docs/architecture/data-model.md, "Concurrency") makes both rare; this is
 * the safety net, not the mechanism.
 */
const RETRYABLE: ReadonlySet<string> = new Set(['P2034', 'P2003']);
const MAX_ATTEMPTS = 3;

/** Runs `transaction`, re-running it from scratch up to twice on a retryable conflict. */
export async function withTransactionRetry<T>(transaction: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction();
    } catch (error) {
      const code = prismaErrorCode(error);
      if (attempt >= MAX_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error;
    }
  }
}
