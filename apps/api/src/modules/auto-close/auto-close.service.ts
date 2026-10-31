import { databaseUnavailableCode, prismaErrorCode } from '@pulsedesk/db';
import { transitionTicketStatus } from '@pulsedesk/shared';
import type { Clock } from '../../lib/clock.ts';
import type { PeriodicRunOptions } from '../../lib/periodic-job.ts';
import type { Logger } from '../../lib/logger.ts';
import type {
  AutoCloseCandidate,
  AutoCloseCursor,
  AutoCloseRepository,
  LockedClosable,
} from './auto-close.repository.ts';

const MINUTE = 60_000;

/** Batches per sweep: with the batch size, the most one run will read. */
export const DEFAULT_MAX_BATCHES = 10;

export type AutoCloseDecision = 'close' | 'disabled' | 'not_solved' | 'not_due';

/**
 * When a solved ticket becomes due to close: the organization's delay after the later of its
 * solve and its last update, so any recent work on a solved ticket (a reply, a note, a
 * property change) keeps it open for another full delay. Null if it isn't solved.
 */
export function autoCloseDueAt(
  ticket: Pick<LockedClosable['ticket'], 'solvedAt' | 'updatedAt'>,
  autoCloseAfterMinutes: number,
): Date | null {
  if (ticket.solvedAt === null) return null;
  const lastActivity = Math.max(ticket.solvedAt.getTime(), ticket.updatedAt.getTime());
  return new Date(lastActivity + autoCloseAfterMinutes * MINUTE);
}

/**
 * Whether to close `ticket` at `now`. Pure: the sweep calls it on the ticket and settings as
 * re-read under the ticket's row lock, so a reopen, a reply or a settings change that landed
 * after the candidate search always wins. Due exactly at the deadline (inclusive).
 */
export function autoCloseDecision(
  { ticket, settings }: LockedClosable,
  now: Date,
): AutoCloseDecision {
  if (!settings.autoCloseEnabled) return 'disabled';
  if (ticket.status !== 'SOLVED') return 'not_solved';
  const dueAt = autoCloseDueAt(ticket, settings.autoCloseAfterMinutes);
  if (dueAt === null) return 'not_solved';
  return now.getTime() >= dueAt.getTime() ? 'close' : 'not_due';
}

export type AutoCloseResult = {
  /** Candidate tickets examined. */
  checked: number;
  /** Tickets this run closed. */
  closed: number;
  /** Candidates locked by another transaction or deleted meanwhile; the next run retries. */
  skipped: number;
  /** Candidates no longer due on re-check (reopened, updated, settings changed). */
  unchanged: number;
  /** Candidates that failed with an error (logged); the next run retries. */
  failed: number;
  /** The batch limit was reached with more candidates possibly left for the next run. */
  truncated: boolean;
  /** Stopped early because the process is shutting down. */
  stopped: boolean;
  durationMs: number;
};

/**
 * Closes solved tickets whose organization has auto-close on, once the organization's delay
 * has passed since both their solve and their last update. Each closure is one transaction:
 * the SOLVED → CLOSED transition (system actor, per the ticket lifecycle) and its SYSTEM
 * `STATUS_CHANGED` event commit together or not at all.
 *
 * Runs are idempotent and restart-safe: a ticket closes only while it is SOLVED, under its
 * row lock, so repeated, retried or concurrent runs can't close it twice or record a second
 * event; whatever a run leaves, the next one finds again.
 */
export function createAutoCloseService({
  repository,
  clock,
  logger,
  batchSize,
  maxBatches = DEFAULT_MAX_BATCHES,
}: {
  repository: AutoCloseRepository;
  clock: Clock;
  logger: Logger;
  batchSize: number;
  maxBatches?: number;
}) {
  async function closeIfDue(candidate: AutoCloseCandidate, now: Date): Promise<boolean | null> {
    return repository.withLockedTicket(candidate, async (scope) => {
      if (autoCloseDecision(scope, now) !== 'close') return false;
      // The lifecycle has the final say (only the system may close, only from SOLVED).
      const transition = transitionTicketStatus(scope.ticket, 'CLOSED', 'system', now);
      if (!transition.ok || !transition.changed) return false;
      return scope.close(now);
    });
  }

  return {
    async sweep({ shouldStop }: Partial<PeriodicRunOptions> = {}): Promise<AutoCloseResult> {
      const stop = shouldStop ?? (() => false);
      const startedAt = performance.now();
      // One "now" per run: every ticket in it is judged against the same moment.
      const now = clock.now();
      const result: AutoCloseResult = {
        checked: 0,
        closed: 0,
        skipped: 0,
        unchanged: 0,
        failed: 0,
        truncated: false,
        stopped: false,
        durationMs: 0,
      };

      let after: AutoCloseCursor | null = null;
      batches: for (let batch = 0; ; batch++) {
        if (batch === maxBatches) {
          result.truncated = true;
          break;
        }
        const candidates = await repository.findCandidates(now, after, batchSize);
        for (const candidate of candidates) {
          if (stop()) {
            result.stopped = true;
            break batches;
          }
          result.checked++;
          try {
            const closed = await closeIfDue(candidate, now);
            if (closed === null) result.skipped++;
            else if (closed) result.closed++;
            else result.unchanged++;
          } catch (error) {
            // An outage fails every ticket alike: end the run and let the scheduler report it.
            if (databaseUnavailableCode(error) !== undefined) throw error;
            result.failed++;
            logger.warn(
              {
                err: error,
                errorCode: prismaErrorCode(error) ?? 'UNHANDLED',
                organizationId: candidate.organizationId,
                ticketId: candidate.id,
              },
              'Auto-close could not process a ticket',
            );
          }
        }
        const last = candidates.at(-1);
        if (candidates.length < batchSize || !last) break;
        after = last;
      }

      result.durationMs = Math.round(performance.now() - startedAt);
      return result;
    },
  };
}

export type AutoCloseService = ReturnType<typeof createAutoCloseService>;
