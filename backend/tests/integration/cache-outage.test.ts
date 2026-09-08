import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { disconnectRedis } from '../../src/db/redis';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { signedInAs, type Session } from '../helpers/factories';

/**
 * The API when Redis is configured but not answering.
 *
 * This is the property that makes the cache safe to add at all: it is an
 * optimisation on a system that works without it, so a broker being down must
 * degrade to the uncached behaviour rather than becoming an outage of its own.
 *
 * It gets its own file because it cannot be simulated by disconnecting inside a
 * test — the module reconnects on the next call, which is exactly what it
 * should do. `vi.hoisted` points the configuration at a port with nothing on it
 * before `src/config/env.ts` freezes the environment at import time.
 */
vi.hoisted(() => {
  // Reserved by IANA as unassigned, and not something a developer runs.
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  process.env.CACHE_ENABLED = 'true';
});

let admin: Session;

beforeEach(async () => {
  await resetDatabase();
  admin = await signedInAs('ADMIN');
});

afterAll(async () => {
  await disconnectRedis();
  await disconnectDatabase();
});

const as = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });

describe('with an unreachable Redis', () => {
  it('serves the service catalogue from the database', async () => {
    await prisma.service.create({
      data: { name: 'Still served', status: 'ONLINE', probeIntervalSeconds: 30 },
    });

    const listed = await request(app).get('/api/services').set(as(admin)).expect(200);

    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].name).toBe('Still served');
  });

  it('serves deployments from the database', async () => {
    await prisma.deployment.create({
      data: {
        externalId: '1',
        repo: 'pulsara/pulsara',
        branch: 'main',
        commitSha: 'a'.repeat(40),
        status: 'SUCCESS',
      },
    });

    const listed = await request(app).get('/api/deployments').set(as(admin)).expect(200);
    expect(listed.body.data).toHaveLength(1);
  });

  it('still completes a write whose invalidation cannot be delivered', async () => {
    /**
     * A failed invalidation must never fail the write that triggered it. The
     * cost of the cache being down is at most a stale read for one TTL, which
     * is a far smaller problem than refusing to register a service.
     */
    await request(app)
      .post('/api/services')
      .set(as(admin))
      .send({ name: 'Written anyway', probeType: 'HTTP', probeTarget: 'https://example.test/up' })
      .expect(201);

    expect(await prisma.service.count()).toBe(1);
  });
});
