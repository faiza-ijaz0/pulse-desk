# PulseDesk

**PulseDesk** is a multi-tenant customer support platform. Organizations use it to
manage support tickets, customer conversations, support agents and teams,
service-level agreements (SLAs), and team analytics.

> **Project status: Phase 5E complete, plus invitations and member management.**
> Sign-up (which creates your organization and its default SLA policy), sign-in, organization
> switching, tenant isolation, role enforcement, tickets (inbox, detail, replies, internal notes,
> timeline), customers, teams, tags and search work end to end against PostgreSQL. SLA due dates,
> live SLA states, automatic breach recording, per-organization auto-close and editable SLA
> targets work too, and so do invitation links and member management.
> Not built yet: password reset, email delivery, real-time updates and
> analytics; the dashboard shows clearly-labelled **sample data**. See [Roadmap](#roadmap).

## Planned features

- **Tickets** with statuses, priorities, tags, assignment to agents and teams, and per-org ticket numbers
- **Conversations**: public replies and internal notes, updated in real time
- **SLA policies** with first-response and resolution targets per priority, and background breach detection
- **Teams and roles**: Owner, Admin and Agent roles, with invitations and an audit log
- **Analytics**: response and resolution times, SLA compliance, agent throughput
- **Strict organization isolation**, enforced in application code _and_ by database constraints
- Accessible, responsive UI with light and dark themes

## Tech stack

| Layer           | Technology                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Frontend        | React 19, TypeScript, Vite 8, React Router 8, Tailwind CSS 4, shadcn/ui-style components on Radix, Framer Motion, TanStack Query |
| Backend         | Node.js 24, Express 5, TypeScript, Zod, pino, helmet                                                                             |
| Database        | PostgreSQL + Prisma ORM 7                                                                                                        |
| Auth            | Server-managed sessions in PostgreSQL, HttpOnly cookies, Argon2id                                                                |
| Real-time, jobs | Socket.IO, Redis + BullMQ (later phases)                                                                                         |
| Testing         | Vitest, React Testing Library, Supertest, Playwright + axe                                                                       |
| Tooling         | pnpm workspaces, ESLint (type-aware + jsx-a11y), Prettier, GitHub Actions                                                        |

Everything is open source and self-hostable. No paid APIs, Supabase or Firebase.

## Repository layout

```
apps/web          React SPA — design system, app shell, pages
apps/api          Express API (worker entrypoint arrives with background jobs)
packages/shared   Zod contracts, error codes, roles & permissions, ticket enums
packages/db       Prisma schema, migrations, client factory with tenant guard, seed
e2e               Playwright end-to-end + accessibility tests
infra             Optional Docker bootstrap SQL
docs              Architecture, design system and engineering guides
```

## Quick start

Requires Node.js 24, pnpm 11 and (for database work) PostgreSQL. Docker is optional.

```bash
cp .env.example .env
pnpm install
pnpm dev                 # web → http://localhost:5173, API → http://127.0.0.1:4000
```

Database setup, seed users and every command: [docs/development.md](docs/development.md).

```bash
pnpm check               # format, lint, typecheck, unit tests, builds — the local quality gate
pnpm test:integration    # database tests (needs TEST_DATABASE_URL)
pnpm build && pnpm test:e2e
```

## Documentation

| Document                                                            | Contents                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [Architecture overview](docs/architecture/overview.md)              | System context, workspace responsibilities, backend layering, cross-cutting concerns, key decisions, implementation status     |
| [Data model & tenant isolation](docs/architecture/data-model.md)    | Entities, ticket lifecycle, the four-layer isolation strategy, Phase 2 schema changes                                          |
| [Authentication & sessions](docs/architecture/auth-and-sessions.md) | Session lifecycle, cookie settings, CSRF, RBAC, Socket.IO auth, abuse protection                                               |
| [Design system](docs/design-system.md)                              | Tokens, components, responsive layout, motion, accessibility and preview-honesty rules                                         |
| [Coding conventions](docs/conventions.md)                           | TypeScript, naming, API design, layering rules, linting, git workflow                                                          |
| [Development guide](docs/development.md)                            | Setup without Docker, seed data, commands, environment configuration, troubleshooting                                          |
| [Testing strategy](docs/testing.md)                                 | Test layers, current suites, test database lifecycle, CI                                                                       |
| [Deployment](docs/deployment.md)                                    | Vercel frontend + proxy, Render API, Neon PostgreSQL: secrets, proxy-secret enforcement, cold starts, migrations, verification |

## Roadmap

| Phase                               | Scope                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **1 — Foundation** ✅               | Architecture, data model, auth design, conventions                                                                 |
| **2 — Skeleton & quality gates** ✅ | Monorepo, design system and app shell, API foundation, schema + migration + seed, tests, CI                        |
| **3 — Auth & organizations** 🚧     | Sign-in, sessions, org switching, memberships, invitations, RBAC, cross-tenant API test harness ✅; password reset |
| **4 — Tickets & conversations** 🚧  | Ticket inbox, messages and notes, assignment, tags, filters ✅; Socket.IO live updates                             |
| **5 — SLAs & jobs** 🚧              | Due dates, SLA states, breach detection, auto-close, SLA policy management ✅; notifications                       |
| **6 — Analytics & polish**          | Live dashboards, accessibility audit, performance, PostgreSQL RLS defense-in-depth                                 |

## License

Not yet decided.
