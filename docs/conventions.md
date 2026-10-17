# Coding Conventions

These conventions apply to all workspaces. Lint rules enforce them where possible.
Where a rule can't be enforced, reviewers do.

## TypeScript

- `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `noImplicitOverride`. One shared `tsconfig.base.json` at the root; workspaces extend it.
- ES modules everywhere (`"type": "module"`). Node 24 LTS.
- No `any`. Use `unknown` and narrow it. `as` casts need a comment explaining why they're safe.
- Prefer `type` aliases. Use `interface` only when declaration merging is needed.
- Domain values that cross the HTTP boundary are defined **once**, as Zod schemas in
  `@pulsedesk/shared`, and their types are inferred (`z.infer`). Hand-written duplicates aren't allowed.
- Errors are thrown as `AppError` subclasses with an `ErrorCode`. Never throw strings.
- No default exports, except where a framework requires them (e.g. config files).

## Naming

| Thing                 | Style                                                           | Example                                 |
| --------------------- | --------------------------------------------------------------- | --------------------------------------- |
| Files                 | `kebab-case`, with role suffix in API modules                   | `tickets.service.ts`, `ticket-list.tsx` |
| React components      | `PascalCase`                                                    | `TicketList`                            |
| Hooks                 | `useCamelCase`                                                  | `useTicketQuery`                        |
| Variables / functions | `camelCase`                                                     | `assignTicket`                          |
| Constants             | `SCREAMING_SNAKE_CASE` only for true module-level constants     | `MAX_PAGE_SIZE`                         |
| Env vars              | `SCREAMING_SNAKE_CASE`; browser-exposed ones start with `VITE_` | `SESSION_SECRET`                        |
| Error codes           | `SCREAMING_SNAKE_CASE`                                          | `TICKET_NOT_FOUND`                      |
| Permissions           | `resource:action`                                               | `ticket:assign`                         |
| Socket events         | `resource.event`                                                | `ticket.updated`                        |
| Queues / jobs         | `kebab-case`                                                    | `sla`, `sla-check`                      |
| Workspace packages    | `@pulsedesk/<name>`                                             | `@pulsedesk/shared`                     |

## API design

- REST-ish JSON under `/api/v1`. Plural nouns: `/api/v1/tickets/:ticketId/messages`.
- Lists use cursor pagination: `?limit=25&cursor=<opaque>` → `{ data, nextCursor }`. `limit` is at most 100.
- Errors use RFC 9457 `application/problem+json`:
  `{ type, title, status, code, detail?, errors?, requestId }`.
- Timestamps are ISO-8601 UTC strings. IDs are UUIDs, except human ticket `number`.
- Mutations return the updated resource.
- `organizationId` never appears in URLs. It comes from the session.

## Backend layering rules

- `routes` → `controller` → `service` → `repository`. Never skip or reverse layers.
- Controllers: parse validated input, call one service function, shape the response.
- Services: business rules, transactions, policy checks, enqueueing jobs, and emitting
  real-time events **after commit**. No Express types.
- Repositories: the only place that imports the Prisma client. Every tenant-scoped
  query includes `organizationId`.
- Side effects (time, randomness, queues, emitters) are injected, so they can be replaced in tests.

## Frontend rules

- Feature folders: `src/features/tickets/{components,hooks,api,routes}`. Shared primitives
  go in `src/components/ui` (shadcn) and `src/components/common`.
- Server data goes through TanStack Query hooks. Don't store server data in global state.
- Use semantic HTML before ARIA. Every interactive element is reachable and operable by keyboard.
- Colors come only from theme tokens (CSS variables). Don't hard-code hex values in components.
- Animations use Framer Motion, are short (≤ 250 ms for UI feedback), and are disabled
  under `prefers-reduced-motion`.

## Formatting and linting

- **Prettier** for formatting (2 spaces, single quotes, trailing commas, 100-column width).
- **ESLint** flat config with `typescript-eslint` (type-aware rules), `eslint-plugin-react-hooks`,
  `eslint-plugin-jsx-a11y`, and an import-boundary rule. The boundary rule forbids
  `apps/web` from importing `@pulsedesk/db` and any workspace from importing another app.
- CI fails on lint errors, type errors, test failures and formatting drift.

## Git workflow

- Trunk-based: short-lived branches off `main`, merged via pull request.
- Conventional Commits: `feat(tickets): add bulk assign`, `fix(auth): …`, `docs: …`, `chore: …`.
- A PR keeps lint, typecheck and tests green, and includes tests for new behavior.
  Any schema change has a reviewed migration.
- Never commit `.env`, secrets, or generated build output.

## Dependencies

- Add a dependency only when it removes meaningful code or risk. Prefer the platform
  (`crypto.randomUUID`, `fetch`, `structuredClone`).
- No paid APIs or proprietary hosted services. No Supabase or Firebase.
- Pin exact versions in `package.json` for apps. The lockfile is committed.
