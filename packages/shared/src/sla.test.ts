import { describe, expect, it } from 'vitest';
import {
  SLA_AT_RISK_REMAINING_FRACTION,
  evaluateSla,
  type SlaTargetState,
  type SlaTicketState,
} from './sla.ts';
import { transitionTicketStatus } from './ticket-lifecycle.ts';
import { TICKET_STATUSES } from './tickets.ts';

const MINUTE = 60_000;
const CREATED = new Date('2026-10-26T08:00:00.000Z');
// An urgent ticket under the seeded default policy: reply in 30 minutes, resolve in 4 hours.
const FIRST_DUE = new Date(CREATED.getTime() + 30 * MINUTE);
const RESOLUTION_DUE = new Date(CREATED.getTime() + 240 * MINUTE);

const at = (minutes: number) => new Date(CREATED.getTime() + minutes * MINUTE);
const ms = (date: Date, offset: number) => new Date(date.getTime() + offset);

function ticket(overrides: Partial<SlaTicketState> = {}): SlaTicketState {
  return {
    status: 'OPEN',
    createdAt: CREATED,
    firstResponseDueAt: FIRST_DUE,
    resolutionDueAt: RESOLUTION_DUE,
    firstRespondedAt: null,
    solvedAt: null,
    closedAt: null,
    firstResponseBreachedAt: null,
    resolutionBreachedAt: null,
    ...overrides,
  };
}

describe('evaluateSla — no applicable policy', () => {
  it.each(TICKET_STATUSES)('a %s ticket without due dates has no SLA', (status) => {
    const solved = status === 'SOLVED' || status === 'CLOSED';
    const result = evaluateSla(
      ticket({
        status,
        firstResponseDueAt: null,
        resolutionDueAt: null,
        firstRespondedAt: at(5),
        solvedAt: solved ? at(10) : null,
        closedAt: status === 'CLOSED' ? at(20) : null,
      }),
      at(100_000),
    );
    expect(result).toEqual({ status: 'none', firstResponse: 'none', resolution: 'none' });
  });

  it('evaluates whichever target has a due date', () => {
    const result = evaluateSla(ticket({ firstResponseDueAt: null }), at(1));
    expect(result).toEqual({ status: 'on_track', firstResponse: 'none', resolution: 'on_track' });
  });
});

describe('evaluateSla — first response boundaries', () => {
  it('is on track while most of the window is left', () => {
    expect(evaluateSla(ticket(), CREATED).firstResponse).toBe('on_track');
    expect(evaluateSla(ticket(), at(22)).firstResponse).toBe('on_track');
  });

  it('turns at risk when exactly the at-risk share of the window is left', () => {
    // 25 % of 30 minutes = 7.5 minutes before the due date.
    const threshold = ms(FIRST_DUE, -30 * MINUTE * SLA_AT_RISK_REMAINING_FRACTION);
    expect(evaluateSla(ticket(), ms(threshold, -1)).firstResponse).toBe('on_track');
    expect(evaluateSla(ticket(), threshold).firstResponse).toBe('at_risk');
  });

  it('is still unbreached at exactly the due date and breached 1 ms later', () => {
    expect(evaluateSla(ticket(), FIRST_DUE)).toMatchObject({
      status: 'at_risk',
      firstResponse: 'at_risk',
    });
    expect(evaluateSla(ticket(), ms(FIRST_DUE, 1))).toMatchObject({
      status: 'first_response_breached',
      firstResponse: 'breached',
    });
  });

  it('is met by a reply exactly at the due date', () => {
    const result = evaluateSla(ticket({ firstRespondedAt: FIRST_DUE }), at(1000));
    expect(result.firstResponse).toBe('met');
  });

  it('is breached by a reply 1 ms after the due date, and stays breached', () => {
    const late = ticket({ firstRespondedAt: ms(FIRST_DUE, 1) });
    expect(evaluateSla(late, ms(FIRST_DUE, 1)).firstResponse).toBe('breached');
    expect(evaluateSla(late, at(100_000)).firstResponse).toBe('breached');
  });

  it('stays met once replied in time, however much later it is evaluated', () => {
    const replied = ticket({ firstRespondedAt: at(10) });
    expect(evaluateSla(replied, at(29)).firstResponse).toBe('met');
    expect(evaluateSla(replied, at(100_000)).firstResponse).toBe('met');
  });
});

describe('evaluateSla — first response and ticket status', () => {
  it('keeps running when a ticket is solved without a public reply', () => {
    const solved = ticket({ status: 'SOLVED', solvedAt: at(10) });
    expect(evaluateSla(solved, at(15)).firstResponse).toBe('on_track');
    expect(evaluateSla(solved, FIRST_DUE).firstResponse).toBe('at_risk');
    expect(evaluateSla(solved, ms(FIRST_DUE, 1))).toEqual({
      status: 'first_response_breached',
      firstResponse: 'breached',
      resolution: 'met',
    });
  });

  it('is met by a public reply on a solved ticket before the due date', () => {
    const solved = ticket({ status: 'SOLVED', solvedAt: at(10), firstRespondedAt: at(12) });
    expect(evaluateSla(solved, at(1000))).toEqual({
      status: 'met',
      firstResponse: 'met',
      resolution: 'met',
    });
  });

  it.each(['PENDING', 'ON_HOLD'] as const)(
    'keeps running while %s (no pausing in v1)',
    (status) => {
      expect(evaluateSla(ticket({ status }), ms(FIRST_DUE, 1)).firstResponse).toBe('breached');
    },
  );

  it('breaches a closed ticket that never got a public reply once its due date passes', () => {
    const closed = ticket({ status: 'CLOSED', solvedAt: at(10), closedAt: at(20) });
    expect(evaluateSla(closed, ms(FIRST_DUE, 1)).firstResponse).toBe('breached');
  });
});

describe('evaluateSla — resolution boundaries', () => {
  it('runs while the ticket is active', () => {
    for (const status of ['OPEN', 'PENDING', 'ON_HOLD'] as const) {
      const responded = ticket({ status, firstRespondedAt: at(5) });
      expect(evaluateSla(responded, at(100)).resolution, status).toBe('on_track');
      expect(evaluateSla(responded, at(200)).resolution, status).toBe('at_risk');
      expect(evaluateSla(responded, ms(RESOLUTION_DUE, 1)).resolution, status).toBe('breached');
    }
  });

  it('turns at risk when exactly the at-risk share of the window is left', () => {
    const threshold = ms(RESOLUTION_DUE, -240 * MINUTE * SLA_AT_RISK_REMAINING_FRACTION);
    const responded = ticket({ firstRespondedAt: at(5) });
    expect(evaluateSla(responded, ms(threshold, -1)).resolution).toBe('on_track');
    expect(evaluateSla(responded, threshold).resolution).toBe('at_risk');
  });

  it('is still unbreached at exactly the due date and breached 1 ms later', () => {
    const responded = ticket({ firstRespondedAt: at(5) });
    expect(evaluateSla(responded, RESOLUTION_DUE).status).toBe('at_risk');
    expect(evaluateSla(responded, ms(RESOLUTION_DUE, 1))).toEqual({
      status: 'resolution_breached',
      firstResponse: 'met',
      resolution: 'breached',
    });
  });

  it('is met when solved exactly at the due date', () => {
    const solved = ticket({ status: 'SOLVED', firstRespondedAt: at(5), solvedAt: RESOLUTION_DUE });
    expect(evaluateSla(solved, at(100_000)).resolution).toBe('met');
  });

  it('is breached when solved 1 ms after the due date', () => {
    const solved = ticket({
      status: 'SOLVED',
      firstRespondedAt: at(5),
      solvedAt: ms(RESOLUTION_DUE, 1),
    });
    expect(evaluateSla(solved, at(100_000)).resolution).toBe('breached');
  });

  it('keeps the outcome decided at solve time when the ticket is closed', () => {
    const inTime = ticket({
      status: 'CLOSED',
      firstRespondedAt: at(5),
      solvedAt: at(100),
      closedAt: ms(RESOLUTION_DUE, 4 * 24 * 60 * MINUTE),
    });
    expect(evaluateSla(inTime, at(100_000)).resolution).toBe('met');
    const late = { ...inTime, solvedAt: ms(RESOLUTION_DUE, 1) };
    expect(evaluateSla(late, at(100_000)).resolution).toBe('breached');
  });

  it('falls back to closedAt for a closed ticket without solvedAt', () => {
    const closed = ticket({ status: 'CLOSED', firstRespondedAt: at(5), closedAt: at(100) });
    expect(evaluateSla(closed, at(100_000)).resolution).toBe('met');
  });

  it('ignores a leftover solvedAt on an active ticket', () => {
    // The lifecycle clears solvedAt on reopen; an active ticket's clock runs regardless.
    const open = ticket({ firstRespondedAt: at(5), solvedAt: at(100) });
    expect(evaluateSla(open, ms(RESOLUTION_DUE, 1)).resolution).toBe('breached');
  });
});

describe('evaluateSla — reopened tickets', () => {
  // Drive the real lifecycle so the fields are exactly what the API stores.
  function reopen(solvedAt: Date, reopenedAt: Date): SlaTicketState {
    const base = ticket({ firstRespondedAt: at(5) });
    const solved = transitionTicketStatus(base, 'SOLVED', 'agent', solvedAt);
    if (!solved.ok) throw new Error(solved.reason);
    const reopened = transitionTicketStatus(solved.state, 'OPEN', 'customer', reopenedAt);
    if (!reopened.ok) throw new Error(reopened.reason);
    return { ...base, ...reopened.state };
  }

  it('resumes against the original due date when reopened before it', () => {
    const reopened = reopen(at(60), at(90));
    expect(reopened.solvedAt).toBeNull();
    expect(evaluateSla(reopened, at(100)).resolution).toBe('on_track');
    expect(evaluateSla(reopened, RESOLUTION_DUE).resolution).toBe('at_risk');
    expect(evaluateSla(reopened, ms(RESOLUTION_DUE, 1)).resolution).toBe('breached');
  });

  it('is breached at once when reopened after the original due date', () => {
    const reopened = reopen(at(60), at(300));
    expect(evaluateSla(reopened, at(300))).toEqual({
      status: 'resolution_breached',
      firstResponse: 'met',
      resolution: 'breached',
    });
  });

  it('is met again when solved a second time before the due date', () => {
    const reopened = reopen(at(60), at(90));
    const solvedAgain = transitionTicketStatus(reopened, 'SOLVED', 'agent', at(120));
    if (!solvedAgain.ok) throw new Error(solvedAgain.reason);
    const result = evaluateSla({ ...reopened, ...solvedAgain.state }, at(100_000));
    expect(result.resolution).toBe('met');
  });

  it('does not change a first response already met', () => {
    expect(evaluateSla(reopen(at(60), at(300)), at(300)).firstResponse).toBe('met');
  });
});

describe('evaluateSla — due dates as stored', () => {
  it('follows a due date moved later (e.g. by a priority change)', () => {
    // NORMAL priority under the seeded policy: reply in 4 hours instead of 30 minutes.
    const lowered = ticket({ firstResponseDueAt: at(240), resolutionDueAt: at(1440) });
    expect(evaluateSla(lowered, ms(FIRST_DUE, 1))).toMatchObject({
      status: 'on_track',
      firstResponse: 'on_track',
    });
    expect(evaluateSla(lowered, ms(at(240), 1)).firstResponse).toBe('breached');
  });

  it('follows a due date moved earlier, breaching at once if it has passed', () => {
    const raised = ticket({ firstResponseDueAt: at(30), resolutionDueAt: at(240) });
    expect(evaluateSla(raised, at(31)).firstResponse).toBe('breached');
  });

  it('measures the at-risk window from creation for each target separately', () => {
    // Reply window 60 min (at risk from minute 45); resolution window 480 min (from minute 360).
    const high = ticket({ firstResponseDueAt: at(60), resolutionDueAt: at(480) });
    expect(evaluateSla(high, at(44)).firstResponse).toBe('on_track');
    expect(evaluateSla(high, at(45)).firstResponse).toBe('at_risk');
    const responded = { ...high, firstRespondedAt: at(10) };
    expect(evaluateSla(responded, at(359)).resolution).toBe('on_track');
    expect(evaluateSla(responded, at(360)).resolution).toBe('at_risk');
  });

  it('is deterministic: the same input and time give the same result', () => {
    const input = ticket({ firstRespondedAt: at(5) });
    expect(evaluateSla(input, at(200))).toEqual(evaluateSla(input, at(200)));
  });
});

describe('evaluateSla — recorded breaches', () => {
  // The sweep records a breach some time after the due date passes (processing time).
  const RECORDED = ms(FIRST_DUE, 45_000);

  it('stays breached after a later public reply', () => {
    const replied = ticket({ firstResponseBreachedAt: RECORDED, firstRespondedAt: at(40) });
    expect(evaluateSla(replied, at(1000)).firstResponse).toBe('breached');
  });

  it('stays breached when a priority change moves the due date out again', () => {
    const extended = ticket({ firstResponseBreachedAt: RECORDED, firstResponseDueAt: at(240) });
    expect(evaluateSla(extended, at(60))).toMatchObject({
      status: 'first_response_breached',
      firstResponse: 'breached',
    });
  });

  it('stays breached when the ticket is reopened and solved in time for a moved due date', () => {
    const solved = ticket({
      status: 'SOLVED',
      firstRespondedAt: at(5),
      resolutionDueAt: at(1440),
      solvedAt: at(600),
      resolutionBreachedAt: ms(RESOLUTION_DUE, 45_000),
    });
    expect(evaluateSla(solved, at(2000))).toEqual({
      status: 'resolution_breached',
      firstResponse: 'met',
      resolution: 'breached',
    });
  });

  it('marks only the target whose breach was recorded', () => {
    const result = evaluateSla(ticket({ firstResponseBreachedAt: RECORDED }), at(1));
    expect(result).toEqual({
      status: 'first_response_breached',
      firstResponse: 'breached',
      resolution: 'on_track',
    });
  });

  it('wins even over a missing due date', () => {
    // Not reachable through the API today (due dates are never cleared), but a recorded
    // breach must never read as "no SLA".
    const result = evaluateSla(
      ticket({ resolutionDueAt: null, resolutionBreachedAt: RECORDED }),
      at(1),
    );
    expect(result.resolution).toBe('breached');
  });

  it('is consistent with a breach the evaluation already derives', () => {
    const derived = evaluateSla(ticket(), at(31));
    const recorded = evaluateSla(ticket({ firstResponseBreachedAt: at(31) }), at(31));
    expect(recorded).toEqual(derived);
  });
});

describe('evaluateSla — overall status', () => {
  type Case = [SlaTargetState, SlaTargetState, string];
  // Built from real ticket states so each pair is reachable, not just asserted.
  const cases: [string, SlaTicketState, Date, Case][] = [
    ['both running', ticket(), at(1), ['on_track', 'on_track', 'on_track']],
    [
      'reply met, resolution running',
      ticket({ firstRespondedAt: at(5) }),
      at(10),
      ['met', 'on_track', 'on_track'],
    ],
    ['reply at risk, resolution on track', ticket(), at(25), ['at_risk', 'on_track', 'at_risk']],
    [
      'reply met, resolution at risk',
      ticket({ firstRespondedAt: at(5) }),
      at(200),
      ['met', 'at_risk', 'at_risk'],
    ],
    [
      'both met',
      ticket({ status: 'SOLVED', firstRespondedAt: at(5), solvedAt: at(60) }),
      at(1000),
      ['met', 'met', 'met'],
    ],
    [
      'reply breached, resolution on track',
      ticket(),
      at(31),
      ['breached', 'on_track', 'first_response_breached'],
    ],
    [
      'reply breached, resolution met',
      ticket({ status: 'SOLVED', firstRespondedAt: at(31), solvedAt: at(60) }),
      at(1000),
      ['breached', 'met', 'first_response_breached'],
    ],
    [
      'reply met, resolution breached',
      ticket({ firstRespondedAt: at(5) }),
      at(241),
      ['met', 'breached', 'resolution_breached'],
    ],
    ['both breached', ticket(), at(241), ['breached', 'breached', 'resolution_breached']],
  ];

  it.each(cases)('%s', (_name, input, now, [firstResponse, resolution, status]) => {
    expect(evaluateSla(input, now)).toEqual({ status, firstResponse, resolution });
  });
});
