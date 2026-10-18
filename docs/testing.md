# Testing Strategy

Goal: catch regressions where they're cheapest to catch. Most tests are unit tests.
Tenant isolation and auth are covered with real database integration tests, and
critical user journeys are covered end-to-end.

## Test layers

| Layer               | Tool                                     | Location                               | Runs against                                                                            | Covers                                                                                                                                                           |
| ------------------- | ---------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**            | Vitest                                   | `*.test.ts` beside source              | Pure functions, mocked or injected deps                                                 | Services (business rules, SLA due-date math, state transitions), policies, Zod schemas, utilities                                                                |
| **Component**       | Vitest + React Testing Library + `jsdom` | `apps/web/src/**/*.test.tsx`           | Rendered components, MSW for HTTP                                                       | Accessible queries (`getByRole`), forms, keyboard interaction, loading/error/empty states, theme toggling                                                        |
| **API integration** | Vitest + Supertest                       | `apps/api/test/**/*.int.test.ts`       | Real Express app (`createApp()`), **real PostgreSQL** (`TEST_DATABASE_URL`), real Redis | Routing, validation, auth/session flows, RBAC, **cross-tenant isolation**, error shapes, rate limits                                                             |
| **Worker**          | Vitest                                   | `apps/api/src/jobs/**/*.test.ts`       | Processors invoked directly with fake clock; queue wiring tested against Redis          | SLA breach detection, idempotency, retries                                                                                                                       |
| **Real-time**       | Vitest + `socket.io-client`              | `apps/api/test/realtime/*.int.test.ts` | Running server on an ephemeral port                                                     | Handshake auth, room authorization, no cross-org event leakage                                                                                                   |
| **End-to-end**      | Playwright                               | `e2e/tests/**/*.spec.ts`               | Built web app + API + worker                                                            | Login/logout, create ticket → reply → SLA indicator, assign, real-time update across two browser contexts, dark-mode render, axe accessibility scan of key pages |

## Rules

1. **Never mock the database in integration tests.** Isolation guarantees come from real
   constraints, which mocks can't verify.
2. **Every tenant-scoped endpoint has a cross-tenant test** (see
   [data-model.md](./architecture/data-model.md#layer-4--tests-that-try-to-break-it)).
3. **Every permission rule has an allow test and a deny test.**
4. **Time is injected.** SLA tests use a fake `Clock`, never real timers or `sleep`.
5. **Tests are independent.** Integration tests truncate tables between files and build
   data with factory helpers (`createOrg()`, `createAgent()`, `createTicket()`), not shared fixtures.
6. **Accessible queries first.** Component tests use `getByRole` / `getByLabelText`. `data-testid` is a last resort.
7. **E2E stays small and stable.** Only critical journeys. No arbitrary waits; use web-first assertions.

## Test database lifecycle

```
pnpm test:integration (Vitest "integration" projects in packages/db, then apps/api)
 └─ globalSetup: refuse to run unless TEST_DATABASE_URL is set and differs from DATABASE_URL,
    then `prisma migrate reset --force` — applies the committed migration SQL from scratch
    (shared helper: `@pulsedesk/db/testing`)
     └─ tests create uniquely-named organizations and clean up after themselves
```

A missing test database is a **failure**, never a silent skip. Integration files run
serially (one database); unit and component tests run in parallel.

## Current suites (Phase 3)

| Workspace         | Command                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared` | `pnpm test`             | Role → permission matrix, role-management rules, problem-details contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/db`     | `pnpm test`             | Tenant guard (scoped/unscoped queries, compound keys, creates, upserts); shared enums match the Prisma schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/db`     | `pnpm test:integration` | Real PostgreSQL: composite FKs reject cross-tenant references; organization delete cascades; referenced rows can't be deleted; partial unique index and CHECK constraints; seed is idempotent and isolates tenants                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/shared` | `pnpm test`             | Auth request schemas: email normalization, 12–128 password policy, password ≠ email, unknown keys stripped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/api`        | `pnpm test`             | `GET /health` contract and headers; problem+json for 404/409/400/413/415/500; validation field errors; request IDs; log redaction; rate limiting; CORS; CSRF Origin check; env validation (incl. production cookie/secret rules); Argon2id parameters; session-token entropy and HMAC; graceful shutdown against a real HTTP server                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api`        | `pnpm test:integration` | Real PostgreSQL through the full app: registration transaction, duplicate and racing sign-ups, plaintext never stored, cookie attributes, HMAC-only token storage, generic invalid-credentials, logout and replayed tokens, absolute and idle expiry, session fixation, login/registration rate limits (per IP, per email, trusted proxy), no secrets in logs; tenant isolation: unauthenticated 401s, body/query/header organization smuggling, cross-tenant IDOR on member updates and removals (404 like a missing ID), switching into a foreign org, role-scoped switching, agent/admin/owner permission allow and deny cases, last-owner protection under concurrency, member removal |
| `apps/web`        | `pnpm test`             | Sign-in/sign-up forms (validation, focus, server errors, rate-limit and unreachable-API messages, email taken), session restore and redirect back, no token in browser storage, sign-out, organization switching, removed-member screen; shell landmarks and navigation; sidebar collapse persistence and `[` shortcut; mobile drawer; command menu (combobox semantics, filtering, ranking, navigation, theme commands); API status states; theme persistence; Button/Field accessibility wiring; chart table view                                                                                                                                                                        |
| `e2e`             | `pnpm test:e2e`         | Production builds of web + API against `TEST_DATABASE_URL` (migrated first): sign-up → reload → sign-out → wrong password → sign-in; HttpOnly/SameSite cookie not readable by scripts; redirect back after sign-in; duplicate email; axe scans of `/login` and `/signup`; real `/health` round-trip, theme persistence without flash, command menu, sidebar collapse, tablet rail, mobile drawer and no horizontal overflow, keyboard skip link, axe WCAG 2.2 AA scans of three pages in both themes                                                                                                                                                                                       |

## Coverage

Coverage will be collected with `@vitest/coverage-v8` once business modules exist. It is a
signal, not a target. The planned floor (80% lines) applies to `apps/api/src/modules/**`
services and policies, where business rules live. UI coverage is judged by meaningful
component tests, not percentages.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

1. **verify** — frozen-lockfile install → format check → lint → typecheck → unit/component
   tests → database integration tests (PostgreSQL 17 service container) → `db:deploy` and
   `db:seed` (twice, proving it is repeatable) against a separate application database →
   production builds.
2. **e2e** — after `verify` passes, with its own PostgreSQL service: build → Playwright
   (Chromium; migrates the database, then signs up a user once and reuses its session) →
   HTML report uploaded on failure.

The service container creates only `pulsedesk_test` (`POSTGRES_DB`); the workflow creates the
`pulsedesk` application database with `createdb` before migrating it, so `DATABASE_URL` and
`TEST_DATABASE_URL` always point at two real, distinct databases. Runners are pinned to
`ubuntu-24.04` so image upgrades are deliberate.

**AI coding agents:** Prisma 7 refuses `prisma migrate reset` (used by the integration
setup) when it detects an AI agent, until the user explicitly consents. It is passed by
setting `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` to the user's consent message. Grant it
only for disposable databases.

Redis joins the CI services when the API starts using it.
