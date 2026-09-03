import { ServiceState } from '@prisma/client';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { disconnectRedis } from '../../src/db/redis';
import { startProbeQueue, type ProbeQueue } from '../../src/modules/telemetry/probe-queue';
import type { ServiceStatusChange } from '../../src/modules/telemetry/probe-scheduler';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { eventually } from '../helpers/eventually';
import { testRedisUrl } from '../test-env';

/**
 * Distributed probe execution, against a real Redis and a real HTTP target.
 *
 * The reason this exists at all is that the in-process timer is correct for one
 * instance and wrong for several: every replica finds the same due services and
 * probes all of them, multiplying load on the endpoints being measured and
 * interleaving results so the consecutive-result counters stop meaning what they
 * say. What is asserted here is that the queue does the same work as the timer,
 * and that running two of them does not double it.
 */

const BUDGET_MS = 20_000;
const SLOW = 60_000;

let queues: ProbeQueue[] = [];
let inspector: Redis;

/** A service pointed at this process's own health endpoint would need a server;
 * an unroutable address is enough to exercise the full path to a stored result. */
async function createService(name: string) {
  return prisma.service.create({
    data: {
      name,
      status: ServiceState.ONLINE,
      probeType: 'HTTP',
      // Reserved for documentation, so nothing is actually contacted.
      probeTarget: 'http://192.0.2.1:9/health',
      probeIntervalSeconds: 1,
      probeTimeoutMs: 250,
      isMonitored: true,
    },
  });
}

function start(onChange: (change: ServiceStatusChange) => void = () => undefined): ProbeQueue {
  const queue = startProbeQueue(onChange);
  queues.push(queue);
  return queue;
}

beforeEach(async () => {
  await resetDatabase();
  inspector = new Redis(testRedisUrl);
  await inspector.flushdb();
});

afterEach(async () => {
  await Promise.all(queues.map((queue) => queue.stop()));
  queues = [];
  await inspector.quit().catch(() => undefined);
});

afterAll(async () => {
  await disconnectRedis();
  await disconnectDatabase();
});

describe('startProbeQueue', () => {
  it(
    'probes a due service and stores the observation',
    async () => {
      const service = await createService('Queued service');
      start();

      await eventually(
        async () => {
          const results = await prisma.probeResult.findMany({
            where: { serviceId: service.id },
          });
          expect(results.length).toBeGreaterThan(0);
          // The target is unroutable, so a real failure is the correct result.
          expect(results[0]?.ok).toBe(false);
          expect(results[0]?.error).toBeTruthy();
        },
        { timeoutMs: BUDGET_MS },
      );

      const checked = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
      expect(checked.lastCheckedAt).not.toBeNull();
      expect(checked.consecutiveFailures).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'reports a status change to the caller that ran the probe',
    async () => {
      /**
       * The realtime transport is per-instance, so the change is published by
       * whichever replica executed the check — the one holding the sockets it
       * needs to notify.
       */
      const changes: ServiceStatusChange[] = [];
      await createService('Going down');
      start((change) => changes.push(change));

      await eventually(
        () => {
          // One failure is not an outage; DEGRADED is the honest first move.
          expect(changes.map((change) => change.current)).toContain(ServiceState.DEGRADED);
        },
        { timeoutMs: BUDGET_MS },
      );
    },
    SLOW,
  );

  it(
    'does not double-probe when two instances are running',
    async () => {
      /**
       * The whole point. Two in-process schedulers would each probe every due
       * service; BullMQ keeps one schedule per key however many instances
       * register it, and the deterministic job id absorbs any sweep that still
       * manages to run twice.
       */
      const service = await createService('Probed once');

      start();
      start();

      await eventually(
        async () => {
          expect(
            await prisma.probeResult.count({ where: { serviceId: service.id } }),
          ).toBeGreaterThan(0);
        },
        { timeoutMs: BUDGET_MS },
      );

      const afterFirst = await prisma.probeResult.count({ where: { serviceId: service.id } });
      const counters = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });

      /**
       * Every stored result must be reflected in the counter. Two instances
       * probing the same service in the same tick would write two results while
       * the counter advanced once, because both read the same prior value.
       */
      expect(counters.consecutiveFailures).toBe(afterFirst);
    },
    SLOW,
  );

  it(
    'leaves an unmonitored service alone',
    async () => {
      const service = await createService('Silenced');
      await prisma.service.update({ where: { id: service.id }, data: { isMonitored: false } });

      start();

      // Long enough for several sweeps at a one-second interval.
      await new Promise((resolve) => setTimeout(resolve, 4_000));

      expect(await prisma.probeResult.count({ where: { serviceId: service.id } })).toBe(0);
    },
    SLOW,
  );

  it(
    'survives a service deleted between being enqueued and being run',
    async () => {
      const service = await createService('Fleeting');
      start();

      await prisma.service.delete({ where: { id: service.id } });

      // Nothing to assert beyond the absence of a crash: the worker treats a
      // missing service as a no-op rather than an error.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(await prisma.service.count()).toBe(0);
    },
    SLOW,
  );
});
