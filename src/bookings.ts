import type { Pool } from 'pg';

export const HOLD_MINUTES = 10;

export class DomainError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

const COLUMNS = `id, resource_id AS "resourceId", user_id AS "userId", status,
  lower(booking_range) AS "start", upper(booking_range) AS "end", hold_expires_at AS "holdExpiresAt"`;

export async function createHold(
  pool: Pool,
  input: { resourceId: number; userId: number; start: string; end: string },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Queue writers per resource. Without this, concurrent inserts each see the other's uncommitted
    // row in the exclusion check, wait on each other and Postgres aborts them with deadlocks (40P01)
    // instead of a clean 23P01. The constraint still guarantees integrity; this only orders contenders.
    const resource = await client.query('SELECT 1 FROM resources WHERE id = $1 FOR NO KEY UPDATE', [input.resourceId]);
    if (!resource.rows[0]) throw new DomainError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    // Free stale holds on this slot first; the exclusion constraint cannot look at now().
    await client.query(
      `UPDATE bookings SET status = 'EXPIRED'
        WHERE resource_id = $1 AND status = 'HELD' AND hold_expires_at <= now()
          AND booking_range && tstzrange($2, $3, '[)')`,
      [input.resourceId, input.start, input.end],
    );
    // No SELECT-then-INSERT: the constraint is the only arbiter, so concurrent requests cannot both win.
    const { rows } = await client.query(
      `INSERT INTO bookings (resource_id, user_id, booking_range, hold_expires_at)
       VALUES ($1, $2, tstzrange($3, $4, '[)'), now() + make_interval(mins => $5))
       RETURNING ${COLUMNS}`,
      [input.resourceId, input.userId, input.start, input.end, HOLD_MINUTES],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') throw new DomainError(409, 'SLOT_TAKEN', 'The resource is already booked for that time');
    if (err.code === '23503') throw new DomainError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    throw err;
  } finally {
    client.release();
  }
}

export async function confirmHold(pool: Pool, id: number, userId: number) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'CONFIRMED', hold_expires_at = NULL
      WHERE id = $1 AND user_id = $2 AND status = 'HELD' AND hold_expires_at > now()
      RETURNING ${COLUMNS}`,
    [id, userId],
  );
  if (rows[0]) return rows[0];
  throw await explainMiss(pool, id, userId, 'Only an unexpired HELD booking can be confirmed');
}

export async function cancelBooking(pool: Pool, id: number, userId: number) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'CANCELLED', hold_expires_at = NULL
      WHERE id = $1 AND user_id = $2 AND status IN ('HELD', 'CONFIRMED')
      RETURNING ${COLUMNS}`,
    [id, userId],
  );
  if (rows[0]) return rows[0];
  throw await explainMiss(pool, id, userId, 'Booking is not active');
}

// Turns a 0-row UPDATE into 404 (missing or someone else's) vs 409 (wrong state).
async function explainMiss(pool: Pool, id: number, userId: number, conflictMsg: string) {
  const { rows } = await pool.query('SELECT 1 FROM bookings WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0]
    ? new DomainError(409, 'INVALID_STATE', conflictMsg)
    : new DomainError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
}
