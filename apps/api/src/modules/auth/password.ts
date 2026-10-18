import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with OWASP's minimum recommended parameters (m=19 MiB, t=2, p=1). The library's
 * default algorithm is Argon2id; its `Algorithm` const enum can't be imported under
 * `isolatedModules`, so the tests assert the `$argon2id$` prefix instead.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** PHC-string prefix of a hash made with the current parameters. */
const CURRENT_PREFIX = `$argon2id$v=19$m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}$`;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Never throws for malformed hashes; they simply don't verify. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** True when a stored hash predates the current algorithm or parameters. */
export function needsRehash(passwordHash: string): boolean {
  return !passwordHash.startsWith(CURRENT_PREFIX);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same Argon2 work as a real verification. Login calls it when no account matches
 * the email, so response time doesn't reveal whether an account exists.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('pulsedesk-timing-equalizer');
  await verifyPassword(await dummyHash, password);
}
