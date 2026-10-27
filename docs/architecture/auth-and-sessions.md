# Authentication and Session Security

> Status: **implemented in Phase 3**: registration, login, logout, session restoration,
> organization switching, tenant context and RBAC enforcement. Not yet built: "log out other
> devices", password change/reset, invitations, the expired-session cleanup job (needs
> BullMQ) and Socket.IO auth (§7). Endpoints and the decisions made while implementing are in
> [§10](#10-implementation-phase-3).

## 1. Approach

PulseDesk uses **opaque, server-managed sessions** stored in PostgreSQL. The browser
holds a random token in an **HttpOnly cookie**. No JWTs, and no tokens in `localStorage`.

Why: sessions can be revoked instantly (logout, password change, member removal),
JavaScript (and therefore XSS) cannot read the token, and the server keeps one
auditable record of active logins.

## 2. Credentials

| Item             | Decision                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Password hashing | **Argon2id** via `@node-rs/argon2` (prebuilt binaries, no node-gyp). Parameters follow OWASP minimums (m=19 MiB, t=2, p=1) and are revisited on hardware changes. Hashes are self-describing, so parameters can be upgraded on next login. |
| Password policy  | Minimum 12 characters, maximum 128 (bounds hashing cost). No composition rules. Reject the account's own email.                                                                                                                            |
| Email            | Normalized (trim + lower-case) before storage and lookup.                                                                                                                                                                                  |
| Enumeration      | Login failure returns one generic `INVALID_CREDENTIALS` error. When the user doesn't exist, the server still runs a dummy Argon2 verify so response timing doesn't reveal it.                                                              |

## 3. Session lifecycle

```
POST /api/v1/auth/login  { email, password }
  1. Rate-limit check (per IP and per email)
  2. Verify password (Argon2id)
  3. token = randomBytes(32) → base64url        (256 bits of entropy)
  4. INSERT Session { tokenHash: HMAC-SHA-256(SESSION_SECRET, token),
                      userId, activeOrganizationId, expiresAt = now + absolute TTL,
                      ipAddress, userAgent }
  5. Set-Cookie: <name>=<token>; HttpOnly; Secure; SameSite=Lax; Path=/
  6. 200 { user, organizations, activeOrganization }
```

**On every request**, the session middleware:

1. Reads the cookie, computes `HMAC(SESSION_SECRET, token)` and looks up `tokenHash`.
2. Rejects if missing, `revokedAt` set, `now > expiresAt`, or
   `now - lastSeenAt > idle timeout`.
3. Touches `lastSeenAt` **at most once per minute** to avoid a write on every request.
4. Loads the membership for `activeOrganizationId` and builds `TenantContext`.

| Property         | Value                         | Configured by                   |
| ---------------- | ----------------------------- | ------------------------------- |
| Idle timeout     | 12 hours (default)            | `SESSION_IDLE_TIMEOUT_MINUTES`  |
| Absolute timeout | 14 days (default)             | `SESSION_ABSOLUTE_TIMEOUT_DAYS` |
| Cookie `Max-Age` | Equal to the absolute timeout | derived                         |

Why HMAC instead of a plain hash: a database-only leak (backup, SQL injection) yields
neither usable tokens nor anything that can be checked offline without the server secret.

### Revocation events

| Event                   | Effect                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Logout                  | Current session `revokedAt = now`; cookie cleared                                                                                |
| "Log out other devices" | All of the user's other sessions revoked                                                                                         |
| Password change / reset | All sessions revoked, then a fresh session issued                                                                                |
| Member removed from org | Sessions with that `activeOrganizationId` lose access on the next request (membership check). The user's other orgs stay usable. |
| Expired sessions        | Deleted by a daily BullMQ cleanup job                                                                                            |

### Session fixation

A new token is always generated on login and on privilege-relevant changes
(password change, switching active organization). A pre-existing cookie is never upgraded.

## 4. Cookie configuration

| Attribute  | Production                                               | Local dev (`http://localhost`)     |
| ---------- | -------------------------------------------------------- | ---------------------------------- |
| Name       | `__Host-pd_sid` (forces `Secure`, `Path=/`, no `Domain`) | `pd_sid`                           |
| `HttpOnly` | ✅                                                       | ✅                                 |
| `Secure`   | ✅                                                       | ❌ (`SESSION_COOKIE_SECURE=false`) |
| `SameSite` | `Lax`                                                    | `Lax`                              |
| `Path`     | `/`                                                      | `/`                                |
| `Domain`   | not set (host-only)                                      | not set                            |

At startup, config validation **refuses to boot** with `NODE_ENV=production` if
`SESSION_COOKIE_SECURE` is false or `SESSION_SECRET` is the placeholder or shorter than 32 characters.

## 5. CSRF protection

Cookie authentication needs CSRF defense. PulseDesk layers three:

1. **`SameSite=Lax`** — browsers don't send the cookie on cross-site sub-requests (form POSTs, fetches).
2. **Origin verification** — for every non-safe method (`POST`, `PUT`, `PATCH`, `DELETE`),
   the `Origin` header (falling back to `Referer`) must be in the `WEB_ORIGIN` allowlist.
   Otherwise the response is `403 CSRF_ORIGIN_MISMATCH`.
3. **JSON-only API** — mutating endpoints require `Content-Type: application/json`.
   Plain HTML forms can't send that cross-site without a CORS preflight, which the API doesn't grant.

`GET`/`HEAD`/`OPTIONS` handlers must never change state.

## 6. Authorization (RBAC)

| Permission (examples)                   | OWNER |      ADMIN      |       AGENT       |
| --------------------------------------- | :---: | :-------------: | :---------------: |
| View / reply to tickets                 |  ✅   |       ✅        |        ✅         |
| Assign tickets to others                |  ✅   |       ✅        | ✅ (configurable) |
| Manage teams, tags, SLA policies        |  ✅   |       ✅        |        ❌         |
| Invite / remove members, change roles   |  ✅   | ✅ (not owners) |        ❌         |
| View analytics                          |  ✅   |       ✅        |  Own stats only   |
| Delete organization, transfer ownership |  ✅   |       ❌        |        ❌         |

- The role-to-permission map lives in `@pulsedesk/shared`. The web app uses it to hide
  controls, and the API uses it to enforce them.
- Route middleware `requirePermission('member:invite')` checks coarse access. Policy
  functions (`tickets.policy.ts`) check resource-level rules inside services.
- An organization must always have at least one `OWNER`. This is enforced in the service layer inside a transaction.
- Role changes and member removals are written to `AuditLog`.

**Write endpoints (as implemented, Phase 4D).** Every one requires a session, the trusted
`Origin` (CSRF), and a membership in the active organization that is re-read on each request,
so a removal or demotion applies to the very next request.

| Endpoint                                                             | Permission                                           | Roles                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| `PATCH /organization`                                                | `organization:update`                                | Owner, Admin                          |
| `PATCH /members/:userId`, `DELETE /members/:userId`                  | `member:change-role`, `member:remove`                | Owner, Admin (owners only for owners) |
| `POST /tickets`, `PATCH /tickets/:number`, `POST …/messages`         | `ticket:reply` (+ `ticket:assign` for assignee/team) | All                                   |
| `PATCH /customers/:customerId`                                       | `customer:update`                                    | All                                   |
| `POST/PATCH/DELETE /teams…`, `PUT/DELETE /teams/:id/members/:userId` | `team:manage`                                        | Owner, Admin                          |
| `POST/PATCH/DELETE /tags…`                                           | `tag:manage`                                         | Owner, Admin                          |

A refused request (403) is identical whether or not the named resource exists, and an ID from
another organization gets the same 404 as one that never existed. This table is enforced by
`apps/api/test/integration/authorization.int.test.ts`, which fails if a write route is added
without being listed there.

## 7. Socket.IO authentication

- The handshake request carries the same session cookie (same origin).
  `io.use()` middleware validates it using the same code path as HTTP.
- The handshake `Origin` must be in the allowlist (Socket.IO's `cors`/`allowRequest`).
- On connect, the server joins the socket to `user:{userId}` and `org:{organizationId}`.
  Clients _request_ `ticket:{id}` rooms, and the server joins them only after a policy check.
- On logout or session revocation, the server disconnects that session's sockets
  (it tracks socket IDs per session ID in Redis).

## 8. Abuse protection

| Control                           | Setting                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Login / password-reset rate limit | `RATE_LIMIT_AUTH_PER_15_MINUTES` per IP **and** per email (Redis store)      |
| Global API rate limit             | `RATE_LIMIT_GLOBAL_PER_MINUTE` per IP                                        |
| Body size limit                   | `express.json({ limit: '100kb' })`                                           |
| Proxy awareness                   | `trust proxy` set from `TRUST_PROXY_HOPS` so the real client IP is used      |
| Headers                           | `helmet` defaults + `Cache-Control: no-store` on authenticated API responses |

## 9. Out of scope for v1 (tracked for later)

- Email verification and password-reset emails (they need an SMTP setup; the plan is a dev mail catcher, no paid service)
- MFA (TOTP)
- SSO (OIDC/SAML)
- Customer portal logins (customers are contacts, not users, in v1)

## 10. Implementation (Phase 3)

### Endpoints

All under `/api/v1`, JSON only, errors as RFC 9457 problem documents. Mutating requests need an
allowlisted `Origin` (§5). The organization is never in a URL: it is the session's active one.

| Method & path                    | Requires                      | Purpose                                                                                                                                             |
| -------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`            | —                             | Creates user, organization, `OWNER` membership, audit entry and session in **one transaction**; `201` with the session body and cookie.             |
| `POST /auth/login`               | —                             | `200` session body and a new cookie. Wrong password and unknown email both give `401 INVALID_CREDENTIALS` (a dummy Argon2 verify equalizes timing). |
| `POST /auth/logout`              | —                             | Revokes the current session (if any) and clears the cookie. Always `204`; idempotent.                                                               |
| `GET /auth/session`              | session                       | Current user, their organizations and the active one. `401` when signed out.                                                                        |
| `POST /auth/active-organization` | session                       | `{ organizationId }`: checks membership (`404` if none), then **rotates** the session token, keeping the original absolute expiry.                  |
| `GET /organization`              | membership                    | The active organization.                                                                                                                            |
| `PATCH /organization`            | `organization:update`         | Rename (audited as `organization.updated`).                                                                                                         |
| `GET /members`                   | `member:read`                 | Members of the active organization.                                                                                                                 |
| `PATCH /members/:userId`         | `member:change-role` + policy | Change a role (audited). Admins can't touch owners or grant ownership. `409 LAST_OWNER` if it would leave no owner.                                 |
| `DELETE /members/:userId`        | `member:remove` + policy      | Remove a member: unassigns their tickets, cascades team memberships, audited. `409 LAST_OWNER` likewise.                                            |

A `:userId` from another organization returns `404 NOT_FOUND`, identical to a non-existent ID.

### Code map (`apps/api/src`)

| Piece                                                               | Where                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Token generation, HMAC, shape check                                 | `modules/auth/session-token.ts`                                                      |
| Argon2id hashing, rehash check, dummy verify                        | `modules/auth/password.ts`                                                           |
| Cookie read / set / clear                                           | `modules/auth/session-cookie.ts`                                                     |
| Session lifecycle and tenant resolution                             | `modules/auth/auth.service.ts` (framework-agnostic; queries in `auth.repository.ts`) |
| `authenticate`, `requireAuth`, `requireTenant`, `requirePermission` | `http/middleware/authenticate.ts`                                                    |
| Auth rate limits                                                    | `http/middleware/rate-limit.ts`                                                      |
| Per-request `AuthContext` / `TenantContext`                         | `http/auth-context.ts` (a `WeakMap` keyed by request; no Express type augmentation)  |
| Composition of every `/api/v1` module                               | `api-router.ts`                                                                      |

### Decisions and deviations from the original design

| Topic                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paths                    | `/api/v1/auth/*` (per conventions.md), not `/api/auth/*`. The session endpoint is `GET /api/v1/auth/session`.                                                                                                                                                                                                                                                                                                                                                                                        |
| Duplicate registration   | `409 EMAIL_TAKEN`. Without email verification (out of scope, §9), sign-up can't hide whether an email is registered without breaking the flow, so probing through sign-up is bounded by the per-IP registration rate limit instead. Two simultaneous sign-ups are settled by the unique index; the loser also gets `409`.                                                                                                                                                                            |
| Removed from active org  | The session stays valid. Tenant-scoped routes return `403 NO_ACTIVE_ORGANIZATION` and `GET /auth/session` reports `activeOrganization: null`, so the user can pick another organization. Nothing is written on these `GET`s, and the server never silently falls back to another organization mid-request.                                                                                                                                                                                           |
| Initial active org       | On login, the user's oldest membership.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Login with an old cookie | The old session is revoked before the new one is issued (session fixation).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Invalid cookie           | The request continues unauthenticated and the response clears the cookie.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Owner invariant          | Role changes and removals run in a transaction holding `SELECT … FOR UPDATE` on the organization row, so concurrent demotions can't leave zero owners.                                                                                                                                                                                                                                                                                                                                               |
| Rate limits              | Login: failed attempts per IP **and** per email (successes don't count). Registration: every attempt per IP. In-memory store (overview D12) until Redis arrives, so limits are per instance.                                                                                                                                                                                                                                                                                                         |
| Production config        | The API refuses to start in production unless `SESSION_COOKIE_SECURE=true`, the cookie name starts with `__Host-`, `SESSION_SECRET` isn't the placeholder, and every `WEB_ORIGIN` is `https://`. The placeholder secret is accepted only in development.                                                                                                                                                                                                                                             |
| Database outages         | Prisma connection/credential errors (`P1000`, `P1001`, `P1002`, `P1003`, `P1008`, `P1017`, `P2024`) become `503 SERVICE_UNAVAILABLE` with `Retry-After: 30`, logged as `Database unavailable` with the `errorCode` and request ID. Other unexpected errors stay a generic `500` whose log line also carries an `errorCode`. The web app shows "temporarily unavailable" for 503, "couldn't reach PulseDesk" when no API answers, field errors for 400s, and a reference ID only for unexpected 500s. |
| Schema                   | No migration was needed: the Phase 2 `Session`, `Membership` and `AuditLog` models already had every column.                                                                                                                                                                                                                                                                                                                                                                                         |
