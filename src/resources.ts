import type { Pool } from 'pg';
import { DomainError } from './bookings.js';

const COLUMNS = `id, name, is_active AS "isActive"`;

export async function listResources(pool: Pool, includeInactive: boolean) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM resources WHERE is_active OR $1 ORDER BY name`, [
    includeInactive,
  ]);
  return rows;
}

export async function createResource(pool: Pool, name: string) {
  const { rows } = await pool.query(`INSERT INTO resources (name) VALUES ($1) RETURNING ${COLUMNS}`, [name]);
  return rows[0];
}

export async function updateResource(pool: Pool, id: number, changes: { name?: string; isActive?: boolean }) {
  // Deactivating leaves existing bookings untouched; admins cancel them explicitly if needed.
  const { rows } = await pool.query(
    `UPDATE resources SET name = COALESCE($2, name), is_active = COALESCE($3, is_active)
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, changes.name ?? null, changes.isActive ?? null],
  );
  if (!rows[0]) throw new DomainError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
  return rows[0];
}

// Busy intervals only: who booked is not shown to other members.
export async function busySlots(pool: Pool, resourceId: number, from: string, to: string) {
  const exists = await pool.query('SELECT 1 FROM resources WHERE id = $1 AND is_active', [resourceId]);
  if (!exists.rows[0]) throw new DomainError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
  const { rows } = await pool.query(
    `SELECT lower(booking_range) AS "start", upper(booking_range) AS "end"
       FROM bookings
      WHERE resource_id = $1 AND booking_range && tstzrange($2, $3, '[)')
        AND (status = 'CONFIRMED' OR (status = 'HELD' AND hold_expires_at > now()))
      ORDER BY lower(booking_range)`,
    [resourceId, from, to],
  );
  return rows;
}
