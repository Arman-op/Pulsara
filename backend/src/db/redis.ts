import { Redis } from 'ioredis';
import { env, isRedisConfigured } from '../config/env';
import { logger } from '../lib/logger';

/**
 * The Redis connection, when one is configured.
 *
 * Redis is optional, and the system is fully functional without it: probes run
 * on an in-process timer and reads go straight to PostgreSQL. That is
 * deliberate. Requiring a broker to run the application locally is a real cost
 * paid by everyone who clones the repository, and the two things Redis buys
 * here — a shared probe queue and a read cache — are both improvements on a
 * working baseline rather than prerequisites for one.
 *
 * What it must never become is a silent dependency: if `REDIS_URL` is set and
 * Redis is unreachable, that is a configuration error and it is logged as one,
 * not quietly degraded past.
 */

let client: Redis | null = null;

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection its workers
 * block on, because a blocking read legitimately outlives the default retry
 * budget. Sharing one connection across the cache and the queue would therefore
 * force that setting on the cache too, where it is wrong: a cache read should
 * fail fast and fall through to the database, not hang.
 */
export type RedisPurpose = 'cache' | 'queue';

function connect(purpose: RedisPurpose): Redis {
  if (!env.REDIS_URL) {
    throw new Error('Redis is not configured');
  }

  const connection = new Redis(env.REDIS_URL, {
    /**
     * No `keyPrefix`. ioredis applies it to the key arguments of commands it
     * recognises but not to the pattern SCAN matches against, so a prefixed
     * connection means keys are written with the prefix, scanned for with a
     * pattern that has to repeat it by hand, and then deleted with the prefix
     * applied a second time — an invalidation that silently deletes nothing.
     *
     * `cacheKey` builds the fully-qualified name instead, so the one place that
     * decides what a key is called is the one place that says so.
     */
    maxRetriesPerRequest: purpose === 'queue' ? null : 1,
    enableReadyCheck: true,
    /**
     * Bounded, so a cache lookup cannot become the slowest part of a request.
     * The caller treats a failure as a miss.
     */
    connectTimeout: 5_000,
    lazyConnect: false,
  });

  connection.on('error', (error: Error) => {
    // ioredis reconnects on its own; logging every attempt would drown the log,
    // so this is the one line that says the dependency is unhappy.
    logger.error({ err: error, purpose }, 'Redis connection error');
  });

  return connection;
}

/** The shared cache connection. Created on first use. */
export function cacheRedis(): Redis | null {
  if (!isRedisConfigured) return null;
  client ??= connect('cache');
  return client;
}

/**
 * A dedicated connection for BullMQ.
 *
 * BullMQ takes ownership of the connections it is given — workers block on
 * them — so it gets its own rather than sharing the cache's.
 */
export function queueRedis(): Redis {
  return connect('queue');
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => client?.disconnect());
  client = null;
}
