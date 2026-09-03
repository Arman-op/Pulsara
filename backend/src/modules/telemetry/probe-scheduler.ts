import { ServiceState, type Service } from '@prisma/client';
import { MS_PER_SECOND } from '../../config/constants';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import { runProbe, type ProbeOutcome } from './probe-runner';

/**
 * Service reachability scheduler.
 *
 * Wakes on a fixed tick, selects the services whose own interval has elapsed,
 * probes them with bounded concurrency, records every result, and moves each
 * service's status through a hysteresis state machine.
 *
 * Before this existed, `Service.status` was whatever the seed script wrote and
 * never changed again — "Background Workers" was permanently DEGRADED because a
 * literal in seed.ts said so, not because anything had been observed.
 */

export type ServiceStatusChange = {
  serviceId: string;
  name: string;
  previous: ServiceState;
  current: ServiceState;
  latencyMs: number | null;
  error: string | null;
  changedAt: string;
};

/**
 * Decides the next status from the current one and the accumulated counters.
 *
 * Hysteresis matters here. Flipping on a single result would make a one-off
 * network hiccup indistinguishable from a real outage, and would page somebody
 * for both. A service must fail `SERVICE_FAILURE_THRESHOLD` times in a row to
 * be declared OFFLINE, and succeed `SERVICE_RECOVERY_THRESHOLD` times in a row
 * to be declared healthy again.
 *
 * MAINTENANCE is never entered or left automatically: it is an operator's
 * declaration that alerts are expected, and the scheduler must not override it.
 */
export function nextStatus(
  current: ServiceState,
  outcome: ProbeOutcome,
  consecutiveFailures: number,
  consecutiveSuccesses: number,
): ServiceState {
  if (current === ServiceState.MAINTENANCE) {
    return ServiceState.MAINTENANCE;
  }

  if (!outcome.ok) {
    return consecutiveFailures >= env.SERVICE_FAILURE_THRESHOLD
      ? ServiceState.OFFLINE
      : // Not yet confirmed down. Degraded is the honest reading of
        // "responding inconsistently".
        current === ServiceState.ONLINE
        ? ServiceState.DEGRADED
        : current;
  }

  if (consecutiveSuccesses < env.SERVICE_RECOVERY_THRESHOLD) {
    // Reachable again but not yet trusted; do not clear an outage on one probe.
    return current === ServiceState.OFFLINE ? ServiceState.OFFLINE : current;
  }

  /**
   * Reachable and stable. A service that answers, but slowly, is not healthy:
   * for a user, a request that takes seconds is closer to broken than to fine.
   */
  if (outcome.latencyMs !== null && outcome.latencyMs > env.SERVICE_DEGRADED_LATENCY_MS) {
    return ServiceState.DEGRADED;
  }

  return ServiceState.ONLINE;
}

/** Services whose configured interval has elapsed since their last check. */
async function findDueServices(now: Date): Promise<Service[]> {
  const candidates = await prisma.service.findMany({
    where: {
      isMonitored: true,
      probeType: { not: null },
      probeTarget: { not: null },
    },
  });

  return candidates.filter((service) => {
    if (!service.lastCheckedAt) return true;
    const dueAt = service.lastCheckedAt.getTime() + service.probeIntervalSeconds * MS_PER_SECOND;
    return now.getTime() >= dueAt;
  });
}

async function checkService(service: Service): Promise<ServiceStatusChange | null> {
  const outcome = await runProbe(service);

  const consecutiveFailures = outcome.ok ? 0 : service.consecutiveFailures + 1;
  const consecutiveSuccesses = outcome.ok ? service.consecutiveSuccesses + 1 : 0;
  const status = nextStatus(service.status, outcome, consecutiveFailures, consecutiveSuccesses);
  const checkedAt = new Date();

  /**
   * The observation and the derived state are written together. If they were
   * separate statements, a crash between them would leave a status that no
   * stored result supports.
   */
  await prisma.$transaction([
    prisma.probeResult.create({
      data: {
        serviceId: service.id,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        statusCode: outcome.statusCode,
        error: outcome.error,
        checkedAt,
      },
    }),
    prisma.service.update({
      where: { id: service.id },
      data: { status, consecutiveFailures, consecutiveSuccesses, lastCheckedAt: checkedAt },
    }),
  ]);

  if (status === service.status) return null;

  logger.info(
    { service: service.name, from: service.status, to: status, error: outcome.error },
    'Service status changed',
  );

  return {
    serviceId: service.id,
    name: service.name,
    previous: service.status,
    current: status,
    latencyMs: outcome.latencyMs,
    error: outcome.error,
    changedAt: checkedAt.toISOString(),
  };
}

/**
 * Runs tasks with a fixed ceiling on how many are in flight.
 *
 * A deployment monitoring a few hundred endpoints would otherwise open every
 * socket at once on each tick, and the resulting contention would inflate the
 * very latencies the probes are trying to measure.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item === undefined) break;
      results.push(await task(item));
    }
  });

  await Promise.all(workers);
  return results;
}

export type ProbeScheduler = { stop: () => void };

export function startProbeScheduler(
  publishStatusChange: (change: ServiceStatusChange) => void,
): ProbeScheduler {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    // Overlapping sweeps would double-probe every service and corrupt the
    // consecutive-result counters that the state machine depends on.
    if (running) return;
    running = true;

    try {
      const due = await findDueServices(new Date());
      if (due.length === 0) return;

      const changes = await mapWithConcurrency(due, env.PROBE_MAX_CONCURRENCY, async (service) => {
        try {
          return await checkService(service);
        } catch (error) {
          // One unreachable service must not abort the sweep for the others.
          logger.error({ err: error, service: service.name }, 'Probe execution failed');
          return null;
        }
      });

      for (const change of changes) {
        if (change) publishStatusChange(change);
      }
    } catch (error) {
      logger.error({ err: error }, 'Probe sweep failed');
    } finally {
      running = false;
    }
  }

  void tick();
  timer = setInterval(() => void tick(), env.PROBE_SCHEDULER_TICK_MS);

  logger.info(
    { tickMs: env.PROBE_SCHEDULER_TICK_MS, maxConcurrency: env.PROBE_MAX_CONCURRENCY },
    'Probe scheduler started',
  );

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
