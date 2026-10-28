# Data Model and Tenant Isolation

> The source of truth is [`packages/db/prisma/schema.prisma`](../../packages/db/prisma/schema.prisma)
> and its migrations in `packages/db/prisma/migrations/`. Changes made while moving the
> Phase 1 draft into the codebase are listed in [§4](#4-schema-changes-in-phase-2).

## 1. Entities

### Global (not owned by a tenant)

| Entity           | Purpose                   | Notes                                                                                                                                               |
| ---------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**         | A person who can sign in  | Email is globally unique, stored lower-cased. One user may belong to several organizations.                                                         |
| **Session**      | Server-side login session | Stores only an HMAC of the cookie token. Holds `activeOrganizationId`, `lastSeenAt` (idle timeout), `expiresAt` (absolute timeout) and `revokedAt`. |
| **Organization** | The tenant                | `slug` is unique. `ticketSequence` issues per-org ticket numbers (#1, #2, …).                                                                       |

### Tenant-scoped (every row has `organizationId`)

| Entity                  | Purpose                                            | Key relationships / constraints                                                                                                                                         |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Membership**          | A user's role within an organization               | `(organizationId, userId)` unique. Role: `OWNER` \| `ADMIN` \| `AGENT`. Assignment and team membership point at _memberships_, so only current members can be assigned. |
| **Invitation**          | Pending invite to join an org                      | Stores only a hash of the invite token; expires.                                                                                                                        |
| **Team**                | Group of agents (e.g. "Billing")                   | Unique name per org.                                                                                                                                                    |
| **TeamMember**          | Membership ↔ Team join                             | Composite FKs to both Team and Membership in the same org.                                                                                                              |
| **Customer**            | End user who raises tickets                        | `(organizationId, email)` unique. Not a login identity in v1.                                                                                                           |
| **SlaPolicy**           | Named set of SLA targets                           | One default per org (partial unique index added in the migration).                                                                                                      |
| **SlaTarget**           | First-response and resolution minutes per priority | `(slaPolicyId, priority)` unique.                                                                                                                                       |
| **Ticket**              | A support request                                  | `(organizationId, number)` unique. Status, priority, channel, assignee, team, SLA due/met timestamps.                                                                   |
| **Message**             | A conversation entry on a ticket                   | Author is an agent, a customer or the system. `PUBLIC` replies or `INTERNAL` notes.                                                                                     |
| **Tag** / **TicketTag** | Free-form labels                                   | Unique tag name per org.                                                                                                                                                |
| **TicketEvent**         | Append-only ticket timeline                        | Drives the activity feed **and** analytics: first-response time, resolution time, breach counts, agent throughput.                                                      |
| **AuditLog**            | Administrative actions                             | Role changes, invites, SLA policy edits, with actor, IP and `requestId`.                                                                                                |

### Relationship sketch

```
Organization ─┬─< Membership >── User ──< Session
              ├─< Invitation
              ├─< Team ──< TeamMember >── Membership
              ├─< Customer ──< Ticket
              ├─< SlaPolicy ──< SlaTarget
              │        └──────< Ticket
              ├─< Tag ──< TicketTag >── Ticket
              ├─< Ticket ─┬─< Message
              │           ├─< TicketEvent
              │           ├── assignee → Membership (same org)
              │           └── team     → Team       (same org)
              └─< AuditLog
```

### Ticket lifecycle

```
OPEN ──► PENDING (waiting on customer) ──► OPEN (customer replied)
  │  ╲
  │   ► ON_HOLD (waiting on third party) ──► OPEN
  ▼
SOLVED ──(customer reply)──► OPEN
  │
  └──(auto after N days, worker job)──► CLOSED   (terminal; a reply creates a follow-up ticket)
```

The rules are enforced by one pure function, `transitionTicketStatus` in
`packages/shared/src/ticket-lifecycle.ts`, used by the API (and later the auto-close job):

| From      | Agent may move to                      | Customer reply | System   |
| --------- | -------------------------------------- | -------------- | -------- |
| `OPEN`    | `PENDING`, `ON_HOLD`, `SOLVED`         | —              | —        |
| `PENDING` | `OPEN`, `ON_HOLD`, `SOLVED`            | `OPEN`         | —        |
| `ON_HOLD` | `OPEN`, `PENDING`, `SOLVED`            | `OPEN`         | —        |
| `SOLVED`  | `OPEN` (reopen)                        | `OPEN`         | `CLOSED` |
| `CLOSED`  | — (read-only: no updates, no messages) | —              | —        |

Entering `SOLVED` stamps `solvedAt`; reopening clears it; entering `CLOSED` stamps `closedAt`.
Ticket numbers come from an atomic increment of `Organization.ticketSequence` inside the
creation transaction (the row lock serializes concurrent creations). Updates and messages
lock the ticket row, so each sees fresh state and writes one `TicketEvent` per changed field.

SLA clocks: `firstResponseDueAt` is met by the first `PUBLIC` agent message.
`resolutionDueAt` is met by the transition to `SOLVED`. v1 uses **calendar time**. Due dates
come from the organization's default SLA policy at creation and follow priority changes
while still unmet. A due date that has already been reached is kept, so changing the
priority can't turn a missed target back into one on track.
Business-hours calendars and pausing the clock while `PENDING` are planned later.

SLA state is evaluated by one pure function, `evaluateSla(ticket, now)` in
`packages/shared/src/sla.ts`, so every caller classifies a ticket the same way at a given moment:

- Each target is `none` (no due date: no SLA policy applied at creation), `on_track`,
  `at_risk` (no more than 25 % of the window from creation to due date left), `met` or
  `breached`. The ticket's overall status is the most urgent of the two, a breach first
  (`resolution_breached`, then `first_response_breached`).
- At exactly the due date a target is still met; one millisecond later an unmet target is
  breached. A reply or solve stamped exactly at the due date meets it.
- First response stops only at `firstRespondedAt`. Internal notes never set it, and solving a
  ticket without a public reply doesn't meet it: the clock keeps running against the due date.
- Resolution stops when the ticket leaves the active statuses (`solvedAt`, or `closedAt` if a
  closed ticket has none). Reopening keeps `resolutionDueAt`, so a ticket reopened after its due
  date is breached again at once.
- Due dates are used as stored; evaluation never recalculates them.
- A recorded breach is history. `firstResponseBreachedAt` / `resolutionBreachedAt` are set
  once, in the same transaction as the matching `SLA_*_BREACHED` event, and never cleared; while
  set, that target evaluates as `breached` whatever happens to the ticket or its due date later.
  They hold the time the breach was recorded (as does the event's `createdAt`); the event's
  `data.dueAt` is the deadline that was missed. Nothing is backfilled for tickets that existed
  before the markers (migration `20261027000000_sla_breach_markers_and_auto_close`).
- A first-response breach is recorded for any ticket without a public agent reply by the due
  date — or with a late one — even if it is `SOLVED` or `CLOSED`.

Solved tickets close automatically `Organization.autoCloseAfterMinutes` after `solvedAt`
(default 5760, four days; 1 minute to 1 year) when `Organization.autoCloseEnabled` is true. The
delay is kept while auto-close is disabled. Organizations created after the setting was added
start enabled; those that already existed start **disabled**, keeping the behaviour they had
(nothing closed automatically) until an admin turns it on.

### Search

Customer and global search use Prisma `contains` with `mode: 'insensitive'` (a bound
`ILIKE` parameter). Prisma does not escape LIKE wildcards, so the API escapes `\`, `%` and `_`
first (`apps/api/src/lib/like.ts`). There is no trigram index yet: matches scan the
organization's rows, which is fine at current sizes; a `pg_trgm` GIN index is the next step if
search gets slow.

### Ticket timeline

`TicketEvent` is append-only. Its `data` column has a fixed shape per `type`, defined once in
`apps/api/src/modules/tickets/ticket-event-data.ts`; anything that writes events must produce
exactly that shape:

| `type`                                                    | `data`                                    |
| --------------------------------------------------------- | ----------------------------------------- |
| `CREATED`                                                 | `{}`                                      |
| `STATUS_CHANGED` / `PRIORITY_CHANGED`                     | `{ from, to }` (enum values)              |
| `ASSIGNED`                                                | `{ fromUserId, toUserId }` (UUID or null) |
| `TEAM_CHANGED`                                            | `{ fromTeamId, toTeamId }` (UUID or null) |
| `TAGS_CHANGED`                                            | `{ addedTagIds, removedTagIds }` (UUIDs)  |
| `MESSAGE_ADDED`                                           | `{ messageId, visibility }`               |
| `SLA_FIRST_RESPONSE_BREACHED` / `SLA_RESOLUTION_BREACHED` | `{ dueAt }` (ISO timestamp)               |

`actorType` says who caused an event: `USER` (with `actorUserId`, which becomes null if the
account is deleted) or `SYSTEM` (SLA sweeps, auto-close; never has a user). A null user alone
therefore never means "system". A ticket has at most one breach event per target.

Deleting a team or a tag also writes a `TEAM_CHANGED` / `TAGS_CHANGED` event on every
ticket that had it (team deletion first unassigns those tickets: Ticket → Team is NO ACTION),
plus an `AuditLog` entry with the number of tickets affected. Team and tag names are unique per
organization **regardless of case**: the database index is case-sensitive, so the API checks
case-insensitively inside a transaction holding the organization's row lock.

These IDs have no foreign keys, so `GET /api/v1/tickets/:number` resolves them **within the
ticket's organization only**: an ID from another tenant (or a deleted member, team or tag)
comes back with `name: null`. An event whose stored data doesn't match its schema is logged
and left out of the response rather than echoed as raw JSON.

## 2. Organization isolation strategy

**Model:** shared database, shared schema, tenant discriminator column (`organizationId`).
Isolation is enforced in layers, so one mistake doesn't leak data.

### Layer 1 — Tenant context comes only from the session

`organizationId` is **never** taken from the URL, query or body for authorization
purposes. The session middleware resolves `session.activeOrganizationId`, loads
the caller's `Membership` and builds:

```ts
type TenantContext = {
  organizationId: string;
  userId: string;
  role: Role;
  requestId: string;
};
```

If the membership no longer exists (the user was removed), the request fails with 401
and the session's active organization is cleared.

### Layer 2 — Repositories require `organizationId`

Every repository function for a tenant-scoped model takes `organizationId` as a
required argument and includes it in **every** `where` clause, including updates
and deletes:

```ts
// ✅ Correct — a lookup by id alone is never allowed for tenant data.
prisma.ticket.findFirst({ where: { id, organizationId } });
prisma.ticket.updateMany({ where: { id, organizationId }, data });

// ❌ Forbidden for tenant-scoped models.
prisma.ticket.findUnique({ where: { id } });
```

A Prisma client extension in `packages/db` (`src/tenant-guard.ts`, on by default outside
production) adds a runtime guard. It throws if a query on a tenant-scoped model lacks `organizationId` in `where`
(or in `data` for creates). The guard catches regressions. It does not replace
correct repository code.

### Layer 3 — Composite foreign keys (database guarantee)

Each tenant-scoped table that others reference has a `UNIQUE (organizationId, id)`
constraint. References inside a tenant use **composite** FKs:

```prisma
customer Customer @relation(fields: [organizationId, customerId],
                            references: [organizationId, id])
```

Even if application code is buggy, PostgreSQL **rejects** a ticket in org A that
points at a customer, team, assignee, SLA policy or tag in org B. Nullable
references (`assigneeUserId`, `teamId`) use PostgreSQL's default `MATCH SIMPLE`, so
the constraint applies only when the reference is set.

Consequence: these FKs use `onDelete: NoAction` (Prisma cannot `SetNull` half of a
composite key whose other column is required, and `Restrict` would break organization
deletion — see [§4](#4-schema-changes-in-phase-2)). Services must explicitly unassign
tickets before removing a member or deleting a team. This is a business rule
we want anyway.

### Concurrency (Phase 4D)

Writes that touch the same rows follow **one lock order**, so they wait for each other
instead of failing or deadlocking:

1. **Referenced rows first.** Ticket writes lock the members, teams and tags they assign
   `FOR KEY SHARE` while validating them, before touching the ticket. Deleting a team or tag
   locks that row `FOR UPDATE` first; removing a member locks the membership `FOR UPDATE`
   (a role change `FOR NO KEY UPDATE`) first.
2. **Then the Organization row** (ticket numbering; member role changes and removals).
3. **Then ticket rows.**

Consequences, each covered by a coordinated test in `concurrency.int.test.ts`:

- An assignment that validated a team, tag or member before it is deleted commits first; the
  delete then sees that ticket, unassigns it and records the matching timeline event.
- An assignment that arrives after the delete waits for it, then fails validation exactly like
  an unknown ID (400) — never a 500, never a dangling or silently removed reference.
- Team and tag name uniqueness is serialized per organization with a transaction-scoped
  advisory lock (not the Organization row, which ticket creation also locks).
- Customer edits and organization renames lock the row before reading it, so each audit entry's
  `from` is the value the previous edit left.
- Transactions aborted by a deadlock or serialization failure (P2034), or by a foreign key
  raced by a concurrent delete (P2003), are re-run from scratch up to three times
  (`apps/api/src/lib/transactions.ts`). This is a safety net; the lock order is the mechanism.
- Requests that change nothing write nothing: no timeline events, no audit entries.

Case-insensitive uniqueness of team and tag names is enforced twice: by the API (serialized
as above, for a friendly 409) and by the database, through unique indexes on
`("organizationId", lower("name"))` (migration `20261026000000_case_insensitive_team_tag_names`),
which also covers writes that bypass the API. The API maps a violation of either index to 409.

### Layer 4 — Tests that try to break it

Every tenant-scoped API endpoint gets an integration test that seeds **two**
organizations and checks that a user in org A:

- gets `404` when reading, updating or deleting org B's resources by ID;
- never sees org B's rows in list endpoints;
- cannot reference org B's IDs in request bodies (e.g. assign a ticket to org B's agent);
- receives no Socket.IO events for org B's rooms.

### Future layer — PostgreSQL Row-Level Security (deferred)

RLS policies (`USING (organization_id = current_setting('app.org_id')::uuid)`)
would make isolation hold even for hand-written SQL. They require every request
to run in a transaction that sets `app.org_id` with `SET LOCAL`. That needs a
Prisma extension and careful connection-pool handling. It's scheduled after the
core modules exist so it can be added and benchmarked in isolation.

### Other isolation rules

- **Real-time:** room names are derived server-side (`org:{organizationId}`,
  `ticket:{ticketId}`). Joining a ticket room requires the same policy check as reading the ticket.
- **Jobs:** every job payload includes `organizationId`. Processors re-load data
  through tenant-scoped repositories rather than trusting payload contents.
- **Caching / rate-limit keys:** prefixed with `organizationId` where they are tenant data.
- **Logs:** include `organizationId` for traceability. Never log message bodies or customer PII at `info` level.

## 3. Conventions

- Primary keys: UUID v4 generated by the Prisma client (`@default(uuid())` — there is no
  database-side default, so raw SQL inserts must supply IDs), stored as `uuid`.
  Ticket **numbers** are separate and per-org, for humans.
- All timestamps `timestamptz`, UTC. `createdAt` on every table, `updatedAt` on mutable ones.
- Naming: Prisma defaults (PascalCase tables, camelCase columns). Raw SQL must quote identifiers.
- Ticket numbers are allocated by `UPDATE "Organization" SET "ticketSequence" = "ticketSequence" + 1 … RETURNING`
  inside the ticket-creation transaction. The row lock serializes allocation per org.
- Migrations are generated by `prisma migrate dev`, reviewed, and committed. They are never edited after merging.
  Constraints Prisma can't express (partial unique index for default SLA policy,
  `CHECK` constraints) are added as hand-written SQL in the migration.

## 4. Schema changes in Phase 2

The Phase 1 draft moved to `packages/db` with these deliberate changes:

| Change                                                                                                                          | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generator `prisma-client-js` → `prisma-client`, output `packages/db/src/generated/prisma` (git-ignored, regenerated on install) | Prisma 7's TypeScript-first generator, used with the `@prisma/adapter-pg` driver adapter that Prisma 7 requires.                                                                                                                                                                                                                                                                                                                                                                   |
| Composite tenant FKs `onDelete: Restrict` → `NoAction` (Ticket → Customer / assignee / Team / SlaPolicy, Message → Customer)    | PostgreSQL checks `RESTRICT` immediately, row by row, so deleting an Organization could fail midway through its own cascade (a customer is removed while a ticket still references it). `NO ACTION` is checked when the cascaded delete of the referenced row completes, so same-depth references (Ticket → Customer) pass, while deleting a still-referenced row directly is rejected. Message → Customer needed one more step (next row). Both behaviors have integration tests. |
| Message → Customer FK made `DEFERRABLE INITIALLY DEFERRED` (migration `20261018000000_defer_message_customer_fk`)               | Messages are two cascade levels below Organization (via Ticket), Customers one. `NO ACTION` on Message → Customer was checked when the customer delete finished, before the deeper Ticket → Message cascade had run, so every organization delete (and every seed re-run) failed. The first CI run against real PostgreSQL exposed it. Deferring the check to commit lets the cascade finish; a direct delete of a customer who authored messages is still rejected, at commit.    |
| Hand-written SQL appended to the initial migration                                                                              | Constraints Prisma's schema language cannot express (below).                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Constraints outside `schema.prisma`

| Constraint                                                                                                                | Purpose                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SlaPolicy_one_default_per_org_key` — partial unique index on `("organizationId") WHERE "isDefault"`                      | At most one default SLA policy per organization.                                                |
| `Team_organizationId_lower_name_key`, `Tag_organizationId_lower_name_key` — unique on `("organizationId", lower("name"))` | Team and tag names are unique per organization regardless of case (migration `20261026000000`). |
| `Organization_ticketSequence_check`, `Ticket_number_check`                                                                | Ticket numbering stays positive.                                                                |
| `SlaTarget_minutes_check`                                                                                                 | First response > 0 and resolution ≥ first response.                                             |
| `Message_author_check`                                                                                                    | Author columns match `authorType` (a CUSTOMER message has a customer and no user, and so on).   |
| `Message_organizationId_authorCustomerId_fkey` — `DEFERRABLE INITIALLY DEFERRED`                                          | Checked at commit so organization cascades complete (see §4).                                   |

Added for SLA automation (migration `20261027000000_sla_breach_markers_and_auto_close`):

| Constraint                                                                                                                                                              | Purpose                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TicketEvent_one_sla_breach_per_ticket_key` — partial unique index on `("ticketId", "type") WHERE "type" IN ('SLA_FIRST_RESPONSE_BREACHED', 'SLA_RESOLUTION_BREACHED')` | At most one breach event per ticket and target, so a repeated or concurrent sweep can't record a breach twice.                 |
| `TicketEvent_system_actor_check`                                                                                                                                        | A `SYSTEM` event has no `actorUserId`.                                                                                         |
| `Organization_autoCloseAfterMinutes_check`                                                                                                                              | Auto-close delay between 1 minute and 1 year.                                                                                  |
| `Ticket_first_response_breach_sweep_idx` — partial index on `("firstResponseDueAt")`                                                                                    | Tickets with a first-response due date, no breach recorded, and no reply or a late one. The sweep query repeats the predicate. |
| `Ticket_resolution_breach_sweep_idx` — partial index on `("resolutionDueAt")`                                                                                           | Tickets with a resolution due date, no breach recorded, and unsolved or solved late.                                           |
| `Ticket_auto_close_sweep_idx` — partial index on `("solvedAt") WHERE "status" = 'SOLVED'`                                                                               | Solved tickets, oldest solve first.                                                                                            |

Prisma does not model these objects. When generating a future migration with
`pnpm db:migrate`, review the SQL and remove any statement that would drop them. (Prisma 7.10
can express partial indexes behind the `partialIndexes` preview feature; it is not enabled, so
these stay hand-written like the others. Expression indexes such as `lower("name")` can't be
expressed at all.)
