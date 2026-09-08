import { Severity } from '@prisma/client';
import { MS_PER_SECOND } from '../../config/constants';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import type { HostSnapshot } from '../telemetry/host-collector';
import { openOrEscalateIncident, resolveAutomatedIncident } from './incident-store';

/**
 * Alerting from host resource pressure.
 *
 * The second source of real incidents. Service probing answers "can I reach
 * it"; this answers "is the machine underneath in trouble", which is the
 * question that gets asked first when a service is technically up and behaving
 * badly.
 *
 * Every incident it opens is backed by a sampled operating-system counter. The
 * thresholds are configuration, not literals, because "90% CPU" means something
 * different on a batch worker than on a request path.
 */

/** A metric this engine watches, and the threshold that applies to it. */
type WatchedMetric = {
  key: string;
  label: string;
  /** Reads the value out of a sample; null means the family was not measured. */
  read: (snapshot: HostSnapshot) => number | null;
  threshold: number;
};

/**
 * Only the saturation metrics are watched.
 *
 * Network throughput is deliberately absent: high throughput is what a healthy
 * system under load looks like, and there is no universal number above which it
 * is wrong. Load average is absent for a related reason — it is already implied
 * by CPU here, and it does not exist on every platform this runs on.
 */
function watchedMetrics(): WatchedMetric[] {
  return [
    {
      key: 'cpu',
      label: 'CPU',
      read: (snapshot) => snapshot.cpu,
      threshold: env.CPU_ALERT_THRESHOLD_PERCENT,
    },
    {
      key: 'memory',
      label: 'Memory',
      read: (snapshot) => snapshot.memory,
      threshold: env.MEMORY_ALERT_THRESHOLD_PERCENT,
    },
    {
      key: 'disk',
      label: 'Disk',
      read: (snapshot) => snapshot.disk,
      threshold: env.DISK_ALERT_THRESHOLD_PERCENT,
    },
  ];
}

function dedupeKeyFor(metricKey: string, host: string): string {
  return `host-resource:${metricKey}:${host}`;
}

/**
 * Severity from how far past the line the value is.
 *
 * Two bands rather than a gradient: an engineer acts on "look at this soon" and
 * "look at this now", and a five-level scale computed from a percentage would
 * imply a precision the measurement does not have.
 */
function severityFor(value: number): Severity {
  return value >= env.HOST_ALERT_CRITICAL_PERCENT ? Severity.CRITICAL : Severity.HIGH;
}

/**
 * Consecutive-sample counters, exactly as the probe scheduler keeps for
 * services.
 *
 * A single sample above the line is a garbage-collection pause, a backup
 * starting, or a build running — not an incident. Alerting on one is how an
 * alerting system gets muted, and a muted alerting system is worse than none
 * because it is still believed.
 */
type Streak = { breaching: number; clear: number };

const streaks = new Map<string, Streak>();

function streakFor(key: string): Streak {
  const existing = streaks.get(key);
  if (existing) return existing;

  const created: Streak = { breaching: 0, clear: 0 };
  streaks.set(key, created);
  return created;
}

/** Test seam. A running process has exactly one collector feeding this. */
export function resetHostAlertState(): void {
  streaks.clear();
}

function describe(metric: WatchedMetric, value: number, host: string): string {
  return `${metric.label} on ${host} is at ${value.toFixed(1)}%, at or above the ${metric.threshold}% threshold`;
}

async function evaluateMetric(metric: WatchedMetric, snapshot: HostSnapshot): Promise<void> {
  const value = metric.read(snapshot);

  /**
   * A family that was not measured is not a reading of zero. Treating a missing
   * disk figure as 0% would silently clear a real incident, which is the
   * failure mode this whole codebase exists to avoid.
   */
  if (value === null) return;

  const dedupeKey = dedupeKeyFor(metric.key, snapshot.host);
  const streak = streakFor(dedupeKey);

  if (value >= metric.threshold) {
    streak.breaching += 1;
    streak.clear = 0;

    if (streak.breaching < env.HOST_ALERT_SUSTAINED_SAMPLES) return;

    await openOrEscalateIncident({
      dedupeKey,
      title: `${metric.label} pressure on ${snapshot.host}`,
      description: describe(metric, value, snapshot.host),
      severity: severityFor(value),
      subject: `${metric.label}@${snapshot.host}`,
    });
    return;
  }

  streak.clear += 1;
  streak.breaching = 0;

  if (streak.clear < env.HOST_ALERT_RECOVERY_SAMPLES) return;

  await resolveAutomatedIncident(
    dedupeKey,
    `${metric.label}@${snapshot.host}`,
    (openDurationMs) =>
      `${metric.label} on ${snapshot.host} returned to ${value.toFixed(1)}%, below the ${metric.threshold}% threshold, after ${Math.round(openDurationMs / MS_PER_SECOND)}s`,
  );
}

/**
 * Evaluates one sample against every threshold.
 *
 * Called by the collector for every sample, not for every persisted window:
 * persistence stores windowed means, and a mean is exactly the thing that hides
 * a spike. Failures are logged rather than propagated — an alerting problem
 * must never stop the monitoring that feeds it.
 */
export async function evaluateHostSample(snapshot: HostSnapshot): Promise<void> {
  if (!env.HOST_ALERTS_ENABLED) return;

  for (const metric of watchedMetrics()) {
    try {
      await evaluateMetric(metric, snapshot);
    } catch (error) {
      logger.error(
        { err: error, metric: metric.key, host: snapshot.host },
        'Host alert evaluation failed',
      );
    }
  }
}
