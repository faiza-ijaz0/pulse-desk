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

  it('does not treat query errors or unknown errors as an outage', () => {
    expect(databaseUnavailableCode(known('P2002'))).toBeUndefined();
    expect(databaseUnavailableCode(new Error('boom'))).toBeUndefined();
    expect(prismaErrorCode(known('P2002'))).toBe('P2002');
    expect(prismaErrorCode(new Error('boom'))).toBeUndefined();
  });
});
