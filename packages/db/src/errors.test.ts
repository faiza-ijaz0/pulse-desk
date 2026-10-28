import { describe, expect, it } from 'vitest';
import { databaseUnavailableCode, prismaErrorCode } from './errors.ts';
import { Prisma } from './generated/prisma/client.ts';

function known(code: string) {
  return new Prisma.PrismaClientKnownRequestError('test', { code, clientVersion: 'test' });
}

describe('database error classification', () => {
  it('flags connection and credential failures as unavailable', () => {
    for (const code of ['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1017', 'P2024']) {
      expect(databaseUnavailableCode(known(code))).toBe(code);
    }
    const init = new Prisma.PrismaClientInitializationError('test', 'test', 'P1001');
    expect(databaseUnavailableCode(init)).toBe('P1001');
  });

  it('flags raw socket failures that Prisma passes through as unavailable', () => {
    // Regression: with host `localhost`, a stopped server surfaced as ECONNREFUSED (not
    // P1001) and the API answered 500 instead of 503.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT']) {
      expect(databaseUnavailableCode(known(code))).toBe(code);
    }
  });

  it('ignores socket errors that did not come from Prisma', () => {
    const socketError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(databaseUnavailableCode(socketError)).toBeUndefined();
  });

  it('does not treat query errors or unknown errors as an outage', () => {
    expect(databaseUnavailableCode(known('P2002'))).toBeUndefined();
    expect(databaseUnavailableCode(new Error('boom'))).toBeUndefined();
    expect(prismaErrorCode(known('P2002'))).toBe('P2002');
    expect(prismaErrorCode(new Error('boom'))).toBeUndefined();
  });
});
