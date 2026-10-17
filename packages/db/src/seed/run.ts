/* eslint-disable no-console -- CLI entrypoint; output is for the developer running it. */
import { hash } from '@node-rs/argon2';
import { createPrismaClient } from '../client.ts';
import { loadWorkspaceEnv } from '../env.ts';
import { seedDatabase } from './seed.ts';

/**
 * Development-only password shared by every seeded user. It is documented in
 * docs/development.md and is not a real credential.
 */
export const SEED_PASSWORD = 'pulsedesk-dev-password';

async function main(): Promise<void> {
  loadWorkspaceEnv();

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed: NODE_ENV is "production". The seed is for development only.',
    );
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
  }

  // Argon2id with OWASP-recommended minimums (m=19 MiB, t=2, p=1); the library default algorithm is Argon2id.
  const passwordHash = await hash(SEED_PASSWORD, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const db = createPrismaClient({ connectionString });
  try {
    const summary = await seedDatabase(db, { passwordHash });
    console.log(
      `Seeded ${summary.organizations} organizations, ${summary.users} users, ` +
        `${summary.memberships} memberships and ${summary.tickets} tickets.`,
    );
    console.log(`All seeded users sign in with the development password "${SEED_PASSWORD}".`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
