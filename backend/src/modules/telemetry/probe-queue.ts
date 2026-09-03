import { Queue, Worker, type Job } from 'bullmq';
import { MS_PER_SECOND } from '../../config/constants';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { queueRedis } from '../../db/redis';
import { logger } from '../../lib/logger';
import { checkService, findDueServices, type ServiceStatusChange } from './probe-scheduler';

/**
 * Distributed probe execution.
 *
 * The in-process scheduler is correct for one instance and wrong for several:
 * every replica finds the same due services and probes all of them, so load on
 * the endpoints being measured multiplies by replica count — and the extra
 * contention inflates the very latencies the probes exist to report. It also
 * corrupts the consecutive-result counters the status state machine depends on,
 * because two replicas writing interleaved results make "three failures in a
 * row" mean something different from what it says.
 *
 * A shared queue fixes both. One repeatable job does the sweeping, whichever
 * instance happens to own it; every instance runs workers, so the probes
 * themselves spread across the fleet.
 */

const QUEUE_NAME = 'probes';

const JobName = {
  /** Finds services that are due and enqueues one check for each. */
  Sweep: 'sweep',
  /** Probes exactly one service. */
  Check: 'check',
} as const;

type CheckPayload = { serviceId: string };

/**
 * Kept small deliberately. A probe result belongs in PostgreSQL, which is
 * already the record of every observation; retaining completed jobs would make
 * Redis a second, worse copy of the same history.
 */
const KEEP_COMPLETED = 50;
const KEEP_FAILED = 200;

/**
 * A probe that fails to *execute* — as distinct from a probe that observes a
 * failure, which is a normal result — is retried twice. Beyond that the service
 * is simply due again on the next sweep, so a longer backoff would only delay
 * the same work.
 */
const JOB_ATTEMPTS = 2;

export type ProbeQueue = { stop: () => Promise<void> };

/**
 * Namespaced like the cache, so one Redis can host several deployments.
 *
 * Through BullMQ's own `prefix` rather than by decorating the queue name: `:`
 * is how BullMQ structures its keys, so it rejects a name containing one.
 */
function queuePrefix(): string {
  return `${env.REDIS_KEY_PREFIX}:queue`;
}

/**
 * Starts the queue, the repeatable sweep and the workers.
 *
 * `publishStatusChange` is invoked on the instance that ran the probe, which is
 * the one holding the WebSocket connections it needs to notify — the realtime
 * transport is per-instance, so a change detected here reaches the clients
 * attached here. Clients on other replicas see it on their next poll.
 */
export function startProbeQueue(
  publishStatusChange: (change: ServiceStatusChange) => void,
): ProbeQueue {
  const connection = queueRedis();
  const queue = new Queue(QUEUE_NAME, { connection, prefix: queuePrefix() });

  /**
   * A repeatable job rather than a timer. BullMQ keeps exactly one schedule per
   * key however many instances register it, which is what makes the sweep
   * singular across the fleet without any leader election of our own.
   */
  const scheduleSweep = async (): Promise<void> => {
    await queue.upsertJobScheduler(
      'probe-sweep',
      { every: env.PROBE_SCHEDULER_TICK_MS },
      {
        name: JobName.Sweep,
        opts: {
          removeOnComplete: KEEP_COMPLETED,
          removeOnFail: KEEP_FAILED,
        },
      },
    );
  };

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job): Promise<void> => {
      if (job.name === JobName.Sweep) {
        const due = await findDueServices(new Date());
        if (due.length === 0) return;

        await queue.addBulk(
          due.map((service) => ({
            name: JobName.Check,
            data: { serviceId: service.id } satisfies CheckPayload,
            opts: {
              /**
               * Deterministic, so a sweep that somehow runs twice — a
               * redeploy overlapping a schedule, a clock jump — enqueues one
               * check per service rather than two. Two probes landing together
               * would corrupt the consecutive-result counters.
               *
               * The service's own due time is part of the id, so the next
               * genuine interval is a different job rather than a duplicate of
               * this one.
               */
              jobId: `check:${service.id}:${service.lastCheckedAt?.getTime() ?? 0}`,
              removeOnComplete: KEEP_COMPLETED,
              removeOnFail: KEEP_FAILED,
              attempts: JOB_ATTEMPTS,
            },
          })),
        );
        return;
      }

      const { serviceId } = job.data as CheckPayload;
      const service = await prisma.service.findUnique({ where: { id: serviceId } });

      // Deleted between being enqueued and being run. Not an error.
      if (!service) return;

      const change = await checkService(service);
      if (change) publishStatusChange(change);
    },
    {
      connection,
      prefix: queuePrefix(),
      /**
       * The same ceiling the in-process scheduler applies, for the same reason:
       * a few hundred endpoints probed at once would open every socket
       * simultaneously and the contention would inflate the measurements.
       */
      concurrency: env.PROBE_MAX_CONCURRENCY,
    },
  );

  worker.on('failed', (job: Job | undefined, error: Error) => {
    // One unreachable service must not be silent, but it also must not be
    // fatal: the service is due again on the next sweep regardless.
    logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'Probe job failed');
  });

  void scheduleSweep().catch((error: unknown) => {
    logger.error({ err: error }, 'Could not register the probe sweep schedule');
  });

  logger.info(
    {
      queue: `${queuePrefix()}:${QUEUE_NAME}`,
      tickSeconds: env.PROBE_SCHEDULER_TICK_MS / MS_PER_SECOND,
      concurrency: env.PROBE_MAX_CONCURRENCY,
    },
    'Probe queue started',
  );

  return {
    stop: async () => {
      /**
       * The worker is closed before the queue so that jobs already in flight
       * finish rather than being abandoned mid-probe, which would leave a
       * service's counters describing a check that never completed.
       */
      await worker.close();
      await queue.close();
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}
