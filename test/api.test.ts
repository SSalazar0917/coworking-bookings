// Integration tests against a real Postgres. They TRUNCATE tables: never point DATABASE_URL at real data.
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';

process.env.NODE_ENV = 'test';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/bookings' });
const app = buildApp(pool, 'test-secret-that-is-at-least-32-chars!!');

// Booking tests skip register/login (and its scrypt cost): insert the user and sign a token directly.
const user = async (name: string, role: 'member' | 'admin' = 'member') => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'unused', $2) RETURNING id`,
    [`${name}@test.dev`, role],
  );
  return app.jwt.sign({ sub: String(rows[0].id) });
};
const call = (token: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

const hour = (h: number) => new Date(Date.UTC(2030, 0, 1, h)).toISOString();
const hold = (token: string, start: number, end: number, resourceId = 1) =>
  app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { authorization: `Bearer ${token}` },
    payload: { resourceId, start: hour(start), end: hour(end) },
  });
const act = (token: string, id: number, action: 'confirm' | 'cancel') =>
  app.inject({ method: 'POST', url: `/bookings/${id}/${action}`, headers: { authorization: `Bearer ${token}` } });
const auth = (action: 'register' | 'login', email: string, password: string) =>
  app.inject({ method: 'POST', url: `/auth/${action}`, payload: { email, password } });

before(async () => {
  await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await app.ready();
});
beforeEach(async () => {
  await pool.query('TRUNCATE bookings, resources, users RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO resources (name) VALUES ('Sala A')`);
});
after(async () => {
  await app.close();
  await pool.end();
});

test('50 concurrent holds on the same slot: exactly one wins', async () => {
  const tokens = await Promise.all(Array.from({ length: 50 }, (_, i) => user(`u${i}`)));
  const results = await Promise.all(tokens.map((t) => hold(t, 10, 11)));
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 201).length, 1);
  assert.equal(codes.filter((c) => c === 409).length, 49);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM bookings`);
  assert.equal(rows[0].n, 1);
});

test('back-to-back slots do not conflict, partial overlap does', async () => {
  const [a, b, c] = await Promise.all([user('a'), user('b'), user('c')]);
  assert.equal((await hold(a, 10, 11)).statusCode, 201);
  assert.equal((await hold(b, 11, 12)).statusCode, 201);
  assert.equal((await hold(c, 10, 12)).statusCode, 409);
});

test('an expired hold no longer blocks the slot', async () => {
  const [a, b] = await Promise.all([user('a'), user('b')]);
  const first = (await hold(a, 10, 11)).json();
  await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [first.id]);
  assert.equal((await hold(b, 10, 11)).statusCode, 201);
  assert.equal((await act(a, first.id, 'confirm')).statusCode, 409);
});

test('confirm and cancel respect ownership and state', async () => {
  const [a, b, intruder] = await Promise.all([user('a'), user('b'), user('intruder')]);
  const booking = (await hold(a, 10, 11)).json();
  assert.equal((await act(intruder, booking.id, 'confirm')).statusCode, 404);
  assert.equal((await act(intruder, booking.id, 'cancel')).statusCode, 404);
  const confirmed = await act(a, booking.id, 'confirm');
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().status, 'CONFIRMED');
  assert.equal((await act(a, booking.id, 'confirm')).statusCode, 409);
  assert.equal((await act(a, booking.id, 'cancel')).statusCode, 200);
  assert.equal((await hold(b, 10, 11)).statusCode, 201, 'cancel frees the slot');
});

test('booking validation and unknown resource', async () => {
  const a = await user('a');
  assert.equal((await hold(a, 11, 10)).statusCode, 400);
  const past = await app.inject({
    method: 'POST', url: '/bookings', headers: { authorization: `Bearer ${a}` },
    payload: { resourceId: 1, start: '2000-01-01T10:00:00Z', end: '2000-01-01T11:00:00Z' },
  });
  assert.equal(past.statusCode, 400);
  assert.equal((await hold(a, 10, 11, 999)).statusCode, 404);
});

test('register then login returns a token that can book', async () => {
  const reg = await auth('register', '  Ana@Example.COM ', 'correct-horse');
  assert.equal(reg.statusCode, 201);
  assert.equal(reg.json().email, 'ana@example.com');
  assert.equal(reg.json().password_hash, undefined);

  const login = await auth('login', 'ana@example.com', 'correct-horse');
  assert.equal(login.statusCode, 200);
  assert.equal((await hold(login.json().token, 10, 11)).statusCode, 201);
});

test('register rejects duplicates (case-insensitive) and weak input', async () => {
  assert.equal((await auth('register', 'ana@example.com', 'correct-horse')).statusCode, 201);
  assert.equal((await auth('register', 'ANA@example.com', 'another-pass')).statusCode, 409);
  assert.equal((await auth('register', 'not-an-email', 'correct-horse')).statusCode, 400);
  assert.equal((await auth('register', 'b@example.com', 'short')).statusCode, 400);
});

test('login failures are indistinguishable', async () => {
  await auth('register', 'ana@example.com', 'correct-horse');
  const wrongPass = await auth('login', 'ana@example.com', 'wrong-horse');
  const noUser = await auth('login', 'nobody@example.com', 'correct-horse');
  assert.equal(wrongPass.statusCode, 401);
  assert.equal(noUser.statusCode, 401);
  assert.deepEqual(wrongPass.json(), noUser.json());
});

test('booking endpoints reject missing, forged and expired tokens', async () => {
  const noToken = await app.inject({ method: 'POST', url: '/bookings', payload: {} });
  assert.equal(noToken.statusCode, 401);
  assert.equal((await hold('not.a.jwt', 10, 11)).statusCode, 401);

  const { rows } = await pool.query(`INSERT INTO users (email, password_hash) VALUES ('x@test.dev', 'unused') RETURNING id`);
  const forged = buildApp(pool, 'a-different-secret-also-32-chars-long!!');
  await forged.ready();
  assert.equal((await hold(forged.jwt.sign({ sub: String(rows[0].id) }), 10, 11)).statusCode, 401);
  await forged.close();

  // Issued 2h ago with the 1h lifetime → already expired.
  const issuedLongAgo = { sub: String(rows[0].id), iat: Math.floor(Date.now() / 1000) - 7200 };
  assert.equal((await hold(app.jwt.sign(issuedLongAgo), 10, 11)).statusCode, 401);
});

test('malformed JSON is a 400, not a 500', async () => {
  const res = await app.inject({
    method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bad',
  });
  assert.equal(res.statusCode, 400);
});

test('only admins manage resources', async () => {
  const [member, admin] = await Promise.all([user('m'), user('admin', 'admin')]);
  assert.equal((await call(member, 'POST', '/resources', { name: 'Sala B' })).statusCode, 403);
  assert.equal((await call(member, 'PATCH', '/resources/1', { name: 'Hacked' })).statusCode, 403);

  const created = await call(admin, 'POST', '/resources', { name: '  Sala B  ' });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), { id: 2, name: 'Sala B', isActive: true });
  assert.equal((await call(admin, 'PATCH', '/resources/2', { name: 'Sala Azul' })).json().name, 'Sala Azul');
  assert.equal((await call(admin, 'PATCH', '/resources/2', {})).statusCode, 400);
  assert.equal((await call(admin, 'PATCH', '/resources/2', { role: 'x' })).statusCode, 400);
  assert.equal((await call(admin, 'PATCH', '/resources/999', { name: 'x' })).statusCode, 404);
});

test('a deactivated resource is hidden from members and cannot be booked', async () => {
  const [member, admin] = await Promise.all([user('m'), user('admin', 'admin')]);
  const existing = (await hold(member, 10, 11)).json();
  assert.equal((await call(admin, 'PATCH', '/resources/1', { isActive: false })).json().isActive, false);

  assert.equal((await hold(member, 12, 13)).statusCode, 404);
  assert.deepEqual((await call(member, 'GET', '/resources')).json(), []);
  assert.equal((await call(admin, 'GET', '/resources')).json().length, 1);
  const window = `from=${encodeURIComponent(hour(0))}&to=${encodeURIComponent(hour(23))}`;
  assert.equal((await call(member, 'GET', `/resources/1/availability?${window}`)).statusCode, 404);
  // Existing bookings survive deactivation; cancelling them is an explicit admin decision.
  assert.equal((await call(member, 'GET', '/bookings')).json()[0].id, existing.id);
});

test('availability returns live busy slots without revealing who booked', async () => {
  const [a, b, c, d] = await Promise.all([user('a'), user('b'), user('c'), user('d')]);
  const confirmed = (await hold(a, 9, 10)).json();
  await act(a, confirmed.id, 'confirm');
  await hold(b, 11, 12); // live hold
  const stale = (await hold(c, 13, 14)).json();
  await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [stale.id]);
  const cancelled = (await hold(d, 15, 16)).json();
  await act(d, cancelled.id, 'cancel');

  const q = (from: string, to: string) =>
    call(a, 'GET', `/resources/1/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const res = await q(hour(0), hour(23));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().map((s: any) => [s.start, s.end]),
    [[hour(9), hour(10)], [hour(11), hour(12)]].map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]),
  );
  assert.deepEqual(Object.keys(res.json()[0]).sort(), ['end', 'start']);

  assert.equal((await q(hour(10), hour(9))).statusCode, 400);
  assert.equal((await q('2030-01-01T00:00:00Z', '2030-03-01T00:00:00Z')).statusCode, 400);
});

test('members list their own bookings; only admins list all', async () => {
  const [a, b, admin] = await Promise.all([user('a'), user('b'), user('admin', 'admin')]);
  const mine = (await hold(a, 10, 11)).json();
  await hold(b, 12, 13);
  await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [mine.id]);

  const own = (await call(a, 'GET', '/bookings')).json();
  assert.deepEqual(own.map((x: any) => x.id), [mine.id]);
  assert.equal(own[0].status, 'EXPIRED', 'stale holds read as expired even before cleanup');
  assert.equal((await call(a, 'GET', '/bookings?scope=all')).statusCode, 403);
  assert.equal((await call(admin, 'GET', '/bookings?scope=all')).json().length, 2);
  assert.equal((await call(a, 'GET', '/bookings?scope=everything')).statusCode, 400);
});

test('admins can cancel any booking, members only their own', async () => {
  const [a, b, admin] = await Promise.all([user('a'), user('b'), user('admin', 'admin')]);
  const booking = (await hold(a, 10, 11)).json();
  assert.equal((await act(b, booking.id, 'cancel')).statusCode, 404);
  assert.equal((await act(admin, booking.id, 'confirm')).statusCode, 404, 'admins cannot confirm for others');
  const cancelled = await act(admin, booking.id, 'cancel');
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, 'CANCELLED');
  assert.equal((await act(admin, booking.id, 'cancel')).statusCode, 409);
});

test('demoting an admin takes effect immediately, even with an old token', async () => {
  const admin = await user('admin', 'admin');
  assert.equal((await call(admin, 'POST', '/resources', { name: 'X' })).statusCode, 201);
  await pool.query(`UPDATE users SET role = 'member' WHERE email = 'admin@test.dev'`);
  assert.equal((await call(admin, 'POST', '/resources', { name: 'Y' })).statusCode, 403);
});
