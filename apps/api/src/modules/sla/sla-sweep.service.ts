import { databaseUnavailableCode, prismaErrorCode } from '@pulsedesk/db';
import { evaluateSla, type SlaTicketState } from '@pulsedesk/shared';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../lib/logger.ts';
import type {
  BreachEventType,
  SlaSweepRepository,
  SlaSweepTarget,
  SweepCandidate,
  SweepCursor,
} from './sla-sweep.repository.ts';

const TARGETS: readonly SlaSweepTarget[] = ['firstResponse', 'resolution'];

const EVENT_TYPES: Record<SlaSweepTarget, BreachEventType> = {
  firstResponse: 'SLA_FIRST_RESPONSE_BREACHED',
  resolution: 'SLA_RESOLUTION_BREACHED',
};

/** Batches per target in one sweep: with the batch size, the most one run will read. */
export const DEFAULT_MAX_BATCHES_PER_TARGET = 10;

export type Breach = { target: SlaSweepTarget; type: BreachEventType; dueAt: Date };

/**
 * The targets of `ticket` that are breached at `now` but not recorded yet. Pure: the sweep
 * calls it on the ticket as re-read under its row lock, so a reply, solve or priority change
 * that landed after the candidate search is respected.
 */
export function breachesToRecord(ticket: SlaTicketState, now: Date): Breach[] {
  const evaluation = evaluateSla(ticket, now);
  const breaches: Breach[] = [];
  if (
    evaluation.firstResponse === 'breached' &&
    ticket.firstResponseBreachedAt === null &&
    ticket.firstResponseDueAt !== null
  ) {
    breaches.push({
      target: 'firstResponse',
      type: EVENT_TYPES.firstResponse,
      dueAt: ticket.firstResponseDueAt,
    });
  }
  if (
    evaluation.resolution === 'breached' &&
    ticket.resolutionBreachedAt === null &&
    ticket.resolutionDueAt !== null
  ) {
    breaches.push({
      target: 'resolution',
      type: EVENT_TYPES.resolution,
      dueAt: ticket.resolutionDueAt,
    });
  }
  return breaches;
}

export type SlaSweepResult = {
  /** Candidate tickets examined. */
  checked: number;
  /** Breaches recorded by this run, per target. */
  recorded: Record<SlaSweepTarget, number>;
  /** Candidates locked by another transaction or deleted meanwhile; the next run retries. */
  skipped: number;
  /** Candidates that failed with an error (logged); the next run retries. */
  failed: number;
  /** The batch limit was reached with more candidates possibly left for the next run. */
  truncated: boolean;
  /** Stopped early because the process is shutting down. */
  stopped: boolean;
  durationMs: number;
};

export type SweepOptions = {
  /** Checked between tickets: a shutdown ends the run after the current ticket. */
  shouldStop?: () => boolean;
};

/**
 * Records SLA breaches: for each overdue target without a marker, exactly one SYSTEM
 * `SLA_*_BREACHED` event (data `{ dueAt }`) and the marker, in one transaction per ticket.
 *
 * Exactly-once comes from the ticket's row lock plus the marker's `IS NULL` condition; the
 * partial unique index TicketEvent_one_sla_breach_per_ticket_key is the last line of
 * defence. A run is idempotent and restart-safe: whatever it didn't finish, the next run
 * finds again through the same index.
 */
export function createSlaSweepService({
  repository,
  clock,
  logger,
  batchSize,
  maxBatchesPerTarget = DEFAULT_MAX_BATCHES_PER_TARGET,
}: {
  repository: SlaSweepRepository;
  clock: Clock;
  logger: Logger;
  batchSize: number;
  maxBatchesPerTarget?: number;
}) {
  async function recordBreaches(
    candidate: SweepCandidate,
    now: Date,
  ): Promise<SlaSweepTarget[] | null> {
    return repository.withLockedTicket(candidate, async (scope) => {
      const recorded: SlaSweepTarget[] = [];
      for (const breach of breachesToRecord(scope.ticket, now)) {
        // An event without its marker (a manual repair, say) only gets the marker: never a
        // second event, which the unique index would refuse anyway.
        if (!(await scope.hasBreachEvent(breach.type))) {
          await scope.addBreachEvent(breach.type, breach.dueAt, now);
        }
        if (await scope.markBreached(breach.target, now)) recorded.push(breach.target);
      }
      return recorded;
    });
  }

  return {
    async sweep({ shouldStop = () => false }: SweepOptions = {}): Promise<SlaSweepResult> {
      const startedAt = performance.now();
      // One "now" per run: every ticket in it is judged against the same moment.
      const now = clock.now();
      const result: SlaSweepResult = {
        checked: 0,
        recorded: { firstResponse: 0, resolution: 0 },
        skipped: 0,
        failed: 0,
        truncated: false,
        stopped: false,
        durationMs: 0,
      };

      sweeping: for (const target of TARGETS) {
        let after: SweepCursor | null = null;
        for (let batch = 0; ; batch++) {
          if (batch === maxBatchesPerTarget) {
            result.truncated = true;
            break;
          }
          const candidates = await repository.findCandidates(target, now, after, batchSize);
          for (const candidate of candidates) {
            if (shouldStop()) {
              result.stopped = true;
              break sweeping;
            }
            result.checked++;
            try {
              const recorded = await recordBreaches(candidate, now);
              if (recorded === null) result.skipped++;
              else for (const t of recorded) result.recorded[t]++;
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
                  target,
                },
                'SLA sweep could not process a ticket',
              );
            }
          }
          const last = candidates.at(-1);
          if (candidates.length < batchSize || !last) break;
          after = last;
        }
      }

      result.durationMs = Math.round(performance.now() - startedAt);
      return result;
    },
  };
}

export type SlaSweepService = ReturnType<typeof createSlaSweepService>;
