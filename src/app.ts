import fastifyJwt from '@fastify/jwt';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { checkCredentials, isAdmin, registerUser } from './auth.js';
import { DomainError, cancelBooking, confirmHold, createHold, listBookings } from './bookings.js';
import { busySlots, createResource, listResources, updateResource } from './resources.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

const createBody = z
  .object({
    resourceId: z.number().int().positive(),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .refine((b) => Date.parse(b.end) > Date.parse(b.start), { message: 'end must be after start', path: ['end'] })
  .refine((b) => Date.parse(b.start) > Date.now(), { message: 'start must be in the future', path: ['start'] });

const idParams = z.object({ id: z.coerce.number().int().positive() });

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // Upper bound keeps scrypt cost per request bounded.
  password: z.string().min(8).max(128),
});

const resourceName = z.string().trim().min(1).max(100);
const resourceBody = z.object({ name: resourceName });
const resourcePatch = z
  .object({ name: resourceName.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((p) => p.name !== undefined || p.isActive !== undefined, { message: 'Nothing to update' });

const MAX_WINDOW_MS = 31 * 24 * 3600 * 1000;
const availabilityQuery = z
  .object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
  .refine((q) => Date.parse(q.to) > Date.parse(q.from), { message: 'to must be after from', path: ['to'] })
  // Bounds the query cost; a calendar never needs more than a month at once.
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= MAX_WINDOW_MS, { message: 'window is at most 31 days' });

const bookingsQuery = z.object({ scope: z.enum(['mine', 'all']).default('mine') });

const forbidden = () => new DomainError(403, 'FORBIDDEN', 'Admin role required');

export function buildApp(pool: Pool, jwtSecret: string) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.register(fastifyJwt, { secret: jwtSecret, sign: { expiresIn: '1h' } });

  app.setErrorHandler<FastifyError>((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', issues: err.issues });
    }
    if (err instanceof DomainError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    // Fastify's own client errors (malformed JSON, wrong content-type) keep their 4xx.
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'INTERNAL_ERROR' });
  });

  async function currentUserId(req: FastifyRequest) {
    try {
      await req.jwtVerify();
    } catch {
      throw new DomainError(401, 'UNAUTHORIZED', 'Missing, invalid or expired token');
    }
    return Number(req.user.sub);
  }

  async function requireAdmin(req: FastifyRequest) {
    const userId = await currentUserId(req);
    if (!(await isAdmin(pool, userId))) throw forbidden();
    return userId;
  }

  app.post('/auth/register', async (req, reply) => {
    const { email, password } = credentials.parse(req.body);
    return reply.status(201).send(await registerUser(pool, email, password));
  });

  app.post('/auth/login', async (req) => {
    const { email, password } = credentials.parse(req.body);
    const userId = await checkCredentials(pool, email, password);
    return { token: app.jwt.sign({ sub: String(userId) }) };
  });

  app.post('/bookings', async (req, reply) => {
    const userId = await currentUserId(req);
    const body = createBody.parse(req.body);
    return reply.status(201).send(await createHold(pool, { ...body, userId }));
  });

  app.post('/bookings/:id/confirm', async (req) => {
    const userId = await currentUserId(req);
    return confirmHold(pool, idParams.parse(req.params).id, userId);
  });

  app.post('/bookings/:id/cancel', async (req) => {
    const userId = await currentUserId(req);
    return cancelBooking(pool, idParams.parse(req.params).id, userId, await isAdmin(pool, userId));
  });

  app.get('/bookings', async (req) => {
    const userId = await currentUserId(req);
    const { scope } = bookingsQuery.parse(req.query);
    if (scope === 'all' && !(await isAdmin(pool, userId))) throw forbidden();
    return listBookings(pool, scope === 'all' ? null : userId);
  });

  app.get('/resources', async (req) => {
    const userId = await currentUserId(req);
    return listResources(pool, await isAdmin(pool, userId));
  });

  app.get('/resources/:id/availability', async (req) => {
    await currentUserId(req);
    const { from, to } = availabilityQuery.parse(req.query);
    return busySlots(pool, idParams.parse(req.params).id, from, to);
  });

  app.post('/resources', async (req, reply) => {
    await requireAdmin(req);
    return reply.status(201).send(await createResource(pool, resourceBody.parse(req.body).name));
  });

  app.patch('/resources/:id', async (req) => {
    await requireAdmin(req);
    return updateResource(pool, idParams.parse(req.params).id, resourcePatch.parse(req.body));
  });

  return app;
}
