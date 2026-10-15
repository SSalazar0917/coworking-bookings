import pg from 'pg';
import { buildApp } from './app.js';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be set (at least 32 characters)');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/bookings' });
const app = buildApp(pool, jwtSecret);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
