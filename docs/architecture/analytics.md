# Analytics

`/analytics` is PulseDesk's historical view: trends and reporting over a chosen range of
days. The [dashboard](./dashboard.md) answers "how are we doing right now?"; analytics answers
"how did we do over time?". Both read PostgreSQL at request time. Nothing is pre-aggregated,
and nothing on either page is sample data.

Analytics reads history that PulseDesk already stores, so it needs no new tables:

- `Ticket` timestamps: `createdAt`, `firstRespondedAt`, `solvedAt`, `closedAt`, and the breach
  timestamps, which are never cleared;
- the append-only `TicketEvent` timeline: every status change made through the API writes a
  `STATUS_CHANGED {from, to}` event with its actor;
- `Message` rows: author, visibility and time.

## Endpoint

`GET /api/v1/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA zone>`

- **Authentication:** session cookie (as every `/api/v1` route).
- **Authorization:** `analytics:read-own`, which every role has; the scope depends on
  `analytics:read-all` (see below).
- **Caching:** `Cache-Control: no-store` (all API responses).

### Query parameters

Validated by `analyticsQuerySchema` (`packages/shared/src/analytics.ts`). The object is
strict: unknown parameters (for example an `organizationId`) are rejected with `400`, not
ignored.

| Parameter | Meaning                                          | Default             |
| --------- | ------------------------------------------------ | ------------------- |
| `from`    | First day of the range, inclusive (`YYYY-MM-DD`) | 29 days before `to` |
| `to`      | Last day of the range, inclusive                 | Today in `tz`       |
| `tz`      | IANA time zone the days are cut in               | `UTC`               |

Rules (`400 VALIDATION_FAILED` with `errors[].path` such as `query.to`):

- dates must be real calendar days, `2000-01-01` or later;
- `from` must not be after `to`;
- the range is at most **366 days**;
- `to` must not be after today in `tz`, judged by the API's clock;
- `tz` must be a time zone the runtime knows; each parameter appears at most once.

### Buckets

Ranges up to **92 days** get one bucket per day; longer ones get one per 7 days, counted from
`from`, with the last bucket possibly shorter. A year therefore has at most 53 buckets.

Bucket boundaries are local midnights in `tz`, computed by the API in TypeScript
(`startOfDayIn`; DST-aware, and a skipped midnight starts the day at the first local time
that exists). They are sent to PostgreSQL as one sorted `timestamp(3)[]` and applied with
`width_bucket`, so the database never needs that zone's rules. Every bucket is
`[start, next start)`: its first instant is included and the next bucket's first instant is
not. Buckets with no rows are real zeros, not gaps.

### Response

`analyticsReportResponseSchema` (shared), parsed by the web client:

```jsonc
{
  "scope": "organization", // or "own"
  "generatedAt": "2026-11-07T18:00:00.000Z",
  "range": {
    "from": "2026-10-09", "to": "2026-11-07", "timeZone": "America/Chicago",
    "granularity": "day", // or "week"
    "startsAt": "2026-10-09T05:00:00.000Z", "endsAt": "2026-11-08T06:00:00.000Z"
  },
  "buckets": [{
    "start": "2026-10-09", "end": "2026-10-09",
    "created": 4, "solved": 3, "reopened": 0,
    "firstResponse": { "count": 2, "averageSeconds": 1830 },   // null average when count is 0
    "resolution": { "count": 3, "averageSeconds": 50400 },
    "firstResponseBreaches": 0, "resolutionBreaches": 1
  }],
  "totals": { "created": 61, "solved": 55, "reopened": 4 },
  "createdByCurrentStatus": { "OPEN": 6, "PENDING": 2, "ON_HOLD": 1, "SOLVED": 20, "CLOSED": 32 },
  "responseTimes": {
    "firstResponse": { "count": 58, "averageSeconds": 2410, "medianSeconds": 1500 },
    "resolution": { "count": 51, "averageSeconds": 61200, "medianSeconds": 43200 }
  },
  "sla": {
    "firstResponse": { "met": 54, "breached": 4 },
    "resolution": { "met": 47, "breached": 6 },
    "byPriority": [{ "priority": "LOW", "firstResponse": { "met": 9, "breached": 0 }, "resolution": { … } }, …]
  },
  "agents": [{
    "userId": "…", "name": "Priya Agent", "role": "AGENT",
    "solved": 21, "publicReplies": 64,
    "firstResponses": { "count": 19, "averageSeconds": 1720 }
  }]
}
```

"No data" is always `null` (an average or median over zero items), never `0`. The schema
enforces it: `averageSeconds`/`medianSeconds` are `null` exactly when `count` is `0`.
Compliance percentages aren't sent; the page computes met ÷ (met + breached) and shows "—"
when nothing was decided.

## Authorization and scope

| Role         | Permission           | `scope`        | Ticket metrics cover                   | Activity covers                  |
| ------------ | -------------------- | -------------- | -------------------------------------- | -------------------------------- |
| Owner, Admin | `analytics:read-all` | `organization` | Every ticket in the organization       | Every member                     |
| Agent        | `analytics:read-own` | `own`          | Tickets **currently** assigned to them | Their own actions, on any ticket |

This is the rule that `packages/shared/src/roles.ts` already defined ("own stats only"), and the same
scope rule as the dashboard. "Ticket metrics" are created, solved and reopened counts, status,
response times and SLA outcomes. "Activity" is the agent table. An agent's activity row counts
everything they did, because an agent can read every ticket anyway (`ticket:read`); the
privacy line is other members' statistics, which agents never receive.

## Metric definitions

All times are calendar time (business hours aren't implemented). Durations come from stored
timestamps, rounded to the millisecond, as seconds.

| Metric                        | Definition                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Created**                   | Tickets whose `createdAt` is in the bucket.                                                                                                                                                                                                                                                                                                                  |
| **Solved**                    | `STATUS_CHANGED` events with `to = SOLVED` in the bucket: solve _actions_. A ticket solved, reopened and solved again counts twice.                                                                                                                                                                                                                          |
| **Reopened**                  | `STATUS_CHANGED` events from `SOLVED` to an active status (`OPEN`, `PENDING`, `ON_HOLD`). Auto-close (`SOLVED → CLOSED`) is neither.                                                                                                                                                                                                                         |
| **Where new tickets are now** | Tickets created in the range, by their **current** status. Past statuses aren't stored as snapshots, so this isn't "status at the time".                                                                                                                                                                                                                     |
| **First response time**       | `firstRespondedAt − createdAt`, counted in the bucket of `firstRespondedAt` (the first public agent reply; notes never count). Average per bucket; average and median over the range. The same rule as the dashboard.                                                                                                                                        |
| **Resolution time**           | `solvedAt − createdAt` for tickets now `SOLVED` or `CLOSED`, counted in the bucket of `solvedAt` (the latest solve; reopening clears it). The same rule as the dashboard, so the last 30 days match its 30-day average.                                                                                                                                      |
| **SLA outcome**               | Each target's final state as `evaluateSla` decides it, dated when it was decided: a recorded breach → breached at `*BreachedAt`; otherwise, once the clock stopped (first reply; solve, or close without a solve), met if at or before the due date, else breached, at that moment. Targets still running, and tickets without that target, have no outcome. |
| **SLA compliance**            | Met ÷ (met + breached) for outcomes decided in the range, per target and per **current** priority. Breaches are also counted per bucket.                                                                                                                                                                                                                     |
| **Agent: solved**             | Solve events whose actor is that member (`actorType = USER`). System changes are never anyone's.                                                                                                                                                                                                                                                             |
| **Agent: public replies**     | `Message` rows with `authorType = AGENT`, `visibility = PUBLIC`, written by that member in the range.                                                                                                                                                                                                                                                        |
| **Agent: first replies**      | Tickets whose first public reply that member wrote, with the average wait. The author is the public agent message whose `createdAt` equals the ticket's `firstRespondedAt`: the reply endpoint writes both with the same timestamp, under the ticket's row lock.                                                                                             |

Data-quality guards: a duration only counts when its end is inside the range, not in the
future, and not before the ticket was created.

## Query strategy

`apps/api/src/modules/analytics/`: routes → controller (`parseRequest('query', …)`) → service
(scope, defaults, "not after today", bucket bounds, assembly) → repository.

The repository runs one `REPEATABLE READ, READ ONLY` transaction. Every statement in it reads
the same snapshot. It makes **eight statements per request**, whatever the range or the number
of members or tickets, so there is no N+1:

| #   | Statement                                                                                    | Index used                                                                                                              |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Created per bucket (`width_bucket`, `GROUP BY`)                                              | `Ticket (organizationId, createdAt)`                                                                                    |
| 2   | Solves and reopens per bucket                                                                | `TicketEvent (organizationId, type, createdAt)`                                                                         |
| 3   | First-response durations, `GROUP BY ROLLUP` (per bucket and total; `avg`, `percentile_cont`) | organization prefix                                                                                                     |
| 4   | Resolution durations, same shape                                                             | organization prefix                                                                                                     |
| 5   | Created tickets by current status (Prisma `groupBy`, tenant-guarded)                         | `Ticket (organizationId, createdAt)`                                                                                    |
| 6   | SLA outcomes per target × priority × outcome × bucket                                        | organization prefix                                                                                                     |
| 7   | Activity per member (`UNION ALL` of solves, public replies, first replies via `DISTINCT ON`) | `TicketEvent (organizationId, type, createdAt)`, `Message (organizationId, createdAt)`, `Message (ticketId, createdAt)` |
| 8   | Members, for names and roles (Prisma, tenant-guarded)                                        | `Membership (organizationId, userId)`                                                                                   |

`firstRespondedAt`, `solvedAt` and the breach timestamps have no index of their own, so 3, 4
and 6 read the organization's tickets through an index on `organizationId`. That's fine at
current volumes. If an organization grows large enough for it to matter, the smallest fix is a
migration adding `(organizationId, firstRespondedAt)` and `(organizationId, solvedAt)`
indexes. M4 adds **no** migration.

## Tenant isolation

- The organization comes only from the session (`tenantOf(req)`); the query string can't name
  one (unknown parameters are rejected).
- The tenant guard can't see raw SQL, so raw statements filter tickets through one fragment,
  `ticketScope()`, and events and messages through `activityScope()`. Both always include the
  `organizationId`. Joins between tickets, events and messages match on
  `(organizationId, id)`, the same composite keys the database enforces.
- Prisma statements (5, 8) also go through the tenant guard.
- The integration suite checks that one organization's tickets, events, replies and members
  never appear in another's report, and that agents never receive other members' statistics.

## Frontend

`apps/web/src/features/analytics/`:

- `range.ts`: presets (7, 30, 90 days, 12 months), the viewer's time zone (`Intl`, falling back
  to UTC), the range in the URL (`?from=…&to=…`, so a view can be shared or bookmarked) and its
  validation. An invalid range in the URL falls back to the default.
- `api.ts`: `useAnalyticsReport`, a TanStack Query hook validated against the shared schema.
  The previous report stays on screen, dimmed and marked "Updating…", while another range
  loads. The query key includes the organization ID, and the query is dropped on every session
  or organization change.
- `analytics-charts.tsx`: `ColumnChart`, built from CSS and design tokens with no chart
  library.
  - One y-axis per chart. Response and resolution times are separate charts because their
    scales differ (minutes vs days).
  - Two series use `chart-1`/`chart-2`. That pair passed the color-vision-deficiency
    separation check in both themes; a legend and a Table view are secondary encodings.
  - Every bucket has a spoken label and a tooltip. **Table** lists exact values and is the
    keyboard route through the data.
- `analytics-page.tsx`: the page. It shows summary tiles (created, solved with reopens, and
  median first-response and resolution times with their averages), the charts, SLA performance
  (compliance per target, a met/breached bar with icon labels, and a per-priority table), where
  new tickets are now, the agent table, and a "How these numbers are calculated" section.

| State                  | What the user sees                                                               |
| ---------------------- | -------------------------------------------------------------------------------- |
| Initial load           | Skeleton cards and a polite status message; never zeros                          |
| Changing the range     | The previous figures stay, dimmed, with "Updating…"                              |
| Nothing in the range   | "No activity in this period" (wording for the `own` scope too); the filter stays |
| Invalid custom range   | An inline message under the date fields; no request is sent                      |
| Load failed            | Error state with **Try again**                                                   |
| Session expired (401)  | "Your session has ended", **Sign in again**                                      |
| Forbidden (403)        | "Analytics unavailable", no retry                                                |
| No data for an average | "—", announced as "No data"                                                      |

## Known limitations

- **Dev seed history.** `pnpm db:seed` creates solved tickets with `solvedAt` but writes no
  `STATUS_CHANGED` events, so seeded solves appear in resolution time but not in the "Solved"
  count. Real usage through the API always writes the events. The smallest fix would be for
  the seed to write the events the API would have written; M4 doesn't change the seed.
- **Current, not historical, attributes.** Priority in the SLA breakdown, the status of created
  tickets and the `own` scope's ticket filter (current assignee) use today's values. Assignment
  and priority history exist as events, but replaying them is out of scope.
- **Former members** aren't listed in the agent table; their past actions still count in the
  totals.
- **Calendar time only**, no business hours or SLA pausing (as everywhere in PulseDesk).
- **Unindexed timestamp filters** (see Query strategy). Fine at current volumes.
- **Dark-mode chart color.** In dark mode `chart-2` sits just above the validator's preferred
  lightness band (L 0.74). Contrast and color-vision separation pass. Changing the token would
  also restyle the dashboard, so it was left as is.

## Tests

| Where                                                | What                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/analytics.test.ts`              | Calendar dates, time zones (DST start and end, +5:30, +14, a skipped midnight), buckets (daily/weekly switch, 366 days), query validation, response contract ("no data" is null)                                                                                                                                  |
| `apps/api/test/analytics.test.ts`                    | Service without a database: scope rule, range defaults and "after today", bucket bounds, dense buckets and totals, idle members, no average without data                                                                                                                                                          |
| `apps/api/test/integration/analytics.int.test.ts`    | Real PostgreSQL: 401, owner/admin/agent scopes, 8 invalid queries → 400, tenant isolation, empty organization, local-day bucketing (Berlin), boundaries, solves and reopens from events, first-response and resolution averages and medians with invalid data, SLA outcomes, activity attribution, weekly buckets |
| `apps/web/src/features/analytics/analytics.test.tsx` | Request (range, time zone), every figure from the API, table view, loading, empty, own scope, presets via URL, custom range validation, invalid URL range, error and retry, 401, 403                                                                                                                              |
| `e2e/tests/analytics.spec.ts`                        | A fresh organization: quiet, then exact figures from history built through the real API; presets and table view; API rejects hints and future ranges; axe in light and dark; no CSP violations; phone and tablet with the 12-month range                                                                          |
