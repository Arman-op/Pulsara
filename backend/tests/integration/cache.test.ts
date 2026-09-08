import { ServiceState } from '@prisma/client';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import { CacheNamespace, cacheKey, cached, invalidate } from '../../src/lib/cache';
import { prisma } from '../../src/db/prisma';
import { disconnectRedis } from '../../src/db/redis';
import { checkService } from '../../src/modules/telemetry/probe-scheduler';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { signedInAs, type Session } from '../helpers/factories';
import { testRedisUrl } from '../test-env';

/**
 * The read cache, against a real Redis.
 *
 * What is worth asserting is not that caching happens — that is easy and
 * uninteresting — but that it can never be the reason somebody sees a stale
 * figure for longer than they should. Every write invalidates, a failure is a
 * miss rather than an error, and two different questions never share an answer.
 */

let admin: Session;
let inspector: Redis;

beforeEach(async () => {
  await resetDatabase();

  inspector = new Redis(testRedisUrl);
  await inspector.flushdb();

  admin = await signedInAs('ADMIN');
});

afterAll(async () => {
  await inspector.quit().catch(() => undefined);
  await disconnectRedis();
  await disconnectDatabase();
});

const as = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });

/** Counts the live keys in one namespace, prefix included. */
async function keyCount(namespace: string): Promise<number> {
  const keys = await inspector.keys(`pulsara-test:cache:${namespace}:*`);
  return keys.length;
}

describe('cached', () => {
  it('computes once and serves the stored value afterwards', async () => {
    const load = vi.fn(() => Promise.resolve({ value: 1 }));
    const key = cacheKey(CacheNamespace.Services, 'unit');

    expect(await cached(key, load)).toEqual({ value: 1 });
    expect(await cached(key, load)).toEqual({ value: 1 });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps different questions apart', async () => {
    // Sharing one key across filters would serve one caller another's answer.
    await cached(cacheKey(CacheNamespace.Deployments, 'a'), () => Promise.resolve('first'));
    const second = await cached(cacheKey(CacheNamespace.Deployments, 'b'), () =>
      Promise.resolve('second'),
    );

    expect(second).toBe('second');
  });

  it('propagates a loader failure rather than caching it', async () => {
    const key = cacheKey(CacheNamespace.Services, 'failing');
    await expect(cached(key, () => Promise.reject(new Error('database down')))).rejects.toThrow(
      'database down',
    );

    // The next attempt must run the loader again, not replay the rejection.
    expect(await cached(key, () => Promise.resolve('recovered'))).toBe('recovered');
  });
});

describe('invalidate', () => {
  it('clears its own namespace and leaves the others alone', async () => {
    await cached(cacheKey(CacheNamespace.Services, 'list'), () => Promise.resolve(['a']));
    await cached(cacheKey(CacheNamespace.Deployments, 'list'), () => Promise.resolve(['b']));

    await invalidate(CacheNamespace.Services);

    expect(await keyCount(CacheNamespace.Services)).toBe(0);
    expect(await keyCount(CacheNamespace.Deployments)).toBe(1);
  });
});

describe('GET /api/services', () => {
  it('serves a second identical request from the cache', async () => {
    await prisma.service.create({
      data: { name: 'Cached service', status: 'ONLINE', probeIntervalSeconds: 30 },
    });

    await request(app).get('/api/services').set(as(admin)).expect(200);
    expect(await keyCount(CacheNamespace.Services)).toBe(1);

    const second = await request(app).get('/api/services').set(as(admin)).expect(200);
    expect(second.body.data).toHaveLength(1);
  });

  it('shows a newly registered service at once, not after the TTL', async () => {
    await request(app).get('/api/services').set(as(admin)).expect(200);

    await request(app)
      .post('/api/services')
      .set(as(admin))
      .send({
        name: 'Brand new',
        probeType: 'HTTP',
        probeTarget: 'https://example.test/health',
      })
      .expect(201);

    const listed = await request(app).get('/api/services').set(as(admin)).expect(200);
    expect(listed.body.data.map((service: { name: string }) => service.name)).toContain(
      'Brand new',
    );
  });

  it('reflects a deletion immediately', async () => {
    const service = await prisma.service.create({
      data: { name: 'Doomed', status: 'ONLINE', probeIntervalSeconds: 30 },
    });

    await request(app).get('/api/services').set(as(admin)).expect(200);
    await request(app).delete(`/api/services/${service.id}`).set(as(admin)).expect(200);

    const listed = await request(app).get('/api/services').set(as(admin)).expect(200);
    expect(listed.body.data).toHaveLength(0);
  });

  it('reflects an edit immediately', async () => {
    const service = await prisma.service.create({
      data: { name: 'Before', status: 'ONLINE', probeIntervalSeconds: 30 },
    });

    await request(app).get('/api/services').set(as(admin)).expect(200);
    await request(app)
      .patch(`/api/services/${service.id}`)
      .set(as(admin))
      .send({ name: 'After' })
      .expect(200);

    const listed = await request(app).get('/api/services').set(as(admin)).expect(200);
    expect(listed.body.data[0].name).toBe('After');
  });
});

describe('probe results', () => {
  it('does not clear the cache for an observation that changes nothing', async () => {
    /**
     * Observing is the common case: a healthy fleet produces a result per
     * service per interval and changes nothing. Clearing on each one left the
     * cache empty within seconds of being filled — a cache with no hit rate is
     * complexity bought with nothing.
     */
    const service = await prisma.service.create({
      data: {
        name: 'Steady',
        status: ServiceState.ONLINE,
        probeType: 'HTTP',
        probeTarget: 'http://192.0.2.1:9/health',
        probeIntervalSeconds: 1,
        probeTimeoutMs: 100,
        consecutiveSuccesses: 5,
      },
    });

    await request(app).get('/api/services').set(as(admin)).expect(200);
    expect(await keyCount(CacheNamespace.Services)).toBe(1);

    // A failing probe against an ONLINE service moves it to DEGRADED, so force
    // the no-change case by leaving it already DEGRADED.
    await prisma.service.update({
      where: { id: service.id },
      data: { status: ServiceState.DEGRADED, consecutiveFailures: 1 },
    });
    await request(app).get('/api/services').set(as(admin)).expect(200);

    const before = await keyCount(CacheNamespace.Services);
    const unchanged = await checkService(
      await prisma.service.findUniqueOrThrow({ where: { id: service.id } }),
    );

    expect(unchanged).toBeNull();
    expect(await keyCount(CacheNamespace.Services)).toBe(before);
  });

  it('clears the cache the moment a service changes state', async () => {
    // Whether a service is up is the one figure that must never be late.
    const service = await prisma.service.create({
      data: {
        name: 'About to fall over',
        status: ServiceState.ONLINE,
        probeType: 'HTTP',
        probeTarget: 'http://192.0.2.1:9/health',
        probeIntervalSeconds: 1,
        probeTimeoutMs: 100,
      },
    });

    await request(app).get('/api/services').set(as(admin)).expect(200);
    expect(await keyCount(CacheNamespace.Services)).toBe(1);

    const change = await checkService(
      await prisma.service.findUniqueOrThrow({ where: { id: service.id } }),
    );

    expect(change?.current).toBe(ServiceState.DEGRADED);
    expect(await keyCount(CacheNamespace.Services)).toBe(0);
  });
});

describe('GET /api/deployments', () => {
  it('caches each filter separately', async () => {
    await request(app).get('/api/deployments').set(as(admin)).expect(200);
    await request(app).get('/api/deployments?status=SUCCESS').set(as(admin)).expect(200);

    // Two distinct questions, two distinct entries.
    expect(await keyCount(CacheNamespace.Deployments)).toBe(2);
  });

  it('does not serve one page in answer to another', async () => {
    await prisma.deployment.createMany({
      data: [1, 2, 3].map((n) => ({
        externalId: String(n),
        repo: 'pulsara/pulsara',
        branch: 'main',
        commitSha: 'a'.repeat(40),
        status: 'SUCCESS' as const,
      })),
    });

    const first = await request(app).get('/api/deployments?limit=2').set(as(admin)).expect(200);
    const second = await request(app)
      .get('/api/deployments?limit=2&offset=2')
      .set(as(admin))
      .expect(200);

    expect(first.body.data).toHaveLength(2);
    expect(second.body.data).toHaveLength(1);
  });
});
