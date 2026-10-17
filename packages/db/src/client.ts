import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';
import { assertTenantScoped } from './tenant-guard.ts';

export type CreatePrismaClientOptions = {
  connectionString: string;
  /**
   * Throw on queries against tenant-scoped models that are not filtered by organizationId.
   * Defaults to on outside production.
   */
  tenantGuard?: boolean;
};

export function createPrismaClient({
  connectionString,
  tenantGuard = process.env.NODE_ENV !== 'production',
}: CreatePrismaClientOptions) {
  const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  // Always extend (even when disabled) so callers get a single, stable client type.
  return base.$extends({
    name: 'tenant-guard',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (tenantGuard) assertTenantScoped(model, operation, args);
          return query(args);
        },
      },
    },
  });
}

export type Database = ReturnType<typeof createPrismaClient>;

/** The client handed to an interactive `$transaction` callback. */
export type TransactionClient = Parameters<Parameters<Database['$transaction']>[0]>[0];
