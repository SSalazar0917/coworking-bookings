import fastifyJwt from '@fastify/jwt';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { checkCredentials, registerUser } from './auth.js';
import { DomainError, cancelBooking, confirmHold, createHold } from './bookings.js';

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
    return cancelBooking(pool, idParams.parse(req.params).id, userId);
  });

  return app;
}
