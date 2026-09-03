import { env, isCacheEnabled } from '../config/env';
import { cacheRedis } from '../db/redis';
import { logger } from './logger';

/**
 * Read-through cache for the two endpoints that cost real work.
 *
 * `/api/services` runs a window function over every stored probe result to
 * derive uptime and latency percentiles; `/api/deployments` joins stages onto a
 * paginated run history. Every open dashboard polls both every thirty seconds,
 * so the same expensive answer is computed once per tab per interval.
 *
 * Three rules keep this from turning into the thing the product exists to
 * argue against — a dashboard showing numbers nobody measured:
 *
 *  1. **The TTL is short**, and it only bounds staleness that nothing has told
 *     us about. It is a shock absorber for repeated polling, not storage.
 *  2. **Writes invalidate immediately.** A probe that changes a service's state,
 *     a run that lands, an operator editing the catalogue — each clears the keys
 *     it affects, so the cache is never the reason somebody sees an outage late.
 *  3. **A cache failure is a miss, never an error.** Redis being down must
 *     degrade this to the uncached behaviour, which is simply the system as it
 *     runs without Redis at all.
 *
 * Nothing user-specific is cached. Both endpoints return the same bytes to
 * every authenticated caller, which is what makes a shared key safe; caching
 * anything that varied by user without the user in the key would be a data
 * leak, so the rule is stated here rather than left to be remembered.
 */

/** Key namespaces, so an invalidation can target one resource. */
export const CacheNamespace = {
  Services: 'services',
  Deployments: 'deployments',
  /**
   * One entry per account, holding the facts `protect` checks on every request.
   * Invalidated explicitly rather than left to expire, because a revocation
   * that only takes effect after a TTL is a revocation that does not work.
   */
  Principals: 'principals',
} as const;

export type CacheNamespaceName = (typeof CacheNamespace)[keyof typeof CacheNamespace];

/**
 * Every key this module writes lives under one prefix, so a shared Redis can
 * host several deployments without either flushing the other's data.
 */
function namespacePrefix(namespace: CacheNamespaceName): string {
  return `${env.REDIS_KEY_PREFIX}:cache:${namespace}:`;
}

/**
 * Builds a key from the namespace and whatever distinguishes one response from
 * another — the query string, in practice. Two callers asking different
 * questions must not share an answer.
 *
 * Fully qualified rather than relying on ioredis's `keyPrefix`, which is
 * applied to command arguments but not to SCAN patterns; splitting the naming
 * across the two is how an invalidation ends up deleting nothing.
 */
export function cacheKey(namespace: CacheNamespaceName, discriminator: string): string {
  return `${namespacePrefix(namespace)}${discriminator}`;
}

/**
 * Returns the cached value for `key`, or computes it, stores it and returns it.
 *
 * The loader is always called on a miss or a failure, so a caller can treat
 * this as "the value", never as "the value if the cache happens to be up".
 */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const redis = isCacheEnabled ? cacheRedis() : null;
  if (!redis) return load();

  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (error) {
    logger.warn({ err: error, key }, 'Cache read failed; falling through to the database');
    return load();
  }

  const value = await load();

  try {
    await redis.set(key, JSON.stringify(value), 'EX', env.CACHE_TTL_SECONDS);
  } catch (error) {
    // The answer is already computed and correct; failing to store it costs
    // nothing but the next request.
    logger.warn({ err: error, key }, 'Cache write failed');
  }

  return value;
}

/**
 * Drops one exact key.
 *
 * Used where the caller knows precisely what changed — a single account being
 * demoted or signed out — so there is no reason to scan a namespace for it.
 */
export async function invalidateKey(key: string): Promise<void> {
  const redis = isCacheEnabled ? cacheRedis() : null;
  if (!redis) return;

  try {
    await redis.unlink(key);
  } catch (error) {
    logger.warn({ err: error, key }, 'Cache invalidation failed');
  }
}

/**
 * Drops every key in a namespace.
 *
 * Uses SCAN rather than KEYS: KEYS blocks the server for the length of the
 * scan, which on a shared Redis is somebody else's outage. The cost is that
 * invalidation is not atomic, which does not matter here — a key written
 * mid-scan is at most one TTL stale, and the write that prompted this will
 * usually be followed by another.
 */
export async function invalidate(namespace: CacheNamespaceName): Promise<void> {
  const redis = isCacheEnabled ? cacheRedis() : null;
  if (!redis) return;

  const pattern = `${namespacePrefix(namespace)}*`;

  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;

      if (keys.length > 0) {
        /**
         * `unlink` rather than `del`: reclaiming the memory happens on a
         * background thread, so invalidating a large namespace does not stall
         * the server for every other client on it.
         */
        await redis.unlink(...keys);
      }
    } while (cursor !== '0');
  } catch (error) {
    /**
     * A failed invalidation leaves values that expire on their own within the
     * TTL. Worth a warning — it means somebody may see a stale figure for a few
     * seconds — but never worth failing the write that triggered it.
     */
    logger.warn({ err: error, namespace }, 'Cache invalidation failed');
  }
}
