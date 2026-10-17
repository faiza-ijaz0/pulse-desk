import { defineConfig } from 'prisma/config';
import { loadWorkspaceEnv } from './src/env.ts';

loadWorkspaceEnv();

// `prisma generate` does not need a database, so DATABASE_URL is optional here.
// Commands that do (migrate, studio) fail with Prisma's own clear error when it is missing.
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed/run.ts',
  },
  ...(url ? { datasource: { url } } : {}),
});
