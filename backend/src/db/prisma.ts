import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config/env';

/**
 * A single Prisma client for the whole process.
 *
 * The previous implementation constructed `new PrismaClient()` inside each
 * controller module. Every instance opens its own connection pool, so a handful
 * of route files quietly multiplied the server's Postgres connection count and
 * would have exhausted `max_connections` under modest concurrency. One client
 * per process is the documented pattern.
 *
 * In development, `tsx watch` re-evaluates modules on every save; caching the
 * client on `globalThis` prevents each reload from leaking another pool.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
    datasources: { db: { url: env.DATABASE_URL } },
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
