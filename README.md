# Coworking Bookings

A booking API for shared spaces (meeting rooms, desks) built to be correct under concurrency: **two people can never hold the same resource for overlapping times**, no matter how many requests arrive at once.

**Stack:** Node.js · TypeScript · Fastify · PostgreSQL · Zod · JWT

## The problem

The naive way to book a slot is "check if it's free, then insert":

```
SELECT ... WHERE overlaps   →  free!      ┐
                                          ├─ both requests see "free"
SELECT ... WHERE overlaps   →  free!      ┘
INSERT  →  OK
INSERT  →  OK               ← overbooking
```

Any check done in application code has a window between the read and the write. Under load, two requests fit in that window and both win.

## How this project solves it

### 1. The database is the only arbiter

There is no availability check before inserting. PostgreSQL enforces the rule itself with an exclusion constraint:

```sql
CONSTRAINT no_overlapping_active_bookings EXCLUDE USING gist (
    resource_id   WITH =,
    booking_range WITH &&
) WHERE (status IN ('HELD', 'CONFIRMED'))
```

It means: for the same `resource_id`, no two active bookings may have overlapping (`&&`) time ranges. The check is atomic, so it cannot be raced. A losing request gets error `23P01`, which the API returns as `409 Conflict`.

Ranges are always half-open `[start, end)`, so 10:00–11:00 and 11:00–12:00 don't collide.

### 2. Holds that expire

A booking starts as `HELD` for 10 minutes and must be confirmed in that time. The constraint can't use `now()` (index predicates must be immutable), so a stale hold would block the slot forever. To handle that, the booking transaction first marks expired holds on the requested slot as `EXPIRED`, then inserts. No cron job is needed for correctness.

```
HELD ──confirm──▶ CONFIRMED
  │                   │
  ├──cancel──▶ CANCELLED ◀──cancel──┘
  └──(10 min)──▶ EXPIRED
```

### 3. A deadlock found by the tests

The concurrency test fires 50 simultaneous requests for the same slot and expects exactly 1 success and 49 `409`s. It failed intermittently: still 1 winner, but the 49 losers got **deadlock errors (`40P01`)** after up to **49 seconds**, which the client would see as `500`s.

Reproduced in plain SQL:

```
run 0:   153 ms  { ok: 1, '23P01': 49 }   ← expected
run 1: 49401 ms  { ok: 1, '40P01': 49 }   ← deadlocks
```

**Why:** an exclusion constraint checks for conflicts *after* inserting the new row. Two concurrent inserts each find the other's uncommitted row and wait for the other to finish. That is a cycle, so PostgreSQL aborts one of them after `deadlock_timeout` (1 s), and the chain of 49 waiters adds up to 49 s.

**Fix:** writers for the same resource are queued with a row lock at the start of the transaction:

```sql
SELECT 1 FROM resources WHERE id = $1 FOR NO KEY UPDATE
```

The constraint still guarantees integrity; the lock only puts contenders in line so the loser fails cleanly with `409`. Result: **10/10 runs pass at ~0.5 s**. The trade-off is that bookings for the *same* resource at *different* times also wait their turn, which is negligible at coworking scale.

**Lesson:** the constraint alone guaranteed correctness, but not a good experience under contention. Only a concurrency test against a real database showed the difference.

## API

Everything except `/auth/*` requires `Authorization: Bearer <token>`. There are two roles: **member** (default) and **admin**.

| Method | Path | Who | Body / query | Responses |
|---|---|---|---|---|
| `POST` | `/auth/register` | anyone | `{ email, password }` | `201` user · `400` · `409` email taken |
| `POST` | `/auth/login` | anyone | `{ email, password }` | `200 { token }` · `401` |
| `GET` | `/resources` | member | — | active resources (admins also see inactive) |
| `POST` | `/resources` | admin | `{ name }` | `201` · `403` |
| `PATCH` | `/resources/:id` | admin | `{ name?, isActive? }` | `200` · `403` · `404` |
| `GET` | `/resources/:id/availability` | member | `?from&to` (≤ 31 days) | busy `[{ start, end }]` · `404` inactive/missing |
| `POST` | `/bookings` | member | `{ resourceId, start, end }` (ISO 8601 with offset) | `201` hold · `400` · `404` · `409` slot taken |
| `GET` | `/bookings` | member | `?scope=mine` (default) or `all` (admin) | newest 200 · `403` |
| `POST` | `/bookings/:id/confirm` | owner | — | `200` · `404` · `409` not an active hold |
| `POST` | `/bookings/:id/cancel` | owner or admin | — | `200` · `404` · `409` not active |

Permission decisions:
- **The role is read from the database on every admin request, not from the JWT.** Demoting an admin takes effect immediately instead of when their token expires (tested).
- **Availability returns only time ranges**, never who booked, so members can't see each other's schedules.
- **Resources are deactivated, never deleted**, because bookings reference them. Deactivating doesn't cancel existing bookings; an admin decides that explicitly.
- **Admins can cancel anyone's booking but can't confirm on someone's behalf.** Confirming is the member's commitment.

Security notes:
- Passwords are hashed with `scrypt` (Node's built-in crypto) with a per-user salt.
- Login takes the same time and returns the same response for an unknown email as for a wrong password, so accounts can't be discovered by timing.
- JWTs expire after 1 hour.
- Someone else's booking returns `404`, not `403`, so the API doesn't reveal that it exists.

## Run it

Requires Node.js 22+ and Docker.

```bash
docker compose up -d          # PostgreSQL 16, schema applied on first start
npm install
npm test                      # 16 integration tests against the real database
```

Start the server (`JWT_SECRET` must be at least 32 characters):

```bash
JWT_SECRET="replace-with-a-long-random-string-32+" npm run dev    # PowerShell: $env:JWT_SECRET = "..."; npm run dev
```

Register through `POST /auth/register`, then promote that account to admin (the first admin has to be made by hand). After that, the admin creates resources through the API:

```bash
docker compose exec db psql -U app -d bookings -c "UPDATE users SET role = 'admin' WHERE email = 'you@example.com';"
```

> ⚠️ Tests truncate the tables. Never point `DATABASE_URL` at a database with real data.

## Project structure

```
db/schema.sql        tables, constraints (idempotent)
src/bookings.ts      hold / confirm / cancel / list, concurrency handling
src/auth.ts          password hashing, register, login, admin check
src/resources.ts     resource management, availability
src/app.ts           routes, validation (Zod), error → HTTP mapping
src/server.ts        entry point
test/api.test.ts     integration tests (concurrency, expiry, auth, ownership)
```

## Not done yet

- Rate limiting on login (needed before exposing it publicly)
- Refresh tokens and logout / token revocation
- Web frontend
- Opening hours per resource (availability returns busy ranges; free slots are computed by the client)
- Pagination and date filters on `GET /bookings`
- Versioned migrations (the schema is a single idempotent file)
- CI pipeline
