import { MS_PER_DAY } from '../../config/constants';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';

/**
 * Time-series retention.
 *
 * Host metrics and probe results are append-only and grow without bound: at the
 * default five-second interval, one host writes roughly a million metric rows a
 * month, and every one of them is indexed. Without a sweep the table and its
 * indexes outgrow memory, and the range scans that make the health aggregates
 * cheap stop being cheap.
 *
 * Probe results are kept longer than host metrics because they are the evidence
 * behind uptime figures and incident timelines, which are the numbers someone
 * will want to audit after the fact.
 */

/**
 * Rows deleted per statement.
 *
 * A single unbounded `DELETE` over a month of data takes a long-lived lock and
 * produces one enormous WAL transaction. Deleting in bounded batches keeps each
 * transaction short, so the sweep never blocks the collector that is still
 * writing to the same table.
 */
const DELETE_BATCH_SIZE = 10_000;

/** Guards against an unexpectedly huge backlog monopolising one sweep. */
const MAX_BATCHES_PER_SWEEP = 50;

async function deleteOlderThan(
  table: 'metric' | 'probeResult',
  column: 'recordedAt' | 'checkedAt',
  cutoff: Date,
): Promise<number> {
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
    /**
     * Prisma's `deleteMany` has no LIMIT, so the batch is expressed as a
     * subquery selecting primary keys. `ctid`-based deletion would be marginally
     * faster but is not portable and is not worth the obscurity here.
     */
    const ids =
      table === 'metric'
        ? await prisma.metric.findMany({
            where: { [column]: { lt: cutoff } },
            select: { id: true },
            take: DELETE_BATCH_SIZE,
          })
        : await prisma.probeResult.findMany({
            where: { [column]: { lt: cutoff } },
            select: { id: true },
            take: DELETE_BATCH_SIZE,
          });

    if (ids.length === 0) break;

    const keys = ids.map((row) => row.id);
    const result =
      table === 'metric'
        ? await prisma.metric.deleteMany({ where: { id: { in: keys } } })
        : await prisma.probeResult.deleteMany({ where: { id: { in: keys } } });

    deleted += result.count;
    if (ids.length < DELETE_BATCH_SIZE) break;
  }

  return deleted;
}

export async function runRetentionSweep(): Promise<{ metrics: number; probeResults: number }> {
  const metricCutoff = new Date(Date.now() - env.METRICS_RETENTION_DAYS * MS_PER_DAY);
  const probeCutoff = new Date(Date.now() - env.PROBE_RESULT_RETENTION_DAYS * MS_PER_DAY);

  const metrics = await deleteOlderThan('metric', 'recordedAt', metricCutoff);
  const probeResults = await deleteOlderThan('probeResult', 'checkedAt', probeCutoff);

  if (metrics > 0 || probeResults > 0) {
    logger.info({ metrics, probeResults }, 'Retention sweep removed expired telemetry');
  }

  return { metrics, probeResults };
}

export type RetentionJob = { stop: () => void };

export function startRetentionJob(): RetentionJob {
  const sweep = () => {
    void runRetentionSweep().catch((error: unknown) => {
      // Retention falling behind degrades performance over days; it is never a
      // reason to take the process down.
      logger.error({ err: error }, 'Retention sweep failed');
    });
  };

  const timer = setInterval(sweep, env.RETENTION_SWEEP_INTERVAL_MS);
  /**
   * The first sweep is deliberately deferred rather than run at boot. During a
   * rolling deploy every replica starts within seconds of the others, and a
   * synchronised delete storm across all of them is exactly the load spike a
   * fresh deployment does not need.
   */

  logger.info(
    {
      metricRetentionDays: env.METRICS_RETENTION_DAYS,
      probeRetentionDays: env.PROBE_RESULT_RETENTION_DAYS,
      sweepIntervalMs: env.RETENTION_SWEEP_INTERVAL_MS,
    },
    'Retention job started',
  );

  return {
    stop: () => clearInterval(timer),
  };
}
