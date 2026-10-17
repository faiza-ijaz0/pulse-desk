/**
 * Runtime guard against unscoped queries on tenant-owned models (isolation layer 2 in
 * docs/architecture/data-model.md). It catches regressions in development and tests;
 * it does not replace correct repository code.
 */

export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Membership',
  'Invitation',
  'Team',
  'TeamMember',
  'Customer',
  'SlaPolicy',
  'SlaTarget',
  'Ticket',
  'Message',
  'Tag',
  'TicketTag',
  'TicketEvent',
  'AuditLog',
]);

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

export class TenantScopeViolationError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    reason: string,
  ) {
    super(`Tenant scope violation: ${model}.${operation} ${reason}`);
    this.name = 'TenantScopeViolationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * A `where` is tenant-scoped when it pins `organizationId` directly, through a compound
 * unique key that contains it (e.g. `organizationId_id`), or inside a top-level `AND`.
 */
function whereHasOrganization(where: unknown): boolean {
  if (!isRecord(where)) return false;
  if (isPresent(where.organizationId)) return true;

  for (const [key, value] of Object.entries(where)) {
    if (
      key.split('_').includes('organizationId') &&
      isRecord(value) &&
      isPresent(value.organizationId)
    ) {
      return true;
    }
  }

  const and = where.AND;
  if (Array.isArray(and)) return and.some(whereHasOrganization);
  return whereHasOrganization(and);
}

function dataHasOrganization(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0 && data.every(dataHasOrganization);
  return isRecord(data) && typeof data.organizationId === 'string';
}

export function assertTenantScoped(
  model: string | undefined,
  operation: string,
  args: unknown,
): void {
  if (model === undefined || !TENANT_SCOPED_MODELS.has(model)) return;
  const input = isRecord(args) ? args : {};

  if (WHERE_OPERATIONS.has(operation) && !whereHasOrganization(input.where)) {
    throw new TenantScopeViolationError(model, operation, 'is missing organizationId in `where`');
  }
  if (CREATE_OPERATIONS.has(operation) && !dataHasOrganization(input.data)) {
    throw new TenantScopeViolationError(model, operation, 'is missing organizationId in `data`');
  }
  if (operation === 'upsert' && !dataHasOrganization(input.create)) {
    throw new TenantScopeViolationError(model, operation, 'is missing organizationId in `create`');
  }
}
