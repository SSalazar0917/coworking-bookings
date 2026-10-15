import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { DomainError } from './bookings.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':').map((h) => Buffer.from(h, 'hex'));
  return timingSafeEqual(hash, await scryptAsync(password, salt, 64));
}

// Hashed once so unknown emails cost the same as wrong passwords (no user enumeration by timing).
const DUMMY_HASH = hashPassword('dummy-password');

export async function registerUser(pool: Pool, email: string, password: string) {
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, await hashPassword(password)],
    );
    return rows[0] as { id: number; email: string };
  } catch (err: any) {
    if (err.code === '23505') throw new DomainError(409, 'EMAIL_TAKEN', 'Email is already registered');
    throw err;
  }
}

export async function checkCredentials(pool: Pool, email: string, password: string) {
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? (await DUMMY_HASH));
  if (!rows[0] || !ok) throw new DomainError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  return rows[0].id as number;
}
