# Contributing to PulseDesk

Thanks for your interest in PulseDesk. This guide covers how the repository is organized,
how to run it locally, and what a change needs before it can be merged.

## Repository structure

| Path              | Workspace           | Contents                                                                     |
| ----------------- | ------------------- | ---------------------------------------------------------------------------- |
| `apps/web`        | `@pulsedesk/web`    | React single-page app: pages, components, design system                      |
| `apps/api`        | `@pulsedesk/api`    | Express API: auth, tenancy, tickets, SLA and auto-close sweeps               |
| `packages/shared` | `@pulsedesk/shared` | Zod request/response contracts, error codes, roles and permissions, SLA math |
| `packages/db`     | `@pulsedesk/db`     | Prisma schema, migrations, client factory with tenant guard, seed            |
| `e2e`             | `@pulsedesk/e2e`    | Playwright end-to-end and accessibility tests                                |
| `infra`           | —                   | SQL used by the optional Docker setup to create the test database            |
| `docs`            | —                   | Architecture and engineering guides                                          |

[docs/architecture/overview.md](docs/architecture/overview.md) explains how the pieces fit
together, and [docs/conventions.md](docs/conventions.md) the coding rules.

## Prerequisites

- **Node.js 24** (see `.nvmrc`).
- **pnpm 11**, pinned through `packageManager` in `package.json`. Run `corepack enable` once.
- **PostgreSQL 15 or newer** for migrations, the seed, integration and E2E tests. A native
  install works on every platform; Docker is optional (`pnpm services:up`).

## Local setup

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
pnpm install                # also generates the Prisma client
```

Create the development role and the two databases once (see
[docs/development.md](docs/development.md#database-native-postgresql)), then:

```bash
pnpm db:deploy              # apply committed migrations to DATABASE_URL
pnpm db:seed                # load the demo organizations (safe to re-run)
pnpm dev                    # web → http://localhost:5173, API → http://127.0.0.1:4000
```

## Environment configuration

- `.env.example` documents every variable and marks it **[used]** or **[reserved]**. It
  contains only local placeholders, never real credentials.
- `.env` is git-ignored. **Never commit it**, and never put real secrets in `.env.example`,
  code, tests, docs or commit messages.
- `TEST_DATABASE_URL` must point at a **separate, disposable** database: integration tests
  wipe it on every run. A safety guard only allows a local database named `pulsedesk_test`.
- The API validates its configuration at startup (`apps/api/src/config/env.ts`) and lists
  any invalid variable by name.

## Checks

All commands run from the repository root.

| Command                 | What it checks                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `pnpm format:check`     | Prettier formatting (`pnpm format` fixes it)                                         |
| `pnpm lint`             | ESLint, type-aware, with accessibility and layering rules; zero warnings allowed     |
| `pnpm typecheck`        | `tsc --noEmit` in every workspace                                                    |
| `pnpm test`             | Unit and component tests (Vitest, React Testing Library); no services needed         |
| `pnpm test:integration` | API and database tests against real PostgreSQL (`TEST_DATABASE_URL`, wiped each run) |
| `pnpm build`            | Production builds of the API and web app                                             |
| `pnpm test:e2e`         | Playwright against the production builds; run `pnpm build` first                     |
| `pnpm check`            | **The local quality gate:** format check, lint, typecheck, unit tests and builds     |

Before the first E2E run, install the browser once:
`pnpm --filter @pulsedesk/e2e run install-browsers`.

Run `pnpm check`, `pnpm test:integration` and `pnpm test:e2e` **one after another**, not in
parallel: they share ports and the test database. CI (`.github/workflows/ci.yml`) runs all
of them on every push to `main` and on every pull request.

[docs/testing.md](docs/testing.md) describes the test layers and what each suite covers.

## Database changes

- Edit `packages/db/prisma/schema.prisma`, then create a migration with `pnpm db:migrate`
  against your **local** database.
- Never edit a migration that has already been committed; add a new one instead.
- Migrations must be backwards-compatible with the running API (add first, remove later).
  Hand-written checks that stop on conflicting data are preferred over silently rewriting it.
- Never run `db:migrate`, `db:seed`, `migrate reset`, `db push`, integration tests or E2E tests
  against a shared or production database.

## Branches and commits

- Work on a short-lived branch off `main` and open a pull request.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(tickets): …`, `fix(auth): …`, `test(e2e): …`, `docs: …`, `chore: …`.
- Keep each commit focused, and leave the build and tests passing at every commit where
  practical.

## Pull requests

A pull request should:

- explain **what** changed and **why**, and link any related issue;
- keep `pnpm check`, `pnpm test:integration` and `pnpm test:e2e` green;
- add or update tests for new behavior, including an allow **and** a deny test for every
  permission rule and a cross-tenant test for every tenant-scoped endpoint;
- include a reviewed migration for any schema change;
- update the documentation when behavior, configuration or commands change;
- keep the UI accessible (keyboard, labels, contrast in both themes); the E2E suite runs axe
  scans;
- contain no secrets, `.env` files, build output or generated files.

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
