-- Idempotent: safe to run on every start/test.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
    id            serial PRIMARY KEY,
    email         text NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources (
    id   serial PRIMARY KEY,
    name text NOT NULL
);

-- Added after the first release: ALTER keeps this file safe to re-run on existing databases.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin'));
-- Resources are deactivated, never deleted: bookings reference them.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS bookings (
    id              bigserial PRIMARY KEY,
    resource_id     int NOT NULL REFERENCES resources(id),
    user_id         int NOT NULL REFERENCES users(id),
    -- Always '[)' so 10:00-11:00 and 11:00-12:00 do not overlap.
    booking_range   tstzrange NOT NULL CHECK (
        NOT isempty(booking_range) AND lower_inc(booking_range) AND NOT upper_inc(booking_range)
    ),
    status          text NOT NULL DEFAULT 'HELD'
                    CHECK (status IN ('HELD', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
    hold_expires_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT held_has_expiry CHECK (status <> 'HELD' OR hold_expires_at IS NOT NULL),
    -- now() is not allowed here, so a stale HELD row still blocks until something marks it EXPIRED
    -- (the app does that inside the booking transaction, see createHold).
    CONSTRAINT no_overlapping_active_bookings EXCLUDE USING gist (
        resource_id WITH =,
        booking_range WITH &&
    ) WHERE (status IN ('HELD', 'CONFIRMED'))
);
