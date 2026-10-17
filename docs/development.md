# Development Guide

## Prerequisites

| Tool                                           | Version  | Required for                                                |
| ---------------------------------------------- | -------- | ----------------------------------------------------------- |
| Node.js                                        | 24.x LTS | Everything (see `.nvmrc`)                                   |
| pnpm                                           | 11.x     | Everything (pinned via `packageManager`; `corepack enable`) |
| PostgreSQL                                     | 15+      | Migrations, seed, database integration tests                |
| Redis-compatible server (Redis/Valkey/Memurai) | 7+       | Nothing yet — reserved for background jobs (see below)      |

**Docker and WSL are not required.** Install PostgreSQL natively (e.g. the EDB installer on
Windows, Homebrew on macOS, your distro package on Linux) and point `.env` at it.
`docker-compose.yml` remains an optional shortcut for people who already use Docker.

### What runs without which service

| Service missing | Still works                                                                                            | Doesn't work                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| PostgreSQL      | Web app, API (`/health` doesn't touch the DB), `pnpm check` (lint, typecheck, unit tests, builds), E2E | `db:migrate`, `db:seed`, `db:studio`, `pnpm test:integration`          |
| Redis           | Everything in this phase                                                                               | — (the API uses an in-memory rate-limit store until Redis is wired in) |

## First-time setup

```bash
cp .env.example .env     # adjust DATABASE_URL / TEST_DATABASE_URL if needed
pnpm install             # also generates the Prisma client
```

### Database (native PostgreSQL)

Create a development role and two databases once, as the `postgres` superuser
(e.g. `psql -U postgres -h localhost`):

```sql
CREATE ROLE pulsedesk LOGIN CREATEDB PASSWORD 'pulsedesk_dev_password';
CREATE DATABASE pulsedesk      OWNER pulsedesk;
CREATE DATABASE pulsedesk_test OWNER pulsedesk;
```

`CREATEDB` lets `prisma migrate dev` create its temporary shadow database. The password
is a local-development placeholder that matches `.env.example` — use your own if the
server is reachable by anyone else.

```bash
pnpm db:deploy           # apply committed migrations to DATABASE_URL
pnpm db:seed             # load the two demo organizations (safe to re-run)
```

Alternatively, with Docker: `pnpm services:up` starts PostgreSQL 17 and Redis 7 with the
same credentials and creates both databases.

### Run the apps

```bash
pnpm dev                 # web → http://localhost:5173, API → http://127.0.0.1:4000
```

Vite proxies `/api` and `/health` to the API, so the browser only ever talks to one origin.
The sidebar's status indicator shows whether the API is reachable.

## Seed data

`pnpm db:seed` deletes and recreates only the records it owns (matched by organization
slug and user email), so it is safe to run repeatedly. It refuses to run when
`NODE_ENV=production`.

| Organization       | Slug         | Members                                                                                                                          |
| ------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Brightwave Energy  | `brightwave` | maya@brightwave.test (Owner), jonah@brightwave.test (Admin), priya@ / sam@brightwave.test (Agents), riley@pulsedesk.test (Agent) |
| Kestrel Outfitters | `kestrel`    | elena@kestrel.test (Owner), marcus@kestrel.test (Agent), riley@pulsedesk.test (Admin)                                            |

`riley@pulsedesk.test` belongs to **both** organizations with different roles, to exercise
multi-tenant isolation. Every seeded user has the development-only password
`pulsedesk-dev-password` (hashed with Argon2id). Login itself arrives in Phase 3. All
names are fictional; user emails use the reserved `.test` TLD and customers use `example.com`.

## Commands

All commands run from the repository root.

| Command                              | What it does                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                           | Web (Vite) and API (tsx watch) together                                                                                                |
| `pnpm dev:web` / `dev:api`           | One app only                                                                                                                           |
| `pnpm check`                         | **The quality gate:** format check → lint → typecheck → unit tests → production builds. Stops at the first failure and exits non-zero. |
| `pnpm format` / `format:check`       | Prettier write / verify                                                                                                                |
| `pnpm lint` / `lint:fix`             | ESLint (type-aware, accessibility and architecture-boundary rules), zero warnings allowed                                              |
| `pnpm typecheck`                     | `tsc --noEmit` in every workspace (regenerates the Prisma client first)                                                                |
| `pnpm test`                          | Unit and component tests (Vitest) — no external services needed                                                                        |
| `pnpm test:integration`              | Database tests against a real PostgreSQL (`TEST_DATABASE_URL`, wiped on every run)                                                     |
| `pnpm test:e2e`                      | Playwright against production builds — run `pnpm build` first; first time also `pnpm --filter @pulsedesk/e2e run install-browsers`     |
| `pnpm build`                         | Production builds (`apps/api/dist`, `apps/web/dist`)                                                                                   |
| `pnpm db:generate`                   | Regenerate the Prisma client                                                                                                           |
| `pnpm db:migrate`                    | `prisma migrate dev` — create a new migration after editing `schema.prisma`                                                            |
| `pnpm db:deploy`                     | `prisma migrate deploy` — apply committed migrations                                                                                   |
| `pnpm db:seed`                       | Load demo data                                                                                                                         |
| `pnpm db:studio`                     | Prisma Studio                                                                                                                          |
| `pnpm services:up` / `services:down` | Optional Docker services                                                                                                               |

`pnpm check` deliberately excludes `test:integration` and `test:e2e` because they need
PostgreSQL and a browser; CI runs both on every push (see `.github/workflows/ci.yml`).

Per workspace: `pnpm --filter @pulsedesk/api <script>`.

## Environment configuration

- **`.env.example`** documents every variable and marks each one **[used]** (read today) or
  **[reserved]** (documented for a later phase). It contains no real credentials.
- **`.env`** lives at the repository root and is git-ignored. The API, Prisma config and seed
  load it automatically for local development; variables already set in the environment win.
- The API validates its configuration with Zod at startup (`apps/api/src/config/env.ts`) and
  exits with a list of every invalid variable — by name, never echoing the value. In
  production it additionally requires `https://` web origins.
- In production, configuration comes from the platform's environment/secret store, never files.
- Only `VITE_`-prefixed variables can reach the browser bundle. They must never hold secrets.

## Troubleshooting

- **`prisma migrate diff` prints nothing.** Prisma 7's schema engine needs a datasource even
  for offline diffs; without `DATABASE_URL` it silently outputs nothing. Set it (any syntactically
  valid URL works for `--from-empty --to-schema`).
- **pnpm adds `minimumReleaseAgeExclude` entries to `pnpm-workspace.yaml`.** pnpm 11 refuses
  packages published in the last day. Don't commit bypasses; pin the previous release instead.
- **API status says "unreachable".** Start the API (`pnpm dev:api`) and check `API_PORT`.
- **Windows:** `.gitattributes` forces LF line endings; graceful shutdown responds to Ctrl+C
  in a terminal (Windows has no SIGTERM for console apps).
