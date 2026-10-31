# Architecture Overview

> Status: **Phase 5E — SLA policy management, plus invitations and member management.** This document describes the target architecture;
> [Implementation status](#implementation-status) says what exists today.

## 1. System context

```
                   ┌──────────────────────────── Browser ────────────────────────────┐
                   │  apps/web  (React SPA: Router, Tailwind, shadcn/ui, Framer Motion)│
                   └───────────────┬──────────────────────────────┬──────────────────┘
                     HTTPS + cookie │ /api/*                        │ /socket.io (WebSocket, same cookie)
                                   ▼                               ▼
                   ┌──────────────────────────── apps/api ──────────────────────────────┐
                   │  Express HTTP server  ─┬─  Socket.IO server                         │
                   │                        │                                            │
                   │        modules/* (routes → controllers → services → repositories)  │
                   └───────┬───────────────────────┬────────────────────────┬───────────┘
                           │ Prisma                 │ enqueue / pub-sub      │
                           ▼                        ▼                        │
                     ┌───────────┐            ┌───────────┐                  │
                     │ PostgreSQL│◄───────────│   Redis   │                  │
                     └───────────┘   Prisma   └─────▲─────┘                  │
                           ▲                        │ BullMQ consume         │
                           │        ┌───────────────┴────────────┐           │
                           └────────│ apps/api worker entrypoint │───────────┘
                                    │ (SLA timers, notifications,│  emits real-time
                                    │  analytics rollups)        │  events via Redis adapter
                                    └────────────────────────────┘
```

The browser only ever talks to **one origin**. In development the Vite dev
server proxies `/api` and `/socket.io` to the API; in production a reverse
proxy does the same. Same-origin keeps the session cookie first-party and lets
us use `SameSite=Lax` without CORS credential gymnastics.

## 2. Monorepo layout

Package manager: **pnpm workspaces** (strict `node_modules`, fast, content-addressed store).
No extra build orchestrator (Turborepo/Nx) until build times justify one.

```
pulsedesk/
├── apps/
│   ├── web/                 # React + Vite SPA
│   └── api/                 # Express + Socket.IO server AND BullMQ worker (two entrypoints)
├── packages/
│   ├── shared/              # Zod schemas, DTO types, enums, error codes shared by web & api
│   └── db/                  # Prisma schema, migrations, generated client, seed script
├── e2e/                     # Playwright end-to-end suite (drives web + api together)
├── infra/
│   └── postgres/init/       # Dev-only DB bootstrap SQL (creates the test database)
├── docs/                    # Architecture, conventions, development & testing guides
├── docker-compose.yml       # Local PostgreSQL + Redis
├── .env.example             # Documented, credential-free environment template
├── package.json             # Root scripts that fan out to workspaces
└── pnpm-workspace.yaml
```

### Responsibilities

| Workspace         | Name                | Owns                                                                                               | Must not                                                  |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/web`        | `@pulsedesk/web`    | Routing, pages, UI components, client state, data fetching, theming, accessibility                 | Contain business rules beyond UX validation; read secrets |
| `apps/api`        | `@pulsedesk/api`    | HTTP API, auth/sessions, RBAC, business logic, Socket.IO, job producers **and** the worker process | Import anything from `apps/web`                           |
| `packages/shared` | `@pulsedesk/shared` | Request/response Zod schemas, inferred TS types, enums, `ErrorCode` union, permission names        | Import Node-only or browser-only APIs; depend on Prisma   |
| `packages/db`     | `@pulsedesk/db`     | `schema.prisma`, migrations, Prisma client factory, seed data                                      | Contain business logic; be imported by `apps/web`         |
| `e2e`             | `@pulsedesk/e2e`    | Playwright specs, fixtures, global setup (seeded tenants)                                          | Be imported by any other workspace                        |

**Why the worker lives in `apps/api`:** SLA evaluation, notification fan-out and
analytics rollups reuse the same domain services and repositories as the HTTP
layer. A second entrypoint (`src/worker.ts`) shares that code without a
premature `packages/core` extraction. It still runs as a **separate process**,
so it scales and fails independently of the HTTP server.

**Why shadcn/ui components live in `apps/web`:** shadcn copies component source
into the app; there is only one consumer, so a `packages/ui` would be indirection
with no benefit.

## 3. Backend layering (`apps/api`)

Code is organized **by feature module**, each with the same internal layers:

```
apps/api/src/
├── server.ts                 # HTTP + Socket.IO entrypoint
├── worker.ts                 # BullMQ worker entrypoint
├── app.ts                    # Express app factory (no listen) — used by server and tests
├── config/env.ts             # Zod-validated environment; process exits on invalid config
├── http/
│   ├── middleware/           # requestId, logger, helmet, rateLimit, session, requireRole, originCheck
│   ├── errors.ts             # AppError hierarchy + central error handler (RFC 9457 problem+json)
│   └── validate.ts           # Zod request validation helper
├── realtime/                 # Socket.IO setup, auth handshake, room authorization, event emitters
├── jobs/                     # Queue definitions, producers, processors
├── lib/                      # logger, redis, clock, crypto helpers
└── modules/
    ├── auth/                 # login, logout, session lifecycle
    ├── organizations/
    ├── members/              # memberships, roles
    ├── invitations/          # invite links: create, revoke, preview, accept, sign up
    ├── teams/
    ├── customers/
    ├── tickets/
    ├── messages/
    ├── sla/                  # breach sweep
    ├── sla-policies/         # default policy targets (GET/PUT /sla-policy)
    └── analytics/
        ├── tickets.routes.ts       # path + middleware + validation wiring only
        ├── tickets.controller.ts   # maps HTTP ⇄ service call; no business rules
        ├── tickets.service.ts      # business rules; framework-agnostic; takes a TenantContext
        ├── tickets.repository.ts   # Prisma queries; always scoped by organizationId
        ├── tickets.policy.ts       # authorization rules (who may do what)
        └── tickets.service.test.ts
```

Dependency direction is strictly downward:

```
routes → controller → service → repository → Prisma
                         ↘ policy, jobs (producers), realtime (emitters)
```

- **Controllers** never touch Prisma. **Services** never touch `req`/`res`.
  **Repositories** never make authorization decisions.
- Services receive a `TenantContext` (`{ organizationId, userId, role, requestId }`)
  built by middleware from the session. They do not read it from globals.
- Services and repositories are plain functions/classes with injected dependencies,
  so they are unit-testable without HTTP.

## 4. Cross-cutting concerns

| Concern              | Approach                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config**           | `config/env.ts` parses `process.env` with Zod once at startup; the app refuses to boot on invalid or missing values. The rest of the code imports the typed `env` object, never `process.env`.                                                                                                                         |
| **Validation**       | Every route declares Zod schemas (from `@pulsedesk/shared`) for `params`, `query` and `body`. Unknown keys are stripped. The same schemas power client-side form validation.                                                                                                                                           |
| **Errors**           | Services throw typed `AppError`s (`NotFoundError`, `ForbiddenError`, `ConflictError`, `ValidationError`, …) carrying a stable `ErrorCode`. One Express error handler maps them to `application/problem+json` responses with `requestId`. Unknown errors become a generic 500; stack traces are logged, never returned. |
| **Logging**          | `pino` + `pino-http`, JSON in production, pretty in development. Every line carries `requestId`, and `userId` / `organizationId` once authenticated. Cookies, `Authorization`, passwords and tokens are redacted.                                                                                                      |
| **Request IDs**      | Middleware accepts an inbound `X-Request-Id` only if it matches a safe pattern (UUID/≤64 URL-safe chars), otherwise generates a UUID. Echoed in the response header and attached to logs, errors, audit entries and enqueued jobs.                                                                                     |
| **Security headers** | `helmet` with a strict CSP for the API (`default-src 'none'`). The web app's CSP is set by the serving layer. `X-Powered-By` disabled.                                                                                                                                                                                 |
| **Rate limiting**    | `express-rate-limit` with a Redis store so limits hold across instances: a global per-IP limit, and a much stricter limit on `/auth/*` keyed by IP **and** by target email.                                                                                                                                            |
| **CORS**             | Not needed in the same-origin deployment. If enabled, it is an explicit allowlist from `WEB_ORIGIN` with credentials — never `*`.                                                                                                                                                                                      |
| **Real-time**        | Socket.IO authenticates the handshake with the same session cookie and checks `Origin`. Sockets join `org:{id}` and, after a policy check, `ticket:{id}` rooms. Servers emit only after the DB transaction commits. The Redis adapter lets the worker and multiple API instances emit.                                 |
| **Background jobs**  | BullMQ queues: `sla` (delayed jobs at due times that re-check and mark breaches), `notifications`, `analytics`. Jobs carry only IDs plus `organizationId`, are idempotent, and use bounded retries with exponential backoff.                                                                                           |
| **Time**             | All timestamps are UTC `timestamptz`. A `Clock` abstraction is injected into SLA code so tests can control time.                                                                                                                                                                                                       |

## 5. Multi-tenancy and authorization

Summarized here; full details are in [data-model.md](./data-model.md) and
[auth-and-sessions.md](./auth-and-sessions.md).

- **Shared database, shared schema, `organizationId` on every tenant-owned row.**
- Isolation is enforced in **four layers**: session-derived tenant context →
  repositories that require `organizationId` → composite foreign keys that make
  cross-tenant references impossible in the DB → mandatory cross-tenant tests.
- **RBAC** roles per membership: `OWNER`, `ADMIN`, `AGENT`. Permissions are named
  (`ticket:assign`, `member:invite`, …) and mapped to roles in one table in
  `@pulsedesk/shared`, so the UI can hide what the API would reject. **The API is
  always the authority.**
- Resources from another organization return **404**, not 403, so their existence isn't revealed.

## 6. Frontend architecture (`apps/web`)

- **Routing:** React Router data routers; route-level code splitting; an
  authenticated layout route (`RequireAuth`) that loads `/api/v1/auth/session` and redirects
  to `/login` on 401.
- **Server state:** TanStack Query for caching, retries and invalidation. Socket.IO
  events invalidate or patch query caches, never a second source of truth.
- **Forms:** React Hook Form + the shared Zod schemas.
- **UI:** Tailwind CSS v4 with CSS-variable design tokens; shadcn/ui (Radix
  primitives) for accessible components; Framer Motion for meaningful transitions
  only, and it honors `prefers-reduced-motion`.
- **Theming:** light/dark/system via a `class` on `<html>`, set before first paint to
  avoid a flash; persisted in `localStorage`.
- **Accessibility target:** WCAG 2.2 AA — keyboard-navigable, visible focus,
  labelled controls, live regions for real-time ticket updates, contrast checked in both themes.

## 7. Key decisions

| #   | Decision                                                                  | Alternatives considered                  | Rationale                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | pnpm workspaces, no Turborepo yet                                         | npm workspaces, Nx, Turborepo            | Strict deps and speed; a build orchestrator is unnecessary at 4 packages                                                                                                                                                   |
| D2  | Opaque server-side sessions in Postgres                                   | JWT in cookies, Redis sessions           | Instant revocation, simple mental model, auditable; Postgres is already the source of truth                                                                                                                                |
| D3  | Shared schema + `organizationId` + composite FKs                          | Schema-per-tenant, DB-per-tenant         | Operationally simple, works with Prisma migrations; composite FKs give DB-level guarantees                                                                                                                                 |
| D4  | Postgres Row-Level Security deferred                                      | RLS from day one                         | RLS with Prisma requires per-transaction `SET LOCAL` plumbing; planned as defense-in-depth once the repository layer is stable (see roadmap)                                                                               |
| D5  | Worker as second entrypoint of `apps/api`                                 | Separate `apps/worker` + `packages/core` | Avoids premature extraction; still separate processes                                                                                                                                                                      |
| D6  | Same-origin deployment behind a proxy                                     | Separate API domain + CORS               | First-party cookies, `SameSite=Lax`, no credentialed CORS                                                                                                                                                                  |
| D7  | Prisma 7 (stable line), not 8.0 RC                                        | Track `latest`                           | `prisma@latest` currently points to an 8.0 release candidate; we pin stable                                                                                                                                                |
| D8  | RFC 9457 problem+json errors                                              | Ad-hoc error shape                       | Standard, self-describing, carries `requestId` and `code`                                                                                                                                                                  |
| D9  | TypeScript 6.0 and ESLint 9 (not TS 7 / ESLint 10)                        | Latest majors                            | TypeScript 7 (native port) does not expose the compiler API `typescript-eslint` needs (it supports `<6.1`); `eslint-plugin-jsx-a11y` does not support ESLint 10 yet. Revisit when both catch up.                           |
| D10 | Internal packages ship TypeScript source; the API is bundled with esbuild | Pre-compiling each package to `dist/`    | No build step or watch process for `@pulsedesk/shared`/`db` in development (Vite, tsx and Vitest consume `.ts` directly). The API's production bundle inlines workspace code and keeps npm dependencies external.          |
| D11 | Liveness-only `GET /health`, mounted before rate limiting                 | Health check that pings PostgreSQL/Redis | A dependency outage must not make orchestrators restart healthy API processes. Readiness is separate: `GET /health/ready` (Phase 3) checks PostgreSQL, sits behind the global rate limit, and answers 503 without details. |
| D12 | In-memory rate-limit store for now                                        | Redis store immediately                  | Correct for one API instance and keeps Redis optional during development. Switches to a Redis store when Redis is introduced (needed before running more than one instance).                                               |
| D13 | Pin dependencies to releases at least one day old                         | Always newest                            | pnpm 11's `minimumReleaseAge` supply-chain policy; bypass entries are not committed.                                                                                                                                       |

## Implementation status

| Area                                                                                                                                                                                           | Status                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Repository foundation, tooling (TypeScript, ESLint, Prettier), CI workflow                                                                                                                     | ✅ Phase 2                                                                   |
| `packages/shared` — error codes, problem-details contract, roles & permissions, ticket enums, health contract                                                                                  | ✅ Phase 2                                                                   |
| `packages/db` — Prisma schema, initial migration, client factory with tenant guard, idempotent seed                                                                                            | ✅ Phase 2 (see [development.md](../development.md) for how it was verified) |
| `apps/api` — env validation, request IDs, structured logging with redaction, problem+json errors, helmet, CORS allowlist, rate limiting, Origin (CSRF) check, `GET /health`, graceful shutdown | ✅ Phase 2                                                                   |
| `apps/web` — design system, app shell (sidebar, drawer, top bar, command menu, theme), dashboard preview with labelled sample data                                                             | ✅ Phase 2                                                                   |
| `e2e` — Playwright journeys + axe WCAG 2.2 AA scans in both themes                                                                                                                             | ✅ Phase 2                                                                   |
| Authentication (sign-up, sign-in, sign-out, session restore), organization switching, tenant context, RBAC, organization and member APIs                                                       | ✅ Phase 3                                                                   |
| Invitations (single-use hashed links, 7-day expiry, invited email only) and member-management UI                                                                                               | ✅ Phase 3 (remaining part)                                                  |
| Password reset                                                                                                                                                                                 | ⏳ later (needs email delivery)                                              |
| Ticket read path: `GET /tickets` (filters, cursor pagination), `GET /tickets/:number` (conversation, internal notes, typed timeline), `GET /teams`, `GET /tags`; inbox and read-only detail UI | ✅ Phase 4A                                                                  |
| Ticket write path: `POST /tickets`, `PATCH /tickets/:number`, `POST /tickets/:number/messages`, lifecycle rules, typed timeline events; ticket creation, editable properties and composer UI   | ✅ Phase 4B                                                                  |
| Directory and settings: customers (list, search, detail, edit, ticket history), team and tag management, global search (`GET /search`, command menu), organization settings                    | ✅ Phase 4C                                                                  |
| Reliability review: lock ordering for concurrent writes, bounded transaction retry, write-endpoint authorization matrix, no-op writes skip audit                                               | ✅ Phase 4D                                                                  |
| Test-database safety: reset/E2E target guard (local `pulsedesk_test` only), migration SQL scanner, migration-upgrade test                                                                      | ✅ Phase 5A                                                                  |
| SLA data layer: breach markers, event actor type (`USER`/`SYSTEM`), auto-close settings and sweep indexes; `evaluateSla`                                                                       | ✅ Phase 5B                                                                  |
| SLA breach detection: default policy at sign-up, in-process breach sweep (single instance), computed `sla` in ticket responses, SLA badges in the inbox and ticket details                     | ✅ Phase 5C                                                                  |
| Auto-close: per-organization settings (API + settings UI), in-process sweep closing quiet solved tickets with a SYSTEM timeline event                                                          | ✅ Phase 5D                                                                  |
| SLA policy management (`/sla`): default policy targets per priority (`GET`/`PUT /api/v1/sla-policy`, audited), new tickets only, premium page with a read-only view for agents                 | ✅ Phase 5E                                                                  |
| Email delivery, Socket.IO, Redis/BullMQ, analytics                                                                                                                                             | ⏳ Phase 4C–6                                                                |
