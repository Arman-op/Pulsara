import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import {
  resetDiskCache,
  startHostCollector,
  type HostCollector,
  type HostSnapshot,
} from '../../src/modules/telemetry/host-collector';
import { latestHostSnapshot, resetHostSnapshot } from '../../src/modules/telemetry/host-state';
import { disconnectDatabase, resetDatabase } from '../helpers/database';
import { eventually } from '../helpers/eventually';

/**
 * The collector, running against the real machine.
 *
 * The point of this file is the separation of the two clocks: sampling is fast
 * because a spike lasting four seconds is still a spike, and persistence is
 * slow because writing every sample produced roughly a quarter of a million
 * rows a day per host to draw a chart that re-buckets them on read anyway.
 *
 * Nothing is mocked, so these are genuine operating-system counters — which
 * also means the cost of a read is a property of the machine, not of the code.
 * On Linux these are procfs reads; on the Windows development machine a single
 * `networkStats()` was measured at four seconds. Every assertion here is
 * therefore about shape and relationship, waited for rather than slept through.
 */

const SAMPLE_INTERVAL_MS = 10;
const PERSIST_INTERVAL_MS = 200;

/**
 * Generous, because one read can take several seconds on a slow platform and
 * some of these need two of them plus the priming read before they can assert.
 */
const BUDGET_MS = 45_000;

/** Per-test timeout, comfortably above the budget above. */
const SLOW = 90_000;

let collector: HostCollector | null = null;

function start(options: { persistIntervalMs?: number } = {}): HostCollector {
  collector = startHostCollector(() => undefined, {
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    persistIntervalMs: options.persistIntervalMs ?? PERSIST_INTERVAL_MS,
  });
  return collector;
}

beforeEach(async () => {
  await resetDatabase();
  resetHostSnapshot();
  resetDiskCache();
});

afterEach(() => {
  collector?.stop();
  collector = null;
});

afterAll(disconnectDatabase);

describe('startHostCollector', () => {
  it(
    'publishes samples live, without waiting for a write',
    async () => {
      const published: HostSnapshot[] = [];

      collector = startHostCollector((snapshot) => published.push(snapshot), {
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        // Longer than this test can possibly run: nothing is persisted, and
        // clients must still receive samples throughout.
        persistIntervalMs: 10 * BUDGET_MS,
      });

      await eventually(
        () => {
          expect(published.length).toBeGreaterThan(1);
        },
        { timeoutMs: BUDGET_MS },
      );

      expect(await prisma.metric.count()).toBe(0);
    },
    SLOW,
  );

  it(
    'records a real percentage, not a generated one',
    async () => {
      start();

      await eventually(
        async () => {
          const cpu = await prisma.metric.findFirst({ where: { type: 'cpu' } });
          expect(cpu).not.toBeNull();
          expect(cpu?.value).toBeGreaterThanOrEqual(0);
          expect(cpu?.value).toBeLessThanOrEqual(100);
          expect(cpu?.unit).toBe('percent');
          expect(cpu?.host).toBeTruthy();
        },
        { timeoutMs: BUDGET_MS },
      );

      // Memory comes from the same machine and must also be a genuine reading;
      // a real host is never at exactly zero.
      const memory = await prisma.metric.findFirstOrThrow({ where: { type: 'memory' } });
      expect(memory.value).toBeGreaterThan(0);
      expect(memory.value).toBeLessThanOrEqual(100);
    },
    SLOW,
  );

  it(
    'writes one row per family per window, however many samples it took',
    async () => {
      const published: HostSnapshot[] = [];

      collector = startHostCollector((snapshot) => published.push(snapshot), {
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        persistIntervalMs: PERSIST_INTERVAL_MS,
      });

      // Wait for a window that definitely contains more than one sample, so the
      // assertion is about aggregation rather than about a window of size one.
      await eventually(
        () => {
          expect(published.length).toBeGreaterThan(1);
        },
        { timeoutMs: BUDGET_MS },
      );

      await eventually(
        async () => {
          expect(await prisma.metric.count({ where: { type: 'cpu' } })).toBeGreaterThan(0);
        },
        { timeoutMs: BUDGET_MS },
      );

      const rows = await prisma.metric.findMany({ where: { type: 'cpu' }, orderBy: { id: 'asc' } });
      const firstWindow = rows.filter(
        (row) => row.recordedAt.getTime() === rows[0]?.recordedAt.getTime(),
      );

      expect(firstWindow).toHaveLength(1);
      expect(published.length).toBeGreaterThan(rows.length);
    },
    SLOW,
  );

  it(
    'exposes the newest sample for the scrape endpoint to read',
    async () => {
      expect(latestHostSnapshot()).toBeNull();

      start({ persistIntervalMs: 10 * BUDGET_MS });

      await eventually(
        () => {
          expect(latestHostSnapshot()).not.toBeNull();
          expect(latestHostSnapshot()?.cpu).not.toBeNull();
        },
        { timeoutMs: BUDGET_MS },
      );
    },
    SLOW,
  );

  it(
    'drains the window in progress when it stops',
    async () => {
      // Otherwise a rollout silently discards up to a full window of telemetry
      // from every replica it replaces.
      const running = start({ persistIntervalMs: 10 * BUDGET_MS });

      await eventually(
        () => {
          expect(latestHostSnapshot()).not.toBeNull();
        },
        { timeoutMs: BUDGET_MS },
      );

      expect(await prisma.metric.count()).toBe(0);

      running.stop();
      collector = null;

      await eventually(
        async () => {
          expect(await prisma.metric.count()).toBeGreaterThan(0);
        },
        { timeoutMs: BUDGET_MS },
      );
    },
    SLOW,
  );

  it(
    'stops sampling once it is stopped',
    async () => {
      const published: HostSnapshot[] = [];

      const running = startHostCollector((snapshot) => published.push(snapshot), {
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        persistIntervalMs: 10 * BUDGET_MS,
      });

      await eventually(
        () => {
          expect(published.length).toBeGreaterThan(0);
        },
        { timeoutMs: BUDGET_MS },
      );

      running.stop();
      collector = null;

      // A self-pacing loop reschedules from inside the read, so stopping has to
      // be observed by the read in flight as well as by the pending timer.
      const afterStop = published.length;
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS * 20));

      // At most the one read that was already in flight may still land.
      expect(published.length).toBeLessThanOrEqual(afterStop + 1);
    },
    SLOW,
  );
});
