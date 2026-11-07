# Live Dashboard

> Status: **implemented.** `/dashboard` shows live metrics read from PostgreSQL on every
> request. It replaced the earlier design preview and its sample data. History and trends
> are on the separate analytics page ([analytics.md](./analytics.md)).

## Endpoint

`GET /api/v1/dashboard` takes no parameters. The organization and the scope come from the
session, never from the request. Query strings and headers such as `?organizationId=` or
`X-Organization-Id` are ignored, as on every other tenant route.

| Layer      | File                                                 | Responsibility                                              |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| Route      | `apps/api/src/modules/dashboard/dashboard.routes.ts` | `requireTenant` + `requirePermission('analytics:read-own')` |
| Controller | `dashboard.controller.ts`                            | Passes `tenantOf(req)` to the service; no request input     |
| Service    | `dashboard.service.ts`                               | Scope rule, 30-day window, totals, `null` for "no data"     |
| Repository | `dashboard.repository.ts`                            | One read-only snapshot transaction (queries below)          |
| Contract   | `packages/shared/src/dashboard.ts`                   | `dashboardSummaryResponseSchema`, also used by the web app  |

### Response

```jsonc
{
  "scope": "organization", // or "own"
  "generatedAt": "2026-11-04T12:00:00.000Z", // the API clock's "now" for every figure
  "tickets": {
    "byStatus": { "OPEN": 7, "PENDING": 2, "ON_HOLD": 1, "SOLVED": 4, "CLOSED": 9 },
    "active": 10,
    "awaitingFirstResponse": 3,
    "unassigned": 2, // null in the "own" scope
  },
  "sla": {
    "active": {
      "none": 1,
      "met": 0,
      "on_track": 5,
      "at_risk": 2,
      "first_response_breached": 1,
      "resolution_breached": 1,
    },
    "attention": [
      {
        "number": 41,
        "subject": "…",
        "priority": "URGENT",
        "status": "resolution_breached",
        "target": "resolution",
        "dueAt": "…",
      },
    ], // at most 5
  },
  "responseTimes": {
    "windowDays": 30,
    "windowStart": "2026-10-05T12:00:00.000Z",
    "firstResponse": { "count": 12, "averageSeconds": 2700 },
    "resolution": { "count": 1, "averageSeconds": 93600 }, // averageSeconds is null when count is 0
  },
  "agents": [
    {
      "userId": "…",
      "name": "…",
      "role": "AGENT",
      "active": 6,
      "open": 4,
      "pending": 1,
      "onHold": 1,
      "atRisk": 2,
      "breached": 1,
    },
  ],
}
```

Errors follow the usual problem+json conventions: `401 UNAUTHENTICATED` without a session
and `403 FORBIDDEN` for a role without `analytics:read-own` (no current role lacks it).
Responses are `Cache-Control: no-store`, like every API response.

## Authorization and scope

The rule is the one the RBAC table always planned for analytics
([auth-and-sessions.md](./auth-and-sessions.md#6-authorization-rbac)), using the existing
permissions in `packages/shared/src/roles.ts`:

| Role  | Permission           | Scope          | Covers                                                          |
| ----- | -------------------- | -------------- | --------------------------------------------------------------- |
| Owner | `analytics:read-all` | `organization` | Every ticket in the organization; every member in `agents`      |
| Admin | `analytics:read-all` | `organization` | Same as owners                                                  |
| Agent | `analytics:read-own` | `own`          | Only tickets **currently assigned** to them; only their own row |

The route makes the coarse check (`analytics:read-own`, which every role holds), and the service
applies the scope (`dashboardScope(role)`), following the project's
"route permission + service policy" convention. In the `own` scope, `unassigned` is `null`,
because unassigned tickets aren't the agent's. Agents can still see every ticket in the inbox
(`ticket:read`); the dashboard's scope applies to its aggregates only.

## Metric definitions

"Active" always means `OPEN`, `PENDING` or `ON_HOLD` (`ACTIVE_TICKET_STATUSES`), the statuses
whose resolution clock is running. All times are calendar time (no business hours), and "now"
is the API's clock (`generatedAt`).

| Metric                                     | Definition                                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tickets by status** (`tickets.byStatus`) | Every ticket in scope by its current status, all time.                                                                                                                                                                                                    |
| **Active** (`tickets.active`)              | `OPEN` + `PENDING` + `ON_HOLD`.                                                                                                                                                                                                                           |
| **Awaiting first response**                | Active tickets with `firstRespondedAt IS NULL`: no public agent reply yet (internal notes never set it). It is exactly the running first-response SLA clock. Pending tickets are included, because the clock doesn't pause.                               |
| **Unassigned**                             | Active tickets with no assignee (`organization` scope only).                                                                                                                                                                                              |
| **SLA health** (`sla.active`)              | Every active ticket by its **overall** SLA state at `generatedAt`, the same classification as the inbox badges (`evaluateSla` in `packages/shared/src/sla.ts`). The six counts always add up to `tickets.active`.                                         |
| **Needs attention** (`sla.attention`)      | Up to 5 active tickets that are breached or at risk. Breaches come first (most overdue first), then at-risk tickets (soonest due first). `target` is the breached target, or for an at-risk ticket the at-risk target due first; `dueAt` is its due date. |
| **Avg. first response**                    | Mean of `firstRespondedAt − createdAt` over tickets whose first public reply was sent in the last 30 days (`windowStart ≤ firstRespondedAt ≤ now`). `count` is the sample size; `averageSeconds` is `null` (never `0`) when there is none.                |
| **Avg. resolution time**                   | Mean of `solvedAt − createdAt` over tickets that are now `SOLVED` or `CLOSED` and were solved in the last 30 days. A reopened ticket has no `solvedAt` until solved again, so it counts from its latest solve. Closing keeps `solvedAt`.                  |
| **Workload by agent** (`agents`)           | Every member (also those with no tickets), with their active tickets in total and per active status, plus how many are at risk and breached (either target). Busiest first, then by name.                                                                 |

Data that can't form a real duration is left out of the averages: an end time before
`createdAt`, or one after `now`. Such rows can only come from direct database edits.

## Query strategy

`dashboard.repository.ts` reads one consistent snapshot: a `REPEATABLE READ`, `READ ONLY`
transaction with five statements, regardless of how many members or tickets there are (no N+1):

1. **Status counts:** Prisma `groupBy` on `status` (tenant-guarded), using the
   `(organizationId, status, priority)` index; in the `own` scope,
   `(organizationId, assigneeUserId, status)`.
2. **Workload:** one aggregate over the organization's active tickets, `GROUP BY "assigneeUserId"`,
   with `count(*) FILTER (…)` for each status and SLA state. The totals (`active`, awaiting,
   unassigned, SLA counts) are sums of these rows.
3. **Attention:** the same SQL classification, ordered and `LIMIT 5`.
4. **Response times:** one aggregate, `avg(EXTRACT(EPOCH FROM …)) FILTER (…)`, over tickets
   answered or solved since `windowStart`.
5. **Members:** Prisma `findMany` (tenant-guarded) for names and roles.

**SLA classification in SQL.** Statements 2 and 3 classify tickets with a `CASE` that mirrors
`evaluateTarget`/`overallStatus` branch for branch:

- a recorded breach first;
- then a missing due date (`none`);
- then a stopped clock (`met` at or before the due date);
- then past due (`breached` one millisecond after it);
- then at risk once no more than `SLA_AT_RISK_REMAINING_FRACTION` (25 %) of the window from
  creation to the due date is left.

`now` is bound through `utcTimestamp()` (`apps/api/src/lib/sql-time.ts`), the same helper the
breach sweep uses. The columns are `timestamp(3)` and `EXTRACT(EPOCH …)` is exact numeric, so
boundaries match the JavaScript to the millisecond. An integration test checks the SQL against
`evaluateSla` ticket by ticket, at every boundary.

**Cost.** Statements 1–3 read the organization's active tickets through the status index.
Statement 4 scans the organization's tickets via the `organizationId` prefix of its indexes,
because no index covers `firstRespondedAt`/`solvedAt`. That is fine at help-desk scale. If it
ever shows up in query timings, the fix is two partial indexes on
`("organizationId", "firstRespondedAt")` and `("organizationId", "solvedAt")`, added by a
migration; no code change is needed.

## Tenant isolation

- `organizationId` comes only from the session (`TenantContext`); the endpoint reads no
  request input.
- Raw SQL bypasses the Prisma tenant guard, so every raw statement is built on one `scope()`
  fragment (`t."organizationId" = $1`, plus the assignee in the `own` scope). No raw
  statement exists without it. The Prisma statements are tenant-guarded as usual.
- Integration tests:
  - check that another organization's tickets, subjects and members never appear;
  - check that organization hints in the query string and headers are ignored;
  - run with the tenant guard on.

## Frontend

`apps/web/src/features/dashboard/`:

- `api.ts`: `useDashboardSummary`, a TanStack Query hook validated against the shared schema.
  It refetches every 60 s in the background, and its key includes the organization ID. It is
  dropped on every session or organization change.
- `dashboard-page.tsx`: the page and its states.
- `dashboard-widgets.tsx`: the cards.
- `format.ts`: durations, rounded down, and safe percentages.

| State                    | What the user sees                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Initial load             | Skeleton cards and a polite status message; never zeros                                                          |
| Background refresh       | The current figures stay; the Refresh button shows progress                                                      |
| Refresh failed           | The last figures stay, with a warning that names their time                                                      |
| First load failed        | Error state with **Try again** (and a support reference for unexpected errors)                                   |
| Session expired (401)    | "Your session has ended", **Sign in again** → re-reads the session → sign-in page                                |
| Forbidden (403)          | "Dashboard unavailable" for the role, no retry                                                                   |
| No tickets               | Empty state: "No tickets yet" (or "No tickets assigned to you yet" in the `own` scope), with a link to the inbox |
| No assigned tickets      | Workload card says so; the unassigned count stays visible                                                        |
| No replies or solves yet | The average shows "—" (announced as "No data") with "No first replies in the last 30 days"                       |

A "How these numbers are calculated" disclosure on the page repeats the definitions above in
plain language.

Each workload row and the unassigned count link to the inbox filtered to that assignee **and**
the active statuses (`?status=OPEN,PENDING,ON_HOLD&assignee=…`), so the list a user lands on
matches the number they clicked. The inbox has no default status filter, so a bare
`?assignee=` link would also show solved and closed tickets.

## Known limitations

- **No history or trends.** Every figure is "now" (or a trailing 30-day average); no deltas or
  sparklines are shown here. Trends live on the analytics page ([analytics.md](./analytics.md)),
  computed from ticket timestamps and the `TicketEvent` timeline.
- **Calendar time only.** Business-hours calendars and SLA pausing aren't implemented, so neither
  the SLA states nor the averages account for them.
- **The `own` scope follows the current assignee.** `firstRespondedAt` doesn't record who replied,
  so an agent's averages cover the tickets assigned to them now, not the replies they wrote.
- **Averages, not medians.** One very slow ticket moves the mean. Percentiles would be a small
  extension (`percentile_cont`) if wanted.
- **Up to 60 seconds stale.** The page refreshes on a timer, not in real time (real-time updates
  are planned).

## Tests

| Suite                                             | Covers                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/dashboard.test.ts`           | Contract: empty organization, `null` average ⇔ `count` 0, no negatives, scope values, attention limit and states                                                                                                                                                                    |
| `apps/api/test/dashboard.test.ts`                 | Service with an in-memory repository: scope per role, the window, totals from per-assignee rows, idle members, `own` scope, no average without data                                                                                                                                 |
| `apps/api/test/integration/dashboard.int.test.ts` | Real PostgreSQL: 401, owner/admin/agent scopes (allow and deny), tenant isolation and ignored hints, empty organization, every status, SLA classification = `evaluateSla` at every boundary, attention order and target, both averages with excluded edge cases, agent distribution |
| `apps/web/src/features/dashboard/*.test.ts(x)`    | Renders every figure from the API, no sample content, loading skeleton without zeros, empty organization, no assigned tickets, missing averages, own scope, API error and retry, failed refresh, expired session → sign-in, 403; duration formatting                                |
| `e2e/tests/dashboard.spec.ts`                     | A fresh organization: empty state, then exact counts from real tickets; axe scans with live data in light and dark; no CSP violations; no horizontal scroll at 375 px                                                                                                               |

Run them with `pnpm test`, `pnpm test:integration` (resets the local `pulsedesk_test` database)
and `pnpm build && pnpm test:e2e`; see [testing.md](../testing.md).
