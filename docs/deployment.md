# Deployment

> **Status (2026-10-22):** the repository is prepared for this deployment.
>
> - **Done:** the Neon PostgreSQL production database exists, and its first two migrations
>   (`20261015000000_init`, `20261018000000_defer_message_customer_fk`) have been applied.
> - **Pending (last known status, 2026-10-28):** `20261026000000_case_insensitive_team_tag_names`
>   and `20261027000000_sla_breach_markers_and_auto_close` haven't been applied to Neon. Apply
>   them with Step 2 before the API that needs them starts. Check `migrate:status` rather than
>   relying on this note.
> - **Not done:** the Render service and the Vercel project haven't been created, and
>   nothing has been deployed. Steps 3 and 4 and everything under "Verify after deploying"
>   are still for an operator to do.

## Architecture

```
Browser ──HTTPS──▶ Vercel (static SPA + reverse proxy) ──HTTPS + secret header──▶ Render (one Node API instance) ──TLS──▶ Neon PostgreSQL
                    │                                                              │
                    ├─ /assets/*, /index.html … served from apps/web/dist          └─ GET /health public (Render's health check)
                    └─ /api/*, /health, /health/ready proxied to Render                everything else requires the secret header
```

- **One origin for the browser.** The browser only ever talks to the Vercel domain. Vercel
  forwards `/api/*`, `/health` and `/health/ready` to Render. That keeps the `__Host-`
  session cookie first-party, lets `SameSite=Lax` work, and avoids credentialed CORS
  (overview D6).
- **The API only answers the proxy.** Vercel adds `X-PulseDesk-Proxy-Secret` to every
  proxied request. The API rejects any request without the correct value with a generic
  `403`, except `GET /health`. So the public `*.onrender.com` hostname can't be used to
  bypass Vercel.
- **Exactly one API instance.** Rate limits use an in-memory store, so they only hold with a
  single instance until the Redis store lands (overview D12).

## Configuration in the repository

### `apps/web/vercel.json`

| Key           | What it does                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes[0]`   | Matches `^/(api(?:/.*)?\|health\|health/ready)$` and proxies it to `${PULSEDESK_API_ORIGIN}/$1`. A `request.headers` **`set`** transform writes `x-pulsedesk-proxy-secret: ${PROXY_SHARED_SECRET}`. `x-vercel-enable-rewrite-caching: 0` opts the route out of CDN caching. |
| `rewrites`    | SPA fallback: every other path that isn't a static file → `/index.html` (unchanged).                                                                                                                                                                                        |
| `headers`     | Immutable caching for hashed `/assets/*`, plus `nosniff`, `DENY` framing, a referrer policy and a permissions policy on the static/SPA responses (unchanged).                                                                                                               |
| build install | `npx --yes pnpm@11.21.0 install --frozen-lockfile` / `run build` → `dist/` (unchanged).                                                                                                                                                                                     |

Why `routes` and not `rewrites`: Vercel's `rewrites` can't modify request headers. Their
`transforms` accept only `request.path`. Header transforms exist only on `routes`. Vercel
supports mixing `routes` with `rewrites`/`headers`. User `routes` are evaluated **first**,
then `headers`, then the filesystem, then `rewrites`. So API paths never reach the SPA
fallback, and static assets and the SPA keep their previous behaviour. Both values are
expanded **at request time** from the project's environment variables (the `env` arrays),
so neither the Render hostname nor the secret is in Git.

How this was checked (no Vercel account was used): the file validates against
`https://openapi.vercel.sh/vercel.json`. It was compiled with Vercel's
`@vercel/routing-utils` 6.6.0 (`getTransformedRoutes`, the same merge the platform performs),
and the expected order was confirmed: proxy route → header routes → filesystem → SPA fallback.
A negative control (a header transform on `rewrites`) fails validation. That is a static
check. Only a real deployment proves the behaviour, which is why the verification section
below exists.

### Proxy secret enforcement (API)

- `PROXY_SHARED_SECRET` is **required when `NODE_ENV=production`**. The API refuses to start
  without it. It must be ≥ 32 characters of `[A-Za-z0-9_-]` and different from
  `SESSION_SECRET`. The character rule also rejects an unexpanded `$PROXY_SHARED_SECRET`,
  which is what Vercel forwards if the variable is missing (it leaves unknown `$VAR`s
  literal).
- `apps/api/src/http/middleware/proxy-secret.ts` hashes the supplied and expected values with
  SHA-256 and compares them with `crypto.timingSafeEqual`. A missing, wrong, truncated,
  extended or duplicated header gets `403 {"code":"FORBIDDEN","title":"Forbidden"}`. The
  response has no detail and doesn't name the header.
- Middleware order (`apps/api/src/app.ts`): request ID → security headers →
  `Cache-Control: no-store` → **`GET /health` (public)** → **proxy secret check** → CORS →
  global rate limit → `/health/ready` → CSRF origin check → JSON body → `/api/v1` routes → 404. Everything after the check is covered, including readiness, CORS preflight, every
  feature route and unknown paths. `test/proxy-secret.test.ts` walks the real router's route
  table so a new route can't be missed.
- Direct requests are rejected **before** the rate limiter, so traffic that bypasses Vercel
  can't spend real visitors' rate-limit budgets.
- The header is redacted from logs (`[REDACTED]`), whether its value is right or wrong.
  Every API response, including 403s and 404s, is `Cache-Control: no-store`. Vercel's CDN
  honours upstream `Cache-Control` on external rewrites for projects created after
  2026-04-06.
- **Development and tests:** when `PROXY_SHARED_SECRET` is unset, the check isn't mounted.
  That is only possible outside production, where the env schema requires the secret. If
  you set it locally, the Vite dev/preview proxy sends it (Node side only). The E2E suite
  runs with enforcement **on**.
- The secret is never a `VITE_*` variable, so it can't reach the browser bundle.

### Retries and cold starts (web)

`apps/web/src/lib/retry.ts` is the QueryClient default for **queries** (GETs, e.g.
session restoration and `/health`):

- **Retried:** network failures, `502`/`503`/`504` (from a gateway or the API's own
  database-outage `503`), and a non-JSON `2xx` page served where the API should be (a host
  interstitial).
- **Never retried:** `400`, `401` (= signed out), `403` (including a missing proxy
  secret), `404`, `409`, `429`, `500`, validation errors, contract mismatches, and
  cancelled requests.
- **Schedule:** up to 6 retries. Each wait is between half and all of
  `min(15 s, 1 s × 2ⁿ)` (exponential backoff with jitter). That is at most 45 s of waiting
  on top of the requests themselves.
- **Cancellation:** retries stop when the query is cancelled or its component unmounts
  (TanStack Query aborts the request's `AbortSignal`). Every component asking for the
  session shares one in-flight request.
- **Mutations are never retried** (sign-up, sign-in, sign-out, organization switch). A
  repeated sign-in could double-count against the rate limit. If one fails with a gateway
  error, the form says _"PulseDesk is starting up or briefly unavailable"_ and the user
  submits again.
- **UI:**
  - While retrying, the app shows _"Connecting to PulseDesk… The server may be starting up
    after a period of inactivity. This can take up to a minute."_ as a polite live region.
    It appears on the session screen and the sign-in page, and the sidebar shows
    _Reconnecting…_.
  - When the browser is offline, the app says so and waits for the connection to return.
  - After the retries are used up, it shows _"PulseDesk isn't responding"_ with a **Try
    again** button.
  - _"The PulseDesk API is unreachable / no API connected"_ appears only for a permanent
    answer: a non-API 404 on a deployment with no API attached.

## Before you start: secrets

Generate **independent** values. Never reuse one value for two purposes, and never reuse
development or test values. Run this once per secret, on your own machine:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Secret                | Stored in                                                           |
| --------------------- | ------------------------------------------------------------------- |
| `SESSION_SECRET`      | Render only                                                         |
| `PROXY_SHARED_SECRET` | Render **and** Vercel (same value in both, nowhere else)            |
| `DATABASE_URL`        | Render only (plus your shell, temporarily, when you run migrations) |

Paste them directly into the provider dashboards. Don't put them in `.env`, `.env.example`,
`vercel.json`, the README, commit messages, issue trackers or chat. Don't prefix any of
them with `VITE_`.

## Step 1: Neon PostgreSQL

> **Done.** The production database exists. These steps are kept for reference, e.g. if
> the database ever has to be recreated. You still need its **pooled** string for Render's
> `DATABASE_URL` (Step 3).

1. Create a Neon project and database (PostgreSQL 15+), in a region close to the Render
   region you'll choose.
2. Use a dedicated role for the application. Never point production at a development or
   test database.
3. Copy two connection strings, both with `sslmode=require`:
   - the **pooled** string, for the API's `DATABASE_URL` on Render;
   - the **direct (non-pooled)** string, for running migrations. Neon recommends direct
     connections for schema migrations.

## Step 2: Apply migrations (before each release that changes the schema)

> **Check before every release.** Run `migrate:status` against Neon: it lists what is pending.
> At the last check, two migrations were pending (`20261026000000_case_insensitive_team_tag_names`,
> `20261027000000_sla_breach_markers_and_auto_close`). Apply pending migrations with this step
> before the API version that needs them starts.

From a trusted machine with this repository checked out at the commit being released:

```sh
# bash
export DATABASE_URL='<Neon direct connection string>'
pnpm --filter @pulsedesk/db run migrate:status   # confirm it names the Neon host and lists pending migrations
pnpm db:deploy                                    # prisma migrate deploy: applies pending migrations only
unset DATABASE_URL
```

```powershell
# PowerShell
$env:DATABASE_URL = '<Neon direct connection string>'
pnpm --filter @pulsedesk/db run migrate:status
pnpm db:deploy
Remove-Item Env:DATABASE_URL
```

A `DATABASE_URL` set in the shell wins over the one in your local `.env`. Check the host
that `migrate:status` prints before running `db:deploy`. Apply migrations **before** the new
API version starts, and keep migrations backwards-compatible with the running version
(add first, remove later).

**Release order** when a release changes the schema or the API's responses:

1. Apply the migrations (this step).
2. Deploy the API on Render (Step 3) and wait until `curl -i "$API/health"` returns `200`
   (with the new `APP_VERSION`, if you set one). `/health` is liveness only and doesn't touch
   the database. `$API/health/ready` always answers `403`: only Vercel's proxy adds the secret.
   - **Later releases:** the Vercel deployment that is already live proxies to the new API, so
     check `curl -i "$WEB/health/ready"` now. It must return `200 {"status":"ready",…}` before
     you deploy the web app; a `503` means the API can't reach the database, so stop and fix it.
   - **First release:** there is no Vercel deployment yet, so the database can't be checked
     through the proxy before the web app exists. Go on to step 3, then check
     `$WEB/health/ready` straight away, and treat a `503` as a failed release.

   Don't call `$API/health/ready` with the secret yourself: it would put the secret in your
   shell history.

3. Deploy the web app on Vercel. It validates API responses strictly, so a web build that
   expects new fields (e.g. the SLA breach markers and event `actorType`) can't load ticket
   pages from an older API. Its deployment also carries the proxy (`apps/web/vercel.json`), so
   on a first release this is the first point where `$WEB/health/ready` can be checked.

If Render's Auto-Deploy is on, or Vercel builds every push, one push starts both at once:
deploy such releases by hand, in this order.

> **Never run any of these against production:** `pnpm db:seed`, `pnpm db:migrate` /
> `prisma migrate dev`, `prisma migrate reset`, `prisma db push`, `pnpm test:integration`,
> `pnpm test:e2e`. The integration suite **wipes** whatever `TEST_DATABASE_URL` points at,
> and E2E signs up throwaway users, so never set `TEST_DATABASE_URL` to a production
> string. The seed refuses `NODE_ENV=production`, but don't rely on that guard.

## Step 3: Render web service (the API)

Create a **Web Service** from `faiza-ijaz0/pulse-desk`, runtime **Node**, one instance.

| Setting           | Value                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Root Directory    | _(empty: the repository root)_                                                                                                  |
| Build Command     | `NODE_ENV=development npx --yes pnpm@11.21.0 install --frozen-lockfile && npx --yes pnpm@11.21.0 --filter @pulsedesk/api build` |
| Start Command     | `node apps/api/dist/server.js`                                                                                                  |
| Health Check Path | `/health`                                                                                                                       |
| Auto-Deploy       | Your choice. If on, remember migrations (step 2) must already be applied.                                                       |

Why the build command looks like that:

- `NODE_ENV=development` applies to the install step only, so pnpm installs the
  devDependencies the build needs (`tsx`, `esbuild`) even though the service's
  `NODE_ENV` is `production`.
- The install runs `prisma generate` (the `packages/db` postinstall). The build bundles the
  API and workspace packages into `apps/api/dist/server.js`. Third-party packages stay
  external and resolve from the installed `node_modules`.

Use `/health` for the health check, **not** `/health/ready`. Liveness doesn't touch the
database, so a Neon hiccup doesn't make Render restart a healthy process. `/health/ready`
requires the proxy secret anyway.

### Render environment variables

| Variable                       | Value                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                     | `production`                                                                                                                                                                                                                                |
| `NODE_VERSION`                 | `24` (matches `.nvmrc` and `engines`)                                                                                                                                                                                                       |
| `DATABASE_URL`                 | Neon **pooled** connection string (secret)                                                                                                                                                                                                  |
| `SESSION_SECRET`               | Generated value (secret). Rotating it signs everyone out.                                                                                                                                                                                   |
| `SESSION_COOKIE_NAME`          | `__Host-pd_sid` (required in production)                                                                                                                                                                                                    |
| `SESSION_COOKIE_SECURE`        | `true` (required in production)                                                                                                                                                                                                             |
| `WEB_ORIGIN`                   | The exact public origin of the Vercel site, e.g. `https://<project>.vercel.app` or your custom domain, with no path or trailing slash. Comma-separate several.                                                                              |
| `TRUST_PROXY_HOPS`             | `2` **provisionally** (Vercel's proxy + Render's load balancer). It is an assumption, not a verified value: measure it after deploying (see below).                                                                                         |
| `PROXY_SHARED_SECRET`          | Generated value (secret). Identical to the Vercel value.                                                                                                                                                                                    |
| `API_HOST`                     | `0.0.0.0`                                                                                                                                                                                                                                   |
| `API_PORT`                     | `10000`, or whatever `PORT` Render assigns. The API reads `API_PORT`, not `PORT`.                                                                                                                                                           |
| `LOG_LEVEL`                    | `info`                                                                                                                                                                                                                                      |
| `APP_VERSION`                  | Optional: the release tag or commit SHA (shown by `/health`).                                                                                                                                                                               |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | Optional. Default **`300`**: requests per minute per client IP, for every request that passes the proxy-secret check (`GET /health` is exempt). Positive integer. Per-IP only if `TRUST_PROXY_HOPS` is right.                               |
| `SHUTDOWN_TIMEOUT_MS`          | Optional. Default **`10000`** (10 s): on `SIGTERM`/`SIGINT` (e.g. a Render redeploy or restart), how long in-flight requests get to finish before the process exits anyway. Positive integer. Keep it below Render's shutdown grace period. |

`SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_DAYS` and
`RATE_LIMIT_AUTH_PER_15_MINUTES` are also optional; their defaults are in `.env.example`. The API validates every variable at startup and
exits with a list of problems if any rule fails. It never prints the values.

`TRUST_PROXY_HOPS` decides which `X-Forwarded-For` entry becomes the client IP for rate
limiting and audit logs. Vercel sends the visitor's IP to the origin. Render's load
balancer is one more hop.

- If the value is **too low**, every visitor looks like a Vercel egress IP and shares one
  rate limit.
- If it is **too high**, a client-supplied `X-Forwarded-For` could choose its own IP.

Requests that skip Vercel never reach the rate limiter (they get the 403 first). The
rate-limit check in "Verify" below tells you which case you're in.

> **`TRUST_PROXY_HOPS=2` is provisional.** Render's documentation says its load balancer
> terminates TLS, but doesn't describe what it adds to `X-Forwarded-For`. The real number of
> proxies hasn't been observed. Until it has been measured on the deployed chain, don't rely
> on per-client-IP rate limiting or on client IPs in logs.
>
> **To measure it:**
>
> 1. From a machine whose public IP you know, send one request through Vercel:
>    `curl -i "$WEB/api/v1/auth/session" -H 'X-Request-Id: hops-check-1'`.
> 2. In Render's logs, find the `request completed` line with `"requestId":"hops-check-1"`
>    and read `req.headers["x-forwarded-for"]`. If no line has that ID (the proxy may not
>    pass it through), match on the time and `GET /api/v1/auth/session` instead.
> 3. Set `TRUST_PROXY_HOPS` to the number of addresses to the **right** of your IP in that
>    list, plus 1 (for the load balancer's own connection). Saving the variable restarts the
>    service.
> 4. Repeat with `-H 'X-Forwarded-For: 203.0.113.9'` added. If that address appears in the
>    chain, the count from the right must still land on your IP, not on `203.0.113.9`.
> 5. Confirm with the rate-limit check in "Verify after deploying" (step 6).

## Step 4: Vercel project (the frontend and proxy)

Import `faiza-ijaz0/pulse-desk` (**Add New → Project**):

| Setting                                                    | Value                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Framework Preset                                           | Vite                                                                          |
| Root Directory                                             | `apps/web`                                                                    |
| Include files outside the root directory in the Build Step | **Enabled** (the default). `@pulsedesk/shared` and the root lockfile need it. |
| Build / Output / Install Command                           | Leave **un-overridden**; `vercel.json` sets them                              |
| Node.js Version                                            | 24.x                                                                          |
| Production Branch                                          | `main`                                                                        |

Environment variables (**Settings → Environment Variables**), both server-side:

| Variable               | Value                                                                                                        | Environments |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------ |
| `PULSEDESK_API_ORIGIN` | The Render service origin, e.g. `https://<service>.onrender.com`: `https://`, no path, **no trailing slash** | Production   |
| `PROXY_SHARED_SECRET`  | The same generated value as on Render. Mark it **Sensitive**.                                                | Production   |

- **Set both before the first production deployment, and redeploy after changing either
  one.**
  - If `PULSEDESK_API_ORIGIN` is missing, the proxy destination stays a literal
    `${PULSEDESK_API_ORIGIN}/…` and API calls fail.
  - If `PROXY_SHARED_SECRET` is missing, the header is the literal text
    `${PROXY_SHARED_SECRET}`, which the API rejects with 403.
  - Either way, the result fails closed.
- Neither variable starts with `VITE_`, so Vite never inlines them. The web build reads no
  environment variables into the bundle.
- **Preview deployments:** leave both variables unset for Preview unless previews should
  use the production API. If they do, also add each preview origin to `WEB_ORIGIN`, or
  every sign-in from a preview fails the CSRF check (`CSRF_ORIGIN_MISMATCH`).

The cookie is set by the API's response but stored for the Vercel domain, because that's
the origin the browser requested. `__Host-` requires exactly that: HTTPS, no `Domain`,
`Path=/`.

## Rotating `PROXY_SHARED_SECRET`

The API accepts one value at a time, so a rotation has a short window of `403`s. Do it at a
quiet time:

1. Generate the new value.
2. Update it on Vercel. That takes effect on the next deployment, so don't redeploy yet.
3. Update it on Render. The service restarts, and requests from the current Vercel
   deployment are rejected from that moment.
4. Immediately redeploy Vercel (**Deployments → Redeploy** the current production
   deployment).
5. Run the `/api/v1/auth/session` checks from "Verify" below.

## Free-tier limitations

- **Render (free web service):**
  - It spins down after 15 minutes without inbound traffic. The next request wakes it,
    which takes about a minute.
  - Free instance hours are capped per workspace each month. When they run out, free
    services are suspended until the next month.
  - Free services can be restarted at any time, have an ephemeral filesystem, and can't
    scale beyond one instance. One instance is what this app needs for now.
  - Render's docs don't say whether a request that arrives during spin-up is held until
    the service is up or answered with an error/loading page. The web app handles both:
    it retries gateway errors and non-JSON interstitials. Vercel waits up to 120 seconds
    for an external origin before answering `502`.
- **Neon (free plan):** idle compute is suspended, so the first query after a pause is
  slower. Storage and compute are capped. Check the current limits on Neon's pricing
  page.
- **Vercel (Hobby plan):** for personal, non-commercial projects. Check Vercel's current
  terms and limits before relying on it.
- A **cold start** on the first visit after idling therefore shows _"Connecting to
  PulseDesk…"_ for up to about a minute. If the API still hasn't answered after the
  retries (≈ 45 s of waiting plus request time), the app shows _"PulseDesk isn't
  responding"_ with **Try again**. Sign-in forms submitted during a cold start may fail
  once with _"starting up or briefly unavailable"_. They are not resubmitted
  automatically.

## Verify after deploying

Replace `$WEB` with the Vercel origin and `$API` with the Render origin. Run the commands in
a shell where neither secret is set. None of these steps needs the secret.

**1. Direct access to Render is refused (except liveness):**

```sh
curl -i "$API/health"                       # 200, JSON {"status":"ok",...}, Cache-Control: no-store
curl -i "$API/health/ready"                 # 403 {"code":"FORBIDDEN",...}
curl -i "$API/api/v1/auth/session"          # 403 FORBIDDEN (not 401: it never reached the API routes)
curl -i -X POST "$API/api/v1/auth/login" -H 'Origin: '"$WEB" -H 'Content-Type: application/json' -d '{}'   # 403
curl -i "$API/api/v1/auth/session" -H 'x-pulsedesk-proxy-secret: guessed-value'                             # 403
```

**2. Through Vercel, the secret is injected and client copies are overwritten:**

```sh
curl -i "$WEB/health"                       # 200 JSON from the API (not Vercel's 404 or the SPA HTML)
curl -i "$WEB/health/ready"                 # 200 {"status":"ready","checks":{"database":"ok"}}; 503 = database unreachable
curl -i "$WEB/api/v1/auth/session"          # 401 UNAUTHENTICATED, proving the proxy secret was accepted
curl -i "$WEB/api/v1/auth/session" -H 'x-pulsedesk-proxy-secret: wrong'   # still 401: Vercel replaced the client's header
```

> **The decisive check: `GET $WEB/api/v1/auth/session` with no cookie must return `401`,
> not `403`.**
>
> - **`401 UNAUTHENTICATED`:** the request got past the proxy-secret check and reached the
>   API's routes. Vercel is forwarding the correct `PROXY_SHARED_SECRET`.
> - **`403 FORBIDDEN`:** the API rejected the proxy secret. The Vercel value is missing,
>   wasn't expanded (it then arrives as the literal text `${PROXY_SHARED_SECRET}`), or
>   differs from Render's. Fix the variable on Vercel and redeploy.
>   - If the value is identical on both sides and you still get `403`, re-add the Vercel
>     variable without the **Sensitive** flag and redeploy. Vercel doesn't document whether
>     request-time route expansion can read Sensitive variables.
> - `GET $WEB/health` returning `200` proves **nothing** about the secret: `/health` is
>   public and never checks it.

Check that these responses have `cache-control: no-store` and that `x-vercel-cache` is never
`HIT`. Check that none of them contains `x-pulsedesk-proxy-secret` or the secret's value.

**3. The secret isn't in the frontend.** Open the site, view the page source and the
loaded JavaScript (**DevTools → Sources**), and search for `proxy-secret` and for the first
few characters of the secret: no matches. In **Network**, the browser's own requests
carry no such header. Vercel adds it after the request leaves the browser.

**4. Sign-up, sign-in, session restore, sign-out:**

1. Sign up at `$WEB/signup`. You land on the dashboard.
2. In **DevTools → Application → Cookies**, `__Host-pd_sid` is `HttpOnly`, `Secure`,
   `SameSite=Lax`, `Path=/`, with no `Domain`.
3. Reload. The session is restored without signing in again.
4. Sign out. You return to `/login`, the cookie is gone, and
   `fetch('/api/v1/auth/session').then(r => r.status)` in the console returns `401`.
5. Sign in again with the same account.

**5. Tenant isolation.** Sign up two accounts with two organizations, A and B, in two
browser profiles. Signed in as B, run in the console:

```js
await fetch('/api/v1/auth/active-organization', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ organizationId: '<organization A id>' }),
}).then((r) => r.status); // 404 NOT_FOUND, exactly like an organization that doesn't exist
```

Then check that `GET /api/v1/members` for B lists only B's members. Get organization A's id
from A's `GET /api/v1/auth/session` response.

**6. Rate limiting is per visitor.**

1. Sign in with a wrong password repeatedly. After `RATE_LIMIT_AUTH_PER_15_MINUTES`
   failures (default 10) you get _"Too many attempts"_ (`429`).
2. From a different network (e.g. a phone off Wi-Fi), signing in still works.
   - If the other network is limited too, `TRUST_PROXY_HOPS` is too low: everyone shares
     Vercel's IP.
   - If adding `-H 'X-Forwarded-For: 203.0.113.9'` to a curl through `$WEB` resets your
     budget, it is too high.

**7. CSRF:**

```sh
curl -i -X POST "$WEB/api/v1/auth/login" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"x"}'   # 403 CSRF_ORIGIN_MISMATCH
curl -i -X POST "$WEB/api/v1/auth/login" -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"x"}'                                  # 403 CSRF_ORIGIN_MISMATCH (no Origin)
```

**8. Cold start.** Leave the site idle for 20+ minutes, so Render spins down, then open
`$WEB/dashboard` while signed in.

- Expected: _"Connecting to PulseDesk…"_, then the dashboard, without a sign-in prompt.
- In **Network**, note what `/api/v1/auth/session` returned while the service was
  starting: a slow `200`, `502`/`503`/`504`, or an HTML page. A slow `200` (the request was
  held) is the best case.
- If the API answered with something else that isn't retried, record it and adjust
  `isTransientApiError` in `apps/web/src/lib/retry.ts`.

**9. Logs.** In Render's logs, request lines show `"x-pulsedesk-proxy-secret":"[REDACTED]"`
and `"cookie":"[REDACTED]"`, never the values.

## What was verified locally

The following was run on a development machine. It is not a deployment.

- Format, lint and typecheck.
- Unit/component tests, including proxy-secret enforcement over every registered route,
  and retry/backoff with fake timers.
- Integration tests against local PostgreSQL.
- The Playwright E2E suite, with the API enforcing a proxy secret that only the
  `vite preview` proxy sent.
- Production builds, plus a check that the secret isn't in `apps/web/dist`.
- Static validation of `vercel.json`, described above.
- Manual `curl` checks against a locally running production build of the API.

Separately, the Neon production database was created and its first two migrations were
applied (`migrate status` was up to date at the time). Later migrations are applied per
release (Step 2). The Render service and the Vercel deployment still
have to be created from the dashboards and verified with the steps above.
